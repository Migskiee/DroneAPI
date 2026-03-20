const API_URL = "https://droneapi-production.up.railway.app/"; // replace

function startCamera() {
    fetch(`${API_URL}/command`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            action: "start_camera"
        })
    })
    .then(res => console.log("Camera started"))
    .catch(err => console.error(err));
}

function flyDrone() {
    fetch(`${API_URL}/command`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            action: "start_fly"
        })
    })
    .then(res => console.log("Drone flying"))
    .catch(err => console.error(err));
}