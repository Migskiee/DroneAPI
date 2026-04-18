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
from datetime import datetime
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel 
from ultralytics import YOLO

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
    cursor.execute("UPDATE captured_images SET raw_image_url = image_url WHERE raw_image_url IS NULL AND defect_type = 'Raw Image';")
    conn.commit()
    cursor.close()
    conn.close()
except Exception as e:
    print(f"Migration note: {e}")

app = FastAPI()

class SeverityUpdate(BaseModel): severity: str
class RemarkUpdate(BaseModel): remarks: str
class MissionStartParams(BaseModel): bridge_id: int; span_target: str
class SpanUpdateParams(BaseModel): span_target: str
class BridgeCreateUpdate(BaseModel): bridge_code: str; name: str; location: str; remarks: str; span_count: int
class BulkDeleteParams(BaseModel): image_ids: list[int]

class AnalyzeParams(BaseModel): 
    mission_id: int
    conf_threshold: float = 0.5
    img_size: int = 640

# ==========================================
# CLOUD AI & LIVE STREAMING STATE
# ==========================================
try:
    model = YOLO('AIModel/AIModelFinalV2.pt')
    print("YOLO Model Loaded Successfully!")
except Exception as e:
    print(f"Warning: YOLO Model not found or failed to load. {e}")
    model = None

flight_state = {
    "is_active": False,
    "mission_id": None,
    "bridge_id": None,
    "span_target": "Span 1",
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

# --- PHASE 1: RAW UPLOAD WORKER ---
def upload_raw_worker(mission_id, span_target):
    print(f"\n☁️ UPLOADING RAW MISSION DATA: {mission_id}")
    try:
        files = sorted([f for f in os.listdir(TEMP_DIR) if f.startswith(f"mission_{mission_id}")])
        total_files = len(files)
        
        with state_lock:
            flight_state["mission_progress"][mission_id] = {"total": total_files, "processed": 0}

        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        
        for file in files:
            filepath = os.path.join(TEMP_DIR, file)
            try:
                upload_result = cloudinary.uploader.upload(filepath, folder="bridge_raw_captures")
                secure_url = upload_result['secure_url']
                
                cursor.execute("""
                    INSERT INTO captured_images (mission_id, span_target, image_url, defect_type, severity_level, defect_size, confidence_score, raw_image_url)
                    VALUES (%s, %s, %s, 'Raw Image', 'Pending', 'N/A', 'N/A', %s)
                """, (mission_id, span_target, secure_url, secure_url))
                conn.commit()
            except Exception as e:
                print(f"❌ Upload failed for {file}: {e}")
            finally:
                if os.path.exists(filepath): os.remove(filepath)
                
            with state_lock:
                flight_state["mission_progress"][mission_id]["processed"] += 1

        cursor.execute("UPDATE inspection_missions SET status = 'Awaiting Analysis' WHERE id = %s", (mission_id,))
        conn.commit()
        cursor.close(); conn.close()
        print(f"✅ RAW DATA SAVED FOR MISSION {mission_id}")
        
    except Exception as e:
        print(f"❌ Raw Upload Crash: {e}")
    finally:
        with state_lock:
            if mission_id in flight_state["mission_progress"]:
                del flight_state["mission_progress"][mission_id]

# --- PHASE 2: AI ANALYSIS WORKER ---
def analyze_mission_worker(mission_id, conf_threshold=0.5, img_size=640):
    print(f"\n🧠 STARTING AI ANALYSIS ON MISSION {mission_id} [Conf: {conf_threshold}, Size: {img_size}]")
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        
        cursor.execute("SELECT id, COALESCE(raw_image_url, image_url), span_target FROM captured_images WHERE mission_id = %s", (mission_id,))
        raw_images = cursor.fetchall()
        
        total_files = len(raw_images)
        with state_lock:
            flight_state["mission_progress"][mission_id] = {"total": total_files, "processed": 0}

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
                        
                        all_types = []
                        all_confs = []
                        all_sizes = []
                        all_severities = []
                        
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
                            
                            all_types.append(defect_type)
                            all_confs.append(conf_str)
                            all_sizes.append(size_str)
                            all_severities.append(severity)
                            
                            box_color = (0, 0, 255) if severity == "Bad" else (0, 165, 255) if severity == "Poor" else (0, 255, 0)
                            cv2.rectangle(capture_frame, (int(x1), int(y1)), (int(x2), int(y2)), box_color, 2)
                            
                            label_text = f"{defect_type} ({conf_str}) [{severity}]"
                            text_size, _ = cv2.getTextSize(label_text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 2)
                            text_w, text_h = text_size
                            
                            cv2.rectangle(capture_frame, (int(x1), int(y1) - text_h - 10), (int(x1) + text_w, int(y1)), box_color, -1)
                            cv2.putText(capture_frame, label_text, (int(x1), int(y1) - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
                            
                        tmp_path = f"annotated_{img_id}.jpg"
                        cv2.imwrite(tmp_path, capture_frame)
                        try:
                            upload_result = cloudinary.uploader.upload(tmp_path, folder="bridge_inspections")
                            new_url = upload_result['secure_url']
                            
                            final_defect_types = ", ".join(list(dict.fromkeys(all_types))) 
                            final_sizes = " | ".join(all_sizes)
                            final_confs = " | ".join(all_confs)
                            
                            if "Bad" in all_severities:
                                final_severity = "Bad"
                            elif "Poor" in all_severities:
                                final_severity = "Poor"
                            else:
                                final_severity = "Fair"
                            
                            cursor.execute("""
                                UPDATE captured_images 
                                SET image_url = %s, defect_type = %s, severity_level = %s, defect_size = %s, confidence_score = %s
                                WHERE id = %s
                            """, (new_url, final_defect_types, final_severity, final_sizes, final_confs, img_id))
                            conn.commit()
                        finally:
                            if os.path.exists(tmp_path): os.remove(tmp_path)
                            
                if not has_new_defect:
                    cursor.execute("""
                        UPDATE captured_images 
                        SET image_url = COALESCE(raw_image_url, image_url), defect_type = 'Raw Image', severity_level = 'Fair', defect_size = 'N/A', confidence_score = 'N/A' 
                        WHERE id = %s
                    """, (img_id,))
                    conn.commit()
                    
            except Exception as e:
                print(f"❌ Error processing image {img_id}: {e}")
                
            time.sleep(0.1) 
            with state_lock:
                flight_state["mission_progress"][mission_id]["processed"] += 1
                
        cursor.execute("UPDATE inspection_missions SET status = 'Completed' WHERE id = %s", (mission_id,))
        conn.commit()
        cursor.close(); conn.close()
        print(f"✅ AI ANALYSIS COMPLETE FOR MISSION {mission_id}")
        
    except Exception as e:
        print(f"❌ AI Processor Background Crash: {e}")
    finally:
        with state_lock:
            if mission_id in flight_state["mission_progress"]:
                del flight_state["mission_progress"][mission_id]

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
        timestamp = int(time.time() * 1000)
        filepath = os.path.join(TEMP_DIR, f"mission_{m_id}_{timestamp}.jpg")
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

            cursor.execute("SELECT captured_images.id, span_target, defect_type, severity_level, captured_at, image_url, captured_images.mission_id, defect_size, confidence_score FROM captured_images JOIN inspection_missions ON captured_images.mission_id = inspection_missions.id WHERE inspection_missions.bridge_id = %s ORDER BY captured_at DESC", (bridge_id,))
            image_gallery = [{"id": img[0], "span": img[1], "type": img[2], "severity": img[3], "date": img[4], "url": img[5], "mission_id": img[6], "size": img[7] if img[7] else 'N/A', "confidence": img[8] if img[8] else 'N/A'} for img in cursor.fetchall()]

            bridge_list.append({"db_id": bridge_id, "id": b[1], "name": b[2], "location": b[3], "remarks": b[4], "span_count": b[5], "defects": bridge_defects, "images": image_gallery, "missions": bridge_missions})

        cursor.close(); conn.close()
        return {"status": "success", "stats": {"total_bridges": total_bridges, "severity": severity_data}, "bridges": bridge_list}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

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

# NEW: Safely delete a bridge and all its data
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
        if not params.image_ids:
            return {"status": "success"}
            
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        format_strings = ','.join(['%s'] * len(params.image_ids))
        query = f"DELETE FROM captured_images WHERE id IN ({format_strings})"
        
        cursor.execute(query, tuple(params.image_ids))
        conn.commit()
        cursor.close()
        conn.close()
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