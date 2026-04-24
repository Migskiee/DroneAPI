import os
import cv2
import numpy as np
import threading
import time
import psycopg2
import cloudinary
import cloudinary.uploader
import requests
import uvicorn
import io
import zipfile
import glob
from datetime import datetime
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, Response, FileResponse
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel 
from ultralytics import YOLO
from fastapi.middleware.cors import CORSMiddleware

# ==========================================
# CONFIGURATION
# ==========================================
cloudinary.config(
    cloud_name=os.getenv("CLOUD_NAME", "ddrtobc93"),
    api_key=os.getenv("CD_API_KEY", "862952687477775"),
    api_secret=os.getenv("CD_API_SECRET", "XO4y0v4R6-O9x76LwkhQ93T6qss")
)

RAILWAY_DB_URL = "postgresql://postgres:huXFgxfRwaSChMeTWJdNjZiCnZUkxIve@interchange.proxy.rlwy.net:21621/railway"

TEMP_DIR = "temp_mission_frames"
os.makedirs(TEMP_DIR, exist_ok=True)

try:
    conn = psycopg2.connect(RAILWAY_DB_URL)
    cursor = conn.cursor()
    cursor.execute("ALTER TABLE bridges ADD COLUMN IF NOT EXISTS remarks TEXT;")
    cursor.execute("ALTER TABLE bridges ADD COLUMN IF NOT EXISTS span_count INTEGER DEFAULT 1;")
    cursor.execute("ALTER TABLE captured_images ADD COLUMN IF NOT EXISTS defect_size VARCHAR(50) DEFAULT 'N/A';")
    cursor.execute("ALTER TABLE captured_images ADD COLUMN IF NOT EXISTS confidence_score VARCHAR(20) DEFAULT 'N/A';")
    cursor.execute("ALTER TABLE captured_images ADD COLUMN IF NOT EXISTS raw_image_url TEXT;")
    cursor.execute("ALTER TABLE captured_images ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;")
    cursor.execute("ALTER TABLE captured_images ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;")
    cursor.execute("ALTER TABLE captured_images ADD COLUMN IF NOT EXISTS custom_attribute TEXT DEFAULT '';")
    
    # Active Learning Columns
    cursor.execute("ALTER TABLE captured_images ADD COLUMN IF NOT EXISTS requires_retraining BOOLEAN DEFAULT FALSE;")
    cursor.execute("ALTER TABLE captured_images ADD COLUMN IF NOT EXISTS yolo_annotation TEXT DEFAULT '';")
    
    cursor.execute("UPDATE captured_images SET raw_image_url = image_url WHERE raw_image_url IS NULL AND defect_type = 'Raw Image';")
    conn.commit()
    cursor.close()
    conn.close()
except Exception as e:
    print(f"Migration note: {e}")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  
    allow_credentials=True,
    allow_methods=["*"],  
    allow_headers=["*"],  
)

class SeverityUpdate(BaseModel): severity: str
class RemarkUpdate(BaseModel): remarks: str
class SpanUpdateParams(BaseModel): span_target: str
class BridgeCreateUpdate(BaseModel): bridge_code: str; name: str; location: str; remarks: str; span_count: int
class BulkDeleteParams(BaseModel): image_ids: list[int]
class AttributeUpdate(BaseModel): custom_attribute: str
class AnnotationUpdate(BaseModel): yolo_annotation: str

class MissionStartParams(BaseModel): 
    bridge_id: int
    span_target: str
    capture_mode: str = "auto" 

class AnalyzeParams(BaseModel): 
    mission_id: int
    conf_threshold: float = 0.5
    img_size: int = 640

# ==========================================
# CLOUD AI & LIVE STREAMING STATE
# ==========================================
active_model_name = "Unknown"

try:
    available_models = glob.glob('AIModel/*.pt')
    if available_models:
        available_models.sort(reverse=True)
        latest_model = available_models[0]
        active_model_name = os.path.basename(latest_model)
        print(f"🔄 Auto-detecting AI... Loading newest weights: {latest_model}")
        model = YOLO(latest_model)
        print("✅ YOLO Model Loaded Successfully!")
    else:
        active_model_name = "AIModelFinalV4.pt"
        model = YOLO(f'AIModel/{active_model_name}')
except Exception as e:
    print(f"⚠️ Warning: YOLO Model failed to load. {e}")
    model = None
    active_model_name = "Error loading model"

flight_state = {
    "is_active": False,
    "mission_id": None,
    "bridge_id": None,
    "span_target": "Span 1",
    "capture_mode": "auto",
    "manual_trigger": False,
    "latest_raw_frame": None,
    "mission_progress": {} 
}
state_lock = threading.Lock()

def assess_defect_severity(defect_type, w_mm, h_mm):
    dt = defect_type.lower()
    max_dim = max(w_mm, h_mm)
    min_dim = min(w_mm, h_mm) 
    if "crack" in dt: return "Bad" if min_dim > 1.0 else "Poor" if min_dim > 0.3 else "Fair"
    elif "flaking" in dt: return "Bad" if max_dim > 600 else "Poor" if max_dim > 300 else "Fair"
    elif "chipping" in dt: return "Bad" if max_dim > 300 else "Poor" if max_dim > 150 else "Fair"
    elif "rebar" in dt: return "Bad" if max_dim >= 200 else "Poor"
    elif "water" in dt or "infiltration" in dt: return "Bad" if max_dim >= 300 else "Poor"
    return "Fair"

def upload_raw_worker(mission_id, span_target):
    try:
        files = sorted([f for f in os.listdir(TEMP_DIR) if f.startswith(f"mission_{mission_id}")])
        total_files = len(files)
        with state_lock: flight_state["mission_progress"][mission_id] = {"total": total_files, "processed": 0}
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        for file in files:
            filepath = os.path.join(TEMP_DIR, file)
            try:
                parts = file.replace('.jpg', '').split('_')
                lat_val = float(parts[3]); lon_val = float(parts[4])
            except:
                lat_val = 0.0; lon_val = 0.0
            try:
                upload_result = cloudinary.uploader.upload(filepath, folder="bridge_raw_captures")
                secure_url = upload_result['secure_url']
                cursor.execute("""
                    INSERT INTO captured_images (mission_id, span_target, image_url, defect_type, severity_level, defect_size, confidence_score, raw_image_url, latitude, longitude, custom_attribute)
                    VALUES (%s, %s, %s, 'Raw Image', 'Pending', 'N/A', 'N/A', %s, %s, %s, '')
                """, (mission_id, span_target, secure_url, secure_url, lat_val, lon_val))
                conn.commit()
            except Exception as e: print(f"❌ Upload failed: {e}")
            finally:
                if os.path.exists(filepath): os.remove(filepath)
            with state_lock: flight_state["mission_progress"][mission_id]["processed"] += 1
        cursor.execute("UPDATE inspection_missions SET status = 'Awaiting Analysis' WHERE id = %s", (mission_id,))
        conn.commit(); cursor.close(); conn.close()
    except Exception as e: print(f"❌ Raw Upload Crash: {e}")
    finally:
        with state_lock:
            if mission_id in flight_state["mission_progress"]: del flight_state["mission_progress"][mission_id]

def analyze_mission_worker(mission_id, conf_threshold=0.5, img_size=640):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("SELECT id, COALESCE(raw_image_url, image_url), span_target FROM captured_images WHERE mission_id = %s", (mission_id,))
        raw_images = cursor.fetchall()
        with state_lock: flight_state["mission_progress"][mission_id] = {"total": len(raw_images), "processed": 0}
        MM_PER_PIXEL = 0.2
        for img_id, image_url, span_target in raw_images:
            try:
                resp = requests.get(image_url)
                image_array = np.asarray(bytearray(resp.content), dtype=np.uint8)
                frame = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
                has_new_defect = False
                if frame is not None and model is not None:
                    results = model.predict(frame, conf=conf_threshold, imgsz=img_size, verbose=False)
                    boxes = results[0].boxes
                    if boxes is not None and len(boxes) > 0:
                        has_new_defect = True
                        capture_frame = frame.copy()
                        all_types = []; all_confs = []; all_sizes = []; all_severities = []
                        for i in range(len(boxes)):
                            x1, y1, x2, y2 = boxes.xyxy[i].cpu().tolist()
                            cls_id = int(boxes.cls[i].item())
                            conf = float(boxes.conf[i].item())
                            conf_str = f"{int(conf * 100)}%"
                            width_mm = (x2 - x1) * MM_PER_PIXEL
                            height_mm = (y2 - y1) * MM_PER_PIXEL
                            defect_type = model.names[cls_id].replace("_", " ").title()
                            severity = assess_defect_severity(defect_type, width_mm, height_mm)
                            size_str = f"{width_mm:.1f}x{height_mm:.1f}mm"
                            all_types.append(defect_type); all_confs.append(conf_str); all_sizes.append(size_str); all_severities.append(severity)
                            
                            box_color = (0, 0, 255) if severity == "Bad" else (0, 165, 255) if severity == "Poor" else (0, 255, 0)
                            cv2.rectangle(capture_frame, (int(x1), int(y1)), (int(x2), int(y2)), box_color, 2)
                            label_text = f"{defect_type} ({conf_str}) [{severity}]"
                            text_size, _ = cv2.getTextSize(label_text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 2)
                            cv2.rectangle(capture_frame, (int(x1), int(y1) - text_size[1] - 10), (int(x1) + text_size[0], int(y1)), box_color, -1)
                            cv2.putText(capture_frame, label_text, (int(x1), int(y1) - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
                            
                        tmp_path = f"annotated_{img_id}.jpg"
                        cv2.imwrite(tmp_path, capture_frame)
                        try:
                            upload_result = cloudinary.uploader.upload(tmp_path, folder="bridge_inspections")
                            new_url = upload_result['secure_url']
                            final_defect_types = ", ".join(list(dict.fromkeys(all_types))) 
                            final_sizes = " | ".join(all_sizes)
                            final_confs = " | ".join(all_confs)
                            final_severity = "Bad" if "Bad" in all_severities else "Poor" if "Poor" in all_severities else "Fair"
                            cursor.execute("""
                                UPDATE captured_images SET image_url = %s, defect_type = %s, severity_level = %s, defect_size = %s, confidence_score = %s WHERE id = %s
                            """, (new_url, final_defect_types, final_severity, final_sizes, final_confs, img_id))
                            conn.commit()
                        finally:
                            if os.path.exists(tmp_path): os.remove(tmp_path)
                if not has_new_defect:
                    cursor.execute("""
                        UPDATE captured_images SET image_url = COALESCE(raw_image_url, image_url), defect_type = 'Raw Image', severity_level = 'Fair', defect_size = 'N/A', confidence_score = 'N/A' WHERE id = %s
                    """, (img_id,))
                    conn.commit()
            except Exception as e: print(f"❌ Error processing image {img_id}: {e}")
            time.sleep(0.1) 
            with state_lock: flight_state["mission_progress"][mission_id]["processed"] += 1
        cursor.execute("UPDATE inspection_missions SET status = 'Completed' WHERE id = %s", (mission_id,))
        conn.commit(); cursor.close(); conn.close()
    except Exception as e: print(f"❌ AI Processor Crash: {e}")
    finally:
        with state_lock:
            if mission_id in flight_state["mission_progress"]: del flight_state["mission_progress"][mission_id]

# ==========================================
# UPLINK AND DOWNLINK
# ==========================================
@app.post("/api/uplink/highres")
async def receive_highres_frame(request: Request):
    with state_lock:
        is_active = flight_state["is_active"]
        m_id = flight_state["mission_id"]

    if is_active and m_id is not None:
        frame_bytes = await request.body()
        lat = request.headers.get('X-Latitude', '0.0')
        lon = request.headers.get('X-Longitude', '0.0')
        timestamp = int(time.time() * 1000)
        filepath = os.path.join(TEMP_DIR, f"mission_{m_id}_{timestamp}_{lat}_{lon}.jpg")
        with open(filepath, "wb") as f: f.write(frame_bytes)
    return {"status": "received"}

@app.websocket("/api/uplink/stream")
async def websocket_uplink(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            frame_bytes = await websocket.receive_bytes()
            np_arr = np.frombuffer(frame_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            if frame is not None:
                with state_lock: flight_state["latest_raw_frame"] = frame
    except WebSocketDisconnect: 
        with state_lock: flight_state["latest_raw_frame"] = None

def get_standby_frame():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.putText(frame, "AWAITING DRONE UPLINK...", (100, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
    return frame

def generate_mjpeg_stream():
    while True:
        with state_lock: frame = flight_state["latest_raw_frame"]
        frame_to_stream = get_standby_frame() if frame is None else frame.copy()
        ret, buffer = cv2.imencode('.jpg', frame_to_stream, [int(cv2.IMWRITE_JPEG_QUALITY), 65])
        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
        time.sleep(0.03)

@app.get("/video_feed")
def video_feed():
    return StreamingResponse(generate_mjpeg_stream(), media_type="multipart/x-mixed-replace; boundary=frame")

# ==========================================
# FLIGHT CONTROL & AI ENDPOINTS
# ==========================================
@app.post("/api/mission/start")
def start_mission(params: MissionStartParams):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO inspection_missions (bridge_id, status) VALUES (%s, 'In Progress') RETURNING id", (params.bridge_id,))
        m_id = cursor.fetchone()[0]
        conn.commit(); cursor.close(); conn.close()
        with state_lock:
            flight_state["is_active"] = True
            flight_state["mission_id"] = m_id
            flight_state["bridge_id"] = params.bridge_id
            flight_state["span_target"] = params.span_target
            flight_state["capture_mode"] = params.capture_mode
            flight_state["manual_trigger"] = False
        return {"status": "success", "mission_id": m_id}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/mission/stop")
def stop_mission():
    with state_lock:
        flight_state["is_active"] = False
        m_id = flight_state["mission_id"]
        span_target = flight_state["span_target"]
    if m_id:
        try:
            conn = psycopg2.connect(RAILWAY_DB_URL)
            cursor = conn.cursor()
            cursor.execute("UPDATE inspection_missions SET status = 'Saving to Cloud' WHERE id = %s", (m_id,))
            conn.commit(); cursor.close(); conn.close()
            threading.Thread(target=upload_raw_worker, args=(m_id, span_target)).start()
        except: pass
    return {"status": "success"}

@app.put("/api/mission/span")
def update_mission_span(params: SpanUpdateParams):
    with state_lock:
        if flight_state["is_active"]:
            flight_state["span_target"] = params.span_target
            return {"status": "success"}
        else: raise HTTPException(status_code=400)

@app.post("/api/mission/capture")
def trigger_manual_capture():
    with state_lock:
        if flight_state["is_active"] and flight_state["capture_mode"] == "manual":
            flight_state["manual_trigger"] = True
            return {"status": "success"}
    raise HTTPException(status_code=400, detail="Manual mode not active")

@app.get("/api/mission/poll_capture")
def poll_capture():
    with state_lock:
        if flight_state["is_active"]:
            current_mode = flight_state.get("capture_mode", "auto")
            span = flight_state.get("span_target", "Span 1")
            if current_mode == "manual":
                if flight_state["manual_trigger"]:
                    flight_state["manual_trigger"] = False 
                    return {"take_photo": True, "mode": "manual", "span": span}
                else:
                    return {"take_photo": False, "mode": "manual", "span": span}
            elif current_mode == "auto":
                return {"take_photo": False, "mode": "auto", "span": span}
        return {"take_photo": False, "mode": "none"}

@app.post("/api/mission/analyze")
def trigger_ai_analysis(params: AnalyzeParams):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE inspection_missions SET status = 'Processing' WHERE id = %s", (params.mission_id,))
        conn.commit(); cursor.close(); conn.close()
        threading.Thread(target=analyze_mission_worker, args=(params.mission_id, params.conf_threshold, params.img_size)).start()
        return {"status": "success"}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/mission/{mission_id}/force-reset")
def force_reset_mission(mission_id: int):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE inspection_missions SET status = 'Awaiting Analysis' WHERE id = %s", (mission_id,))
        conn.commit()
        cursor.close(); conn.close()
        with state_lock:
            if mission_id in flight_state["mission_progress"]:
                del flight_state["mission_progress"][mission_id]
        return {"status": "success"}
    except Exception as e: 
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/mission/{mission_id}/status")
def get_mission_status(mission_id: int):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("SELECT status FROM inspection_missions WHERE id = %s", (mission_id,))
        res = cursor.fetchone()
        cursor.close(); conn.close()
        
        status_str = res[0] if res else "Unknown"
        progress = 0; total = 0; processed = 0
        if status_str in ['Processing', 'Saving to Cloud']:
            with state_lock:
                prog_data = flight_state["mission_progress"].get(mission_id)
                if prog_data:
                    total = prog_data["total"]; processed = prog_data["processed"]
                    progress = int((processed / total) * 100) if total > 0 else 100
        return {"status": status_str, "progress": progress, "total": total, "processed": processed}
    except: return {"status": "error"}

@app.get("/api/mission/{mission_id}/live_frames")
def get_live_frames(mission_id: int):
    try:
        files = sorted([f for f in os.listdir(TEMP_DIR) if f.startswith(f"mission_{mission_id}")], reverse=True)[:10]
        frames = [{"url": f"/temp_frames/{f}"} for f in files]
        return {"status": "success", "frames": frames}
    except Exception as e: return {"status": "error"}

# ==========================================
# RETRAINING & ANNOTATION ENDPOINTS
# ==========================================
@app.post("/api/images/{image_id}/flag")
def flag_for_retraining(image_id: int):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE captured_images SET requires_retraining = TRUE WHERE id = %s", (image_id,))
        conn.commit(); cursor.close(); conn.close()
        return {"status": "success"}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/images/{image_id}/annotate")
def save_annotation(image_id: int, payload: AnnotationUpdate):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE captured_images SET yolo_annotation = %s WHERE id = %s", (payload.yolo_annotation, image_id))
        conn.commit(); cursor.close(); conn.close()
        return {"status": "success"}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/retraining/push-to-cloud")
def push_dataset_to_cloud():
    print("📦 Packing dataset for direct Colab transfer...")
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("SELECT id, COALESCE(raw_image_url, image_url), yolo_annotation FROM captured_images WHERE requires_retraining = TRUE AND yolo_annotation != ''")
        dataset_images = cursor.fetchall()
        cursor.close(); conn.close()

        if not dataset_images:
            raise HTTPException(status_code=400, detail="No annotated images available.")

        zip_filename = f"dataset_{int(time.time())}.zip"
        zip_path = os.path.join(TEMP_DIR, zip_filename)
        
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zip_file:
            
            yaml_content = """train: ./images/train
val: ./images/train

nc: 5
names: ['Chipping', 'Crack', 'Exposed Rebar', 'Flaking', 'Water Infiltration']
"""
            zip_file.writestr("bridge_dataset/data.yaml", yaml_content)

            for img_id, url, annotation in dataset_images:
                try:
                    response = requests.get(url, timeout=5)
                    if response.status_code == 200:
                        zip_file.writestr(f"bridge_dataset/images/train/img_{img_id}.jpg", response.content)
                        zip_file.writestr(f"bridge_dataset/labels/train/img_{img_id}.txt", annotation)
                except Exception as e:
                    print(f"Skipped {img_id}: {e}")

        secure_url = f"https://dronebridgeanalytics.up.railway.app/temp_frames/{zip_filename}"
        
        with state_lock: 
            flight_state["latest_dataset_url"] = secure_url
            
        print(f"✅ Dataset safely hosted on Railway: {secure_url}")
        return {"status": "success", "url": secure_url}

    except Exception as e:
        print(f"❌ Failed to pack dataset: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/retraining/latest-dataset")
def get_latest_dataset_url():
    with state_lock: url = flight_state.get("latest_dataset_url")
    if not url: raise HTTPException(status_code=404, detail="No dataset pushed yet.")
    return {"status": "success", "url": url}

@app.get("/api/retraining/flagged")
def get_flagged_images():
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("SELECT id, COALESCE(raw_image_url, image_url), yolo_annotation FROM captured_images WHERE requires_retraining = TRUE")
        flagged = [{"id": r[0], "url": r[1], "annotation": r[2]} for r in cursor.fetchall()]
        cursor.close(); conn.close()
        return {"status": "success", "images": flagged}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

# ==========================================
# COLAB MODEL DOWNLOAD ENDPOINT
# ==========================================
@app.get("/api/model/download-latest")
def download_latest_model():
    """Serves the most recent .pt model file directly to Google Colab."""
    try:
        available_models = glob.glob('AIModel/*.pt')
        if not available_models:
            raise HTTPException(status_code=404, detail="No YOLO model found in AIModel folder.")
            
        available_models.sort(reverse=True)
        latest = available_models[0]
        print(f"☁️ Colab requested current brain. Serving {latest}...")
        return FileResponse(latest, filename=os.path.basename(latest))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/model/current-version")
def get_current_model_version():
    """Returns the filename of the currently loaded YOLO model."""
    return {"status": "success", "version": active_model_name}

# ==========================================
# DATABASE CRUD ENDPOINTS 
# ==========================================
@app.get("/api/bridge-data")
def get_bridge_data():
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM bridges")
        total_bridges = cursor.fetchone()[0]

        cursor.execute("SELECT severity_level, COUNT(*) FROM captured_images WHERE defect_type != 'Raw Image' GROUP BY severity_level")
        severity_data = cursor.fetchall()

        cursor.execute("SELECT id, bridge_code, name, location, remarks, span_count FROM bridges")
        db_bridges = cursor.fetchall()
        
        bridge_list = []
        for b in db_bridges:
            bridge_id = b[0]
            cursor.execute("SELECT id, status FROM inspection_missions WHERE bridge_id = %s ORDER BY id DESC", (bridge_id,))
            bridge_missions = [{"id": m[0], "status": m[1]} for m in cursor.fetchall()]
            
            cursor.execute("SELECT severity_level, COUNT(*) FROM captured_images JOIN inspection_missions ON captured_images.mission_id = inspection_missions.id WHERE inspection_missions.bridge_id = %s AND defect_type != 'Raw Image' GROUP BY severity_level", (bridge_id,))
            bridge_defects = cursor.fetchall()

            cursor.execute("SELECT captured_images.id, span_target, defect_type, severity_level, captured_at, image_url, captured_images.mission_id, defect_size, confidence_score, latitude, longitude, custom_attribute FROM captured_images JOIN inspection_missions ON captured_images.mission_id = inspection_missions.id WHERE inspection_missions.bridge_id = %s ORDER BY captured_at DESC", (bridge_id,))
            
            image_gallery = [{"id": img[0], "span": img[1], "type": img[2], "severity": img[3], "date": img[4], "url": img[5], "mission_id": img[6], "size": img[7] if img[7] else 'N/A', "confidence": img[8] if img[8] else 'N/A', "lat": img[9], "lon": img[10], "attribute": img[11] if len(img) > 11 and img[11] else ''} for img in cursor.fetchall()]

            bridge_list.append({"db_id": bridge_id, "id": b[1], "name": b[2], "location": b[3], "remarks": b[4], "span_count": b[5], "defects": bridge_defects, "images": image_gallery, "missions": bridge_missions})

        cursor.close(); conn.close()
        return {"status": "success", "stats": {"total_bridges": total_bridges, "severity": severity_data}, "bridges": bridge_list}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.put("/api/images/{image_id}/attribute")
def update_image_attribute(image_id: int, payload: AttributeUpdate):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE captured_images SET custom_attribute = %s WHERE id = %s", (payload.custom_attribute, image_id))
        conn.commit()
        cursor.close(); conn.close()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/bridges")
def add_bridge(bridge: BridgeCreateUpdate):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO bridges (bridge_code, name, location, remarks, span_count) VALUES (%s, %s, %s, %s, %s) RETURNING id", (bridge.bridge_code, bridge.name, bridge.location, bridge.remarks, bridge.span_count))
        new_id = cursor.fetchone()[0]
        conn.commit(); cursor.close(); conn.close()
        return {"status": "success", "bridge_id": new_id}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.put("/api/bridges/{bridge_id}")
def update_bridge(bridge_id: int, bridge: BridgeCreateUpdate):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE bridges SET bridge_code = %s, name = %s, location = %s, remarks = %s, span_count = %s WHERE id = %s", (bridge.bridge_code, bridge.name, bridge.location, bridge.remarks, bridge.span_count, bridge_id))
        conn.commit(); cursor.close(); conn.close()
        return {"status": "success"}
    except: raise HTTPException(status_code=500)

@app.put("/api/bridges/{bridge_id}/remarks")
def update_bridge_remarks(bridge_id: int, update_data: RemarkUpdate):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE bridges SET remarks = %s WHERE id = %s", (update_data.remarks, bridge_id))
        conn.commit(); cursor.close(); conn.close()
        return {"status": "success"}
    except: raise HTTPException(status_code=500)

@app.delete("/api/bridges/{bridge_id}")
def delete_bridge(bridge_id: int):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM captured_images WHERE mission_id IN (SELECT id FROM inspection_missions WHERE bridge_id = %s)", (bridge_id,))
        cursor.execute("DELETE FROM inspection_missions WHERE bridge_id = %s", (bridge_id,))
        cursor.execute("DELETE FROM bridges WHERE id = %s", (bridge_id,))
        conn.commit()
        cursor.close()
        conn.close()
        return {"status": "success"}
    except Exception as e: 
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/images/bulk-delete")
def bulk_delete_images(params: BulkDeleteParams):
    try:
        if not params.image_ids: return {"status": "success"}
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        format_strings = ','.join(['%s'] * len(params.image_ids))
        query = f"DELETE FROM captured_images WHERE id IN ({format_strings})"
        cursor.execute(query, tuple(params.image_ids))
        conn.commit(); cursor.close(); conn.close()
        return {"status": "success"}
    except Exception as e: 
        raise HTTPException(status_code=500, detail=str(e))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
web_path = os.path.join(BASE_DIR, "webapp")
if not os.path.exists(web_path): os.makedirs(web_path)

app.mount("/temp_frames", StaticFiles(directory=TEMP_DIR), name="temp_frames")
app.mount("/", StaticFiles(directory=web_path, html=True), name="web")

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)