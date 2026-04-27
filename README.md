# ** GOOGLE COLAB CODE ** For AI Training of the system


import requests
import urllib.request
import os


print("📡 Contacting Railway GCS for latest dataset...")
RAILWAY_API = "https://dronebridgeanalytics.up.railway.app/api/retraining/latest-dataset"
response = requests.get(RAILWAY_API)

if response.status_code == 200:
    dataset_url = response.json()['url']
    print(f"✅ Found dataset! Downloading from Cloudinary...")
    
    # 2. Download and unzip the file
    urllib.request.urlretrieve(dataset_url, "bridge_dataset.zip")
    !unzip -q -o bridge_dataset.zip
    print("✅ Dataset unpacked. Ready for training.")
    
    # 3. Install YOLO and Train
    !pip install ultralytics -q
    from ultralytics import YOLO
    
    # Make sure you uploaded AIModelFinalV4.pt to Colab's file explorer first!
    print("🧠 Initiating Neural Network Retraining...")
    model = YOLO('AIModelFinalV4.pt')
    results = model.train(data='bridge_dataset/data.yaml', epochs=40, imgsz=640, batch=-1)
    
    print("🎉 TRAINING COMPLETE! Download your new 'best.pt' file from the runs/ folder.")
    
else:
    print("❌ Error: Railway server did not have a dataset ready. Did you click 'Push' in the app?")





# this to be used in any google account just run this after pushing the datasets to the cloud in the webapp

This Application are for academic purposes, This System is used for the software side of our drone
the drone's goal is to detect defects on concrete bridges using computer vision or OpenCV, using the YOLO AI Model we achieve this goal and currently using for detection.

System Tools and Software 

Frontend :
HTML5
CSS
Javascript

Backend :
Python

Cloud Hosting: 
Cloudinary
Railway

Database: 
PostGreSQL

AI MODEL:
YOLOv11s

RESEARCH PAPER TITLE:
UNMANNED AERIAL VEHICLE FOR VISUAL INSPECTION OF CONCRETE BRIDGES

GROUP:
BALDADO, JOSE MIGUEL B.
YAKIT, DIONESIO
PLATA, ALMIRA
CASARINO, NINO MELLORD
GUIMBA, KARMELA
CARATAY, AMOR
ESPENIDA, LOUIE