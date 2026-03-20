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

// --- MOCK DATABASE ---
const bridgesData = [
    {
        id: "BRG-001",
        name: "Borongan Bridge",
        location: "Eastern Samar, Philippines",
        defects: [15, 8, 3, 12, 5] // Placeholder data for 5 defect types
    },
    {
        id: "BRG-002",
        name: "Loom River Bridge",
        location: "Borongan City, Eastern Samar",
        defects: [2, 1, 0, 4, 1]
    },
    {
        id: "BRG-003",
        name: "Golden Gate Prototype",
        location: "San Francisco, CA",
        defects: [45, 22, 18, 5, 9]
    }
];

// --- RENDER LIST ---
const bridgeGrid = document.getElementById('bridgeGrid');
const searchInput = document.getElementById('bridgeSearch');
let chartInstance = null; // Keeps track of the chart so we can destroy/rebuild it

function renderBridges(data) {
    bridgeGrid.innerHTML = ''; // Clear current
    
    data.forEach(bridge => {
        const card = document.createElement('div');
        card.className = 'bridge-card';
        card.onclick = () => showBridgeDetails(bridge);
        
        // Updated inner HTML to separate the text from the ID badge
        card.innerHTML = `
            <div class="bridge-info">
                <h3>${bridge.name}</h3>
                <p>${bridge.location}</p>
            </div>
            <span class="bridge-id">${bridge.id}</span>
        `;
        bridgeGrid.appendChild(card);
    });
}
// Initial render
renderBridges(bridgesData);

// --- SEARCH FUNCTIONALITY ---
searchInput.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    const filtered = bridgesData.filter(bridge => 
        bridge.name.toLowerCase().includes(term) || 
        bridge.location.toLowerCase().includes(term)
    );
    renderBridges(filtered);
});

// --- SHOW DETAILS & CHART ---
function showBridgeDetails(bridge) {
    // Hide list, show details
    document.getElementById('bridgeListView').style.display = 'none';
    document.getElementById('bridgeDetailView').style.display = 'block';

    // Populate text
    document.getElementById('detailName').innerText = bridge.name;
    document.getElementById('detailLocation').innerText = bridge.location;
    document.getElementById('detailId').innerText = bridge.id;

    // Render Chart
    const ctx = document.getElementById('defectChart').getContext('2d');
    
    // Destroy previous chart if it exists so they don't overlap
    if (chartInstance) {
        chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
            // Placeholder Defect Types
            labels: ['Surface Cracks', 'Spalling', 'Corrosion', 'Exposed Rebar', 'Water Seepage'],
            datasets: [{
                data: bridge.defects,
                backgroundColor: [
                    '#ef4444', // Red
                    '#f97316', // Orange
                    '#eab308', // Yellow
                    '#3b82f6', // Blue
                    '#8b5cf6'  // Purple
                ],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' }
            }
        }
    });
}

// --- BACK BUTTON LOGIC ---
function showBridgeList() {
    document.getElementById('bridgeListView').style.display = 'block';
    document.getElementById('bridgeDetailView').style.display = 'none';
}

let globalChartInstance = null;

function loadGlobalAnalytics() {
    // 1. Update the Summary Metric Cards
    const totalBridges = bridgesData.length;
    let totalDefects = 0;
    
    // Loop through our mock database to count every single defect
    bridgesData.forEach(bridge => {
        bridge.defects.forEach(defectCount => {
            totalDefects += defectCount;
        });
    });

    document.getElementById('totalBridgesValue').innerText = totalBridges;
    document.getElementById('totalDefectsValue').innerText = totalDefects;

    // 2. Render the Condition Pie Chart
    const ctx = document.getElementById('globalConditionChart').getContext('2d');
    
    // Prevent chart overlap if the user clicks back and forth
    if (globalChartInstance) {
        globalChartInstance.destroy();
    }

    // Mock data: Let's pretend 1 bridge is good, 1 is poor, 1 is bad
    const conditionData = [1, 1, 1]; 

    globalChartInstance = new Chart(ctx, {
        type: 'doughnut', // 'doughnut' looks slightly more modern than 'pie' for dashboards
        data: {
            labels: ['Good', 'Poor', 'Bad'],
            datasets: [{
                data: conditionData,
                backgroundColor: [
                    '#10b981', // Green
                    '#f59e0b', // Yellow
                    '#ef4444'  // Red
                ],
                borderWidth: 0,
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false } // We hid the default legend because we built a custom HTML one!
            },
            cutout: '60%' // Makes it a nice ring shape
        }
    });
}