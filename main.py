import os
import cv2
import numpy as np
import threading
import time
import psycopg2
import cloudinary
import cloudinary.uploader
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

# Create a temporary folder to hold photos during the flight
TEMP_DIR = "temp_mission_frames"
os.makedirs(TEMP_DIR, exist_ok=True)

try:
    conn = psycopg2.connect(RAILWAY_DB_URL)
    cursor = conn.cursor()
    cursor.execute("ALTER TABLE bridges ADD COLUMN IF NOT EXISTS remarks TEXT;")
    cursor.execute("ALTER TABLE bridges ADD COLUMN IF NOT EXISTS span_count INTEGER DEFAULT 1;")
    conn.commit()
    cursor.close()
    conn.close()
except Exception as e:
    print(f"Migration note: {e}")

app = FastAPI()

class SeverityUpdate(BaseModel):
    severity: str

class RemarkUpdate(BaseModel):
    remarks: str

class MissionStartParams(BaseModel):
    bridge_id: int
    span_target: str

class BridgeCreateUpdate(BaseModel):
    bridge_code: str
    name: str
    location: str
    remarks: str
    span_count: int

# ==========================================
# CLOUD AI & LIVE STREAMING STATE
# ==========================================
try:
    model = YOLO('AIModel/AIModelFinal.pt')
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
}
state_lock = threading.Lock()

def assess_defect_severity(defect_type, w_mm, h_mm):
    dt = defect_type.lower()
    max_dim = max(w_mm, h_mm)
    min_dim = min(w_mm, h_mm) 
    if "crack" in dt:
        return "Bad" if min_dim > 1.0 else "Poor" if min_dim > 0.3 else "Fair"
    elif "flaking" in dt:
        return "Bad" if max_dim > 600 else "Poor" if max_dim > 300 else "Fair"
    elif "chipping" in dt: 
        return "Bad" if max_dim > 300 else "Poor" if max_dim > 150 else "Fair"
    elif "rebar" in dt:
        return "Bad" if max_dim >= 200 else "Poor"
    elif "water" in dt or "infiltration" in dt:
        return "Bad" if max_dim >= 300 else "Poor"
    return "Fair"

# --- NEW: BACKGROUND AUTO-CAPTURE WORKER (RUNS DURING FLIGHT) ---
def auto_capture_worker():
    # Takes a silent photo every 2 seconds while the drone is flying
    while True:
        with state_lock:
            is_active = flight_state["is_active"]
            raw_frame = flight_state["latest_raw_frame"]
            m_id = flight_state["mission_id"]
            
        if is_active and raw_frame is not None:
            timestamp = int(time.time() * 1000)
            filepath = os.path.join(TEMP_DIR, f"mission_{m_id}_{timestamp}.jpg")
            cv2.imwrite(filepath, raw_frame)
            
        time.sleep(2.0) # <--- Change this number to capture photos faster or slower

threading.Thread(target=auto_capture_worker, daemon=True).start()

# --- NEW: POST-MISSION BATCH AI PROCESSOR (RUNS AFTER FLIGHT) ---
def post_mission_ai_processor(mission_id, span_target):
    # Gathers all photos taken during the mission
    files = sorted([f for f in os.listdir(TEMP_DIR) if f.startswith(f"mission_{mission_id}")])
    captured_track_ids = set()
    MM_PER_PIXEL = 0.2
    
    for file in files:
        filepath = os.path.join(TEMP_DIR, file)
        frame = cv2.imread(filepath)
        
        if frame is not None and model is not None:
            # Run YOLO AI on the photo
            results = model.track(frame, conf=0.5, imgsz=320, persist=True, tracker="bytetrack.yaml", verbose=False)
            boxes = results[0].boxes
            
            # IF DEFECTS ARE DETECTED
            if boxes is not None and len(boxes) > 0:
                # If tracker loses ID, assign a fallback timestamp ID
                track_ids = boxes.id.int().cpu().tolist() if boxes.id is not None else [int(time.time()*1000)+i for i in range(len(boxes))]
                has_new_defect = False
                capture_frame = frame.copy()
                
                # Draw boxes for all detected defects
                for i in range(len(boxes)):
                    track_id = track_ids[i]
                    if track_id not in captured_track_ids:
                        captured_track_ids.add(track_id)
                        has_new_defect = True
                        
                        x1, y1, x2, y2 = boxes.xyxy[i].cpu().tolist()
                        cls_id = int(boxes.cls[i].item())
                        
                        width_mm = (x2 - x1) * MM_PER_PIXEL
                        height_mm = (y2 - y1) * MM_PER_PIXEL
                        defect_type = model.names[cls_id].replace("_", " ").title()
                        severity = assess_defect_severity(defect_type, width_mm, height_mm)
                        
                        box_color = (0, 0, 255) if severity == "Bad" else (0, 165, 255) if severity == "Poor" else (0, 255, 0)
                        cv2.rectangle(capture_frame, (int(x1), int(y1)), (int(x2), int(y2)), box_color, 2)
                        cv2.putText(capture_frame, f"{defect_type} [{severity}]", (int(x1), int(y1) - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
                
                # ONLY UPLOAD IF A NEW DEFECT WAS FOUND
                if has_new_defect:
                    tmp_path = f"upload_{mission_id}_{int(time.time()*1000)}.jpg"
                    cv2.imwrite(tmp_path, capture_frame)
                    try:
                        upload_result = cloudinary.uploader.upload(tmp_path, folder="bridge_inspections")
                        secure_url = upload_result['secure_url']
                        
                        conn = psycopg2.connect(RAILWAY_DB_URL)
                        cursor = conn.cursor()
                        cursor.execute("""
                            INSERT INTO captured_images (mission_id, span_target, image_url, defect_type, severity_level)
                            VALUES (%s, %s, %s, %s, %s)
                        """, (mission_id, span_target, secure_url, defect_type, severity))
                        conn.commit()
                        cursor.close()
                        conn.close()
                    except Exception as e:
                        print(f"Cloud sync failed: {e}")
                    finally:
                        if os.path.exists(tmp_path):
                            os.remove(tmp_path)
                            
        # DELETE THE RAW PHOTO REGARDLESS (Only annotated ones with defects were saved to Cloudinary)
        try: os.remove(filepath)
        except: pass
            
    # Mark the mission as officially 'Completed' in the Database
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE inspection_missions SET status = 'Completed' WHERE id = %s", (mission_id,))
        conn.commit()
        cursor.close()
        conn.close()
    except Exception as e:
        print("DB Status Update failed", e)


# ==========================================
# UPLINK AND DOWNLINK (VIDEO STREAMING)
# ==========================================

@app.websocket("/api/uplink/stream")
async def websocket_uplink(websocket: WebSocket):
    await websocket.accept()
    print("Drone connected via High-Speed WebSocket!")
    try:
        while True:
            frame_bytes = await websocket.receive_bytes()
            np_arr = np.frombuffer(frame_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            
            if frame is not None:
                with state_lock:
                    flight_state["latest_raw_frame"] = frame
                        
    except WebSocketDisconnect:
        print("Drone WebSocket disconnected.")

def get_standby_frame():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.putText(frame, "AWAITING DRONE UPLINK...", (100, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
    return frame

def generate_mjpeg_stream():
    # Because we removed the live AI drawing, this stream is now pure hardware video! Zero Lag!
    while True:
        with state_lock:
            frame = flight_state["latest_raw_frame"]
            
        if frame is None:
            frame_to_stream = get_standby_frame()
        else:
            frame_to_stream = frame.copy()
            
        ret, buffer = cv2.imencode('.jpg', frame_to_stream, [int(cv2.IMWRITE_JPEG_QUALITY), 65])
        frame_bytes = buffer.tobytes()
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        
        time.sleep(0.03)

@app.get("/video_feed")
def video_feed():
    return StreamingResponse(generate_mjpeg_stream(), media_type="multipart/x-mixed-replace; boundary=frame")


# ==========================================
# FLIGHT CONTROL ENDPOINTS
# ==========================================
@app.post("/api/mission/start")
def start_mission(params: MissionStartParams):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO inspection_missions (bridge_id, status) VALUES (%s, 'In Progress') RETURNING id", (params.bridge_id,))
        m_id = cursor.fetchone()[0]
        conn.commit()
        cursor.close()
        conn.close()

        with state_lock:
            flight_state["is_active"] = True
            flight_state["mission_id"] = m_id
            flight_state["bridge_id"] = params.bridge_id
            flight_state["span_target"] = params.span_target

        return {"status": "success", "mission_id": m_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
            cursor.execute("UPDATE inspection_missions SET status = 'Processing' WHERE id = %s", (m_id,))
            conn.commit()
            cursor.close()
            conn.close()
            
            # Start the AI Background Batch Processor
            threading.Thread(target=post_mission_ai_processor, args=(m_id, span_target)).start()
        except Exception as e:
            print("Failed to trigger processing:", e)
            
    return {"status": "success"}

@app.get("/api/mission/{mission_id}/status")
def get_mission_status(mission_id: int):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("SELECT status FROM inspection_missions WHERE id = %s", (mission_id,))
        res = cursor.fetchone()
        cursor.close()
        conn.close()
        return {"status": res[0] if res else "Unknown"}
    except Exception as e:
        return {"status": "error"}

@app.get("/api/mission/{mission_id}/captures")
def get_mission_captures(mission_id: int):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, defect_type, severity_level, image_url, captured_at
            FROM captured_images WHERE mission_id = %s ORDER BY captured_at DESC LIMIT 6
        """, (mission_id,))
        rows = cursor.fetchall()
        captures = [{"id": r[0], "defect_type": r[1], "severity": r[2], "image_url": r[3], "date": r[4]} for r in rows]
        cursor.close()
        conn.close()
        return {"status": "success", "captures": captures}
    except Exception as e:
        return {"status": "error", "detail": str(e)}

# ==========================================
# DATABASE CRUD ENDPOINTS (No Changes Needed Here)
# ==========================================
@app.post("/api/bridges")
def add_bridge(bridge: BridgeCreateUpdate):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO bridges (bridge_code, name, location, remarks, span_count) 
            VALUES (%s, %s, %s, %s, %s) RETURNING id
        """, (bridge.bridge_code, bridge.name, bridge.location, bridge.remarks, bridge.span_count))
        new_id = cursor.fetchone()[0]
        conn.commit()
        cursor.close()
        conn.close()
        return {"status": "success", "bridge_id": new_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/api/bridges/{bridge_id}")
def update_bridge(bridge_id: int, bridge: BridgeCreateUpdate):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE bridges 
            SET bridge_code = %s, name = %s, location = %s, remarks = %s, span_count = %s 
            WHERE id = %s
        """, (bridge.bridge_code, bridge.name, bridge.location, bridge.remarks, bridge.span_count, bridge_id))
        conn.commit()
        cursor.close()
        conn.close()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/bridge-data")
def get_bridge_data():
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM bridges")
        total_bridges = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM captured_images")
        total_defects = cursor.fetchone()[0]
        cursor.execute("SELECT severity_level, COUNT(*) FROM captured_images GROUP BY severity_level")
        severity_data = cursor.fetchall()

        cursor.execute("SELECT id, bridge_code, name, location, remarks, span_count FROM bridges")
        db_bridges = cursor.fetchall()
        
        bridge_list = []
        for b in db_bridges:
            bridge_id = b[0]
            cursor.execute("""
                SELECT severity_level, COUNT(*) FROM captured_images 
                JOIN inspection_missions ON captured_images.mission_id = inspection_missions.id
                WHERE inspection_missions.bridge_id = %s
                GROUP BY severity_level
            """, (bridge_id,))
            bridge_defects = cursor.fetchall()

            cursor.execute("""
                SELECT captured_images.id, span_target, defect_type, severity_level, captured_at, image_url, captured_images.mission_id
                FROM captured_images 
                JOIN inspection_missions ON captured_images.mission_id = inspection_missions.id
                WHERE inspection_missions.bridge_id = %s
                ORDER BY captured_at DESC
            """, (bridge_id,))
            
            raw_images = cursor.fetchall()
            image_gallery = []
            for img in raw_images:
                image_gallery.append({
                    "id": img[0], "span": img[1], "type": img[2],
                    "severity": img[3], "date": img[4], "url": img[5], "mission_id": img[6]
                })

            bridge_list.append({
                "db_id": bridge_id, "id": b[1], "name": b[2],
                "location": b[3], "remarks": b[4], "span_count": b[5], "defects": bridge_defects, "images": image_gallery
            })

        cursor.close()
        conn.close()
        return {
            "status": "success",
            "stats": {"total_bridges": total_bridges, "total_defects": total_defects, "severity": severity_data},
            "bridges": bridge_list
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/api/defects/{defect_id}")
def update_defect(defect_id: int, update_data: SeverityUpdate):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE captured_images SET severity_level = %s WHERE id = %s", (update_data.severity, defect_id))
        conn.commit()
        cursor.close()
        conn.close()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/defects/{defect_id}")
def delete_defect(defect_id: int):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM captured_images WHERE id = %s", (defect_id,))
        conn.commit()
        cursor.close()
        conn.close()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/api/bridges/{bridge_id}/remarks")
def update_bridge_remarks(bridge_id: int, update_data: RemarkUpdate):
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()
        cursor.execute("UPDATE bridges SET remarks = %s WHERE id = %s", (update_data.remarks, bridge_id))
        conn.commit()
        cursor.close()
        conn.close()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
web_path = os.path.join(BASE_DIR, "webapp")
if not os.path.exists(web_path): os.makedirs(web_path)
app.mount("/", StaticFiles(directory=web_path, html=True), name="web")

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)