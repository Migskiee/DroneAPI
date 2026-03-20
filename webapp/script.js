document.addEventListener('DOMContentLoaded', () => {
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.content-section');

    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();

            const targetId = this.getAttribute('data-target');

            sections.forEach(section => {
                section.style.display = 'none';
            });

            const targetSection = document.getElementById(targetId);
            if (targetSection) {
                targetSection.style.display = 'block';
            }

            navLinks.forEach(l => l.classList.remove('active'));
            this.classList.add('active');
        });
    });
});


// ==========================
// 🚀 API CONFIG (RAILWAY)
// ==========================

const API_URL = "https://droneapi-production.up.railway.app"; // 🔥 CHANGE THIS


// ==========================
// 🎥 CAMERA CONTROL
// ==========================

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
    .then(res => res.json())
    .then(data => {
        console.log(data);
        updateStatus("Camera Running ✅");
    })
    .catch(err => {
        console.error(err);
        updateStatus("Error starting camera ❌");
    });
}


function stopCamera() {
    fetch(`${API_URL}/command`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            action: "stop_camera"
        })
    })
    .then(res => res.json())
    .then(data => {
        console.log(data);
        updateStatus("Camera Stopped ⛔");
    })
    .catch(err => {
        console.error(err);
        updateStatus("Error stopping camera ❌");
    });
}


// ==========================
// 📡 STATUS HANDLER
// ==========================

function updateStatus(message) {
    const statusEl = document.getElementById("statusText");
    if (statusEl) {
        statusEl.innerText = message;
    }
}