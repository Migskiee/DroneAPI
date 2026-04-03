// --- GLOBAL VARIABLES ---
let globalChartInstance = null;
let detailChartInstance = null;
let liveBridgeData = []; // Will hold data from Railway

document.addEventListener('DOMContentLoaded', () => {
    // --- NAVIGATION LOGIC ---
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.content-section');

    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('data-target');

            sections.forEach(section => section.style.display = 'none');
            document.getElementById(targetId).style.display = 'block';
            
            navLinks.forEach(l => l.classList.remove('active'));
            this.classList.add('active');
        });
    });

    // --- SEARCH LOGIC ---
    document.getElementById('bridgeSearch').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const filtered = liveBridgeData.filter(bridge => 
            bridge.name.toLowerCase().includes(term) || bridge.location.toLowerCase().includes(term)
        );
        renderBridges(filtered);
    });

    // --- FETCH DATA FROM POSTGRESQL API ---
    fetchDatabaseStats();
});

async function fetchDatabaseStats() {
    try {
        const response = await fetch('/api/bridge-data');
        const data = await response.json();

        if (data.status === "success") {
            liveBridgeData = data.bridges;
            renderAnalytics(data.stats);
            renderBridges(liveBridgeData);
        } else {
            console.error("API Error:", data.message);
        }
    } catch (error) {
        console.error("Failed to connect to Railway backend:", error);
    }
}

// --- ANALYTICS DASHBOARD LOGIC ---
function renderAnalytics(stats) {
    document.getElementById('totalBridgesValue').innerText = stats.total_bridges;
    document.getElementById('totalDefectsValue').innerText = stats.total_defects;

    let high = 0, review = 0, low = 0;
    let labels = [];
    let chartData = [];
    let colors = [];

    // Parse the severity breakdown from the database
    stats.severity.forEach(item => {
        let severity = item[0] || 'Review Needed';
        let count = item[1];
        
        labels.push(severity);
        chartData.push(count);

        if (severity === 'High' || severity === 'Critical') {
            high += count;
            colors.push('#ef4444');
        } else if (severity === 'Low') {
            low += count;
            colors.push('#10b981');
        } else {
            review += count;
            colors.push('#f59e0b');
        }
    });

    document.getElementById('countHigh').innerText = high;
    document.getElementById('countReview').innerText = review;
    document.getElementById('countLow').innerText = low;

    // Draw the Global Chart
    const ctx = document.getElementById('globalConditionChart').getContext('2d');
    if (globalChartInstance) globalChartInstance.destroy();

    globalChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: chartData,
                backgroundColor: colors,
                borderWidth: 0, hoverOffset: 4
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } }, cutout: '65%' }
    });
}

// --- BRIDGES DATABASE LOGIC ---
function renderBridges(bridges) {
    const bridgeGrid = document.getElementById('bridgeGrid');
    bridgeGrid.innerHTML = ''; 
    
    bridges.forEach(bridge => {
        const card = document.createElement('div');
        card.className = 'bridge-card';
        card.onclick = () => showBridgeDetails(bridge);
        
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

function showBridgeDetails(bridge) {
    document.getElementById('bridgeListView').style.display = 'none';
    document.getElementById('bridgeDetailView').style.display = 'block';

    document.getElementById('detailName').innerText = bridge.name;
    document.getElementById('detailLocation').innerText = bridge.location;
    document.getElementById('detailId').innerText = bridge.id;

    // Parse specific bridge defect data
    let labels = [];
    let chartData = [];
    let colors = [];

    bridge.defects.forEach(item => {
        let severity = item[0] || 'Review Needed';
        let count = item[1];
        labels.push(severity);
        chartData.push(count);
        
        if (severity === 'High' || severity === 'Critical') colors.push('#ef4444');
        else if (severity === 'Low') colors.push('#10b981');
        else colors.push('#f59e0b');
    });

    const ctx = document.getElementById('defectChart').getContext('2d');
    if (detailChartInstance) detailChartInstance.destroy();

    detailChartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: labels,
            datasets: [{
                data: chartData,
                backgroundColor: colors,
                borderWidth: 1
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
}

function showBridgeList() {
    document.getElementById('bridgeListView').style.display = 'block';
    document.getElementById('bridgeDetailView').style.display = 'none';
}