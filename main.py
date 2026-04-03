import os
import psycopg2
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
import cloudinary
import cloudinary.uploader

# ==========================================
# CONFIGURATION
# ==========================================
cloudinary.config(
    cloud_name=os.getenv("CLOUD_NAME"),
    api_key=os.getenv("CD_API_KEY"),
    api_secret=os.getenv("CD_API_SECRET")
)

# Your database URL is hardcoded here so it connects instantly
RAILWAY_DB_URL = "postgresql://postgres:huXFgxfRwaSChMeTWJdNjZiCnZUkxIve@interchange.proxy.rlwy.net:21621/railway"

app = FastAPI()

# ==========================================
# API ENDPOINTS
# ==========================================
@app.get("/api/bridge-data")
def get_bridge_data():
    """Fetches live analytics AND the bridge roster from PostgreSQL."""
    try:
        conn = psycopg2.connect(RAILWAY_DB_URL)
        cursor = conn.cursor()

        # 1. Fetch Global Stats
        cursor.execute("SELECT COUNT(*) FROM bridges")
        total_bridges = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM captured_images")
        total_defects = cursor.fetchone()[0]

        # 2. Fetch Severity Breakdown for the Global Chart
        cursor.execute("SELECT severity_level, COUNT(*) FROM captured_images GROUP BY severity_level")
        severity_data = cursor.fetchall()

        # 3. Fetch Bridge List for the Database Tab
        cursor.execute("SELECT id, bridge_code, name, location FROM bridges")
        db_bridges = cursor.fetchall()
        
        bridge_list = []
        for b in db_bridges:
            cursor.execute("""
                SELECT severity_level, COUNT(*) FROM captured_images 
                JOIN inspection_missions ON captured_images.mission_id = inspection_missions.id
                WHERE inspection_missions.bridge_id = %s
                GROUP BY severity_level
            """, (b[0],))
            bridge_defects = cursor.fetchall()

            bridge_list.append({
                "id": b[1], 
                "name": b[2],
                "location": b[3],
                "defects": bridge_defects
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

# ==========================================
# FRONTEND MOUNTING (Your original method)
# ==========================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
web_path = os.path.join(BASE_DIR, "webapp")

# Safety Catch: Ensure the folder exists
if not os.path.exists(web_path):
    os.makedirs(web_path)

app.mount("/", StaticFiles(directory=web_path, html=True), name="web")