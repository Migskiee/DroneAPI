import os
import psycopg2
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel # NEW: Required for reading incoming JSON updates
import cloudinary
import cloudinary.uploader
import uvicorn

# ==========================================
# CONFIGURATION
# ==========================================
cloudinary.config(
    cloud_name=os.getenv("CLOUD_NAME"),
    api_key=os.getenv("CD_API_KEY"),
    api_secret=os.getenv("CD_API_SECRET")
)

RAILWAY_DB_URL = "postgresql://postgres:huXFgxfRwaSChMeTWJdNjZiCnZUkxIve@interchange.proxy.rlwy.net:21621/railway"

app = FastAPI()

# Data Model for our Update Request
class SeverityUpdate(BaseModel):
    severity: str

# ==========================================
# API ENDPOINTS
# ==========================================
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

        cursor.execute("SELECT id, bridge_code, name, location FROM bridges")
        db_bridges = cursor.fetchall()
        
        bridge_list = []
        for b in db_bridges:
            bridge_id = b[0]
            
            # 1. Fetch Defect Stats for the Chart
            cursor.execute("""
                SELECT severity_level, COUNT(*) FROM captured_images 
                JOIN inspection_missions ON captured_images.mission_id = inspection_missions.id
                WHERE inspection_missions.bridge_id = %s
                GROUP BY severity_level
            """, (bridge_id,))
            bridge_defects = cursor.fetchall()

            # 2. NEW: Fetch Actual Image Records for the Gallery
            cursor.execute("""
                SELECT captured_images.id, span_target, defect_type, severity_level, captured_at, image_url 
                FROM captured_images 
                JOIN inspection_missions ON captured_images.mission_id = inspection_missions.id
                WHERE inspection_missions.bridge_id = %s
                ORDER BY captured_at DESC
            """, (bridge_id,))
            
            raw_images = cursor.fetchall()
            image_gallery = []
            for img in raw_images:
                image_gallery.append({
                    "id": img[0],
                    "span": img[1],
                    "type": img[2],
                    "severity": img[3],
                    "date": img[4],
                    "url": img[5]
                })

            bridge_list.append({
                "db_id": bridge_id,
                "id": b[1], 
                "name": b[2],
                "location": b[3],
                "defects": bridge_defects,
                "images": image_gallery
            })

        cursor.close()
        conn.close()

        return {
            "status": "success",
            "stats": {
                "total_bridges": total_bridges,
                "total_defects": total_defects,
                "severity": severity_data
            },
            "bridges": bridge_list
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# NEW: UPDATE ENDPOINT
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

# NEW: DELETE ENDPOINT
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

# ==========================================
# FRONTEND MOUNTING & BOOTLOADER
# ==========================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
web_path = os.path.join(BASE_DIR, "webapp")

if not os.path.exists(web_path):
    os.makedirs(web_path)

app.mount("/", StaticFiles(directory=web_path, html=True), name="web")

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)