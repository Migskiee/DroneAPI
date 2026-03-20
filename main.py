import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

web_path = os.path.join(BASE_DIR, "webapp")

print("DEBUG PATH:", web_path)
print("FILES:", os.listdir(BASE_DIR))

app.mount("/", StaticFiles(directory=web_path, html=True), name="web")