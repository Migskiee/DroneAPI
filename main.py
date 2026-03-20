from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# Serve your web app
app.mount("/", StaticFiles(directory="webapp", html=True), name="web")