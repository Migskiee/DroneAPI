import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import cloudinary
import cloudinary.uploader

cloudinary.config(
    cloud_name=os.getenv("CLOUD_NAME"),
    api_key=os.getenv("CD_API_KEY"),
    api_secret=os.getenv("CD_API_SECRET")
)

app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

web_path = os.path.join(BASE_DIR, "webapp")

print("DEBUG PATH:", web_path)
print("FILES:", os.listdir(BASE_DIR))

app.mount("/", StaticFiles(directory=web_path, html=True), name="web")