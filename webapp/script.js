let globalChartInstance = null;
let detailChartInstance = null;
let liveBridgeData = []; 
let currentActiveBridge = null;

document.addEventListener('DOMContentLoaded', () => {
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

    document.getElementById('bridgeSearch').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const filtered = liveBridgeData.filter(bridge => 
            bridge.name.toLowerCase().includes(term) || bridge.location.toLowerCase().includes(term)
        );
        renderBridges(filtered);
    });

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
            
            // If we are currently looking at a bridge, refresh its view
            if(currentActiveBridge) {
                const refreshedBridge = liveBridgeData.find(b => b.db_id === currentActiveBridge.db_id);
                if(refreshedBridge) showBridgeDetails(refreshedBridge);
            }
        }
    } catch (error) {
        console.error("Failed to connect to backend:", error);
    }
}

// --- CRUD OPERATIONS ---
async function updateDefectSeverity(defectId, dropdownElement) {
    const newSeverity = dropdownElement.value;
    try {
        const response = await fetch(`/api/defects/${defectId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ severity: newSeverity })
        });
        if(response.ok) fetchDatabaseStats(); // Refresh everything
    } catch (e) {
        console.error("Update failed", e);
    }
}

async function deleteDefect(defectId) {
    if(!confirm("Are you sure you want to permanently delete this record?")) return;
    try {
        const response = await fetch(`/api/defects/${defectId}`, { method: 'DELETE' });
        if(response.ok) fetchDatabaseStats(); // Refresh everything
    } catch (e) {
        console.error("Delete failed", e);
    }
}

// --- RENDERING UI ---
function renderAnalytics(stats) {
    // ... (Keep your existing renderAnalytics code here) ...
    document.getElementById('totalBridgesValue').innerText = stats.total_bridges;
    document.getElementById('totalDefectsValue').innerText = stats.total_defects;

    let high = 0, review = 0, low = 0;
    let labels = [], chartData = [], colors = [];

    stats.severity.forEach(item => {
        let severity = item[0] || 'Review Needed';
        let count = item[1];
        labels.push(severity);
        chartData.push(count);

        if (severity === 'High' || severity === 'Critical') { high += count; colors.push('#ef4444'); }
        else if (severity === 'Low') { low += count; colors.push('#10b981'); }
        else { review += count; colors.push('#f59e0b'); }
    });

    document.getElementById('countHigh').innerText = high;
    document.getElementById('countReview').innerText = review;
    document.getElementById('countLow').innerText = low;

    const ctx = document.getElementById('globalConditionChart').getContext('2d');
    if (globalChartInstance) globalChartInstance.destroy();
    globalChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: chartData, backgroundColor: colors, borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } }, cutout: '65%' }
    });
}

function renderBridges(bridges) {
    const bridgeGrid = document.getElementById('bridgeGrid');
    bridgeGrid.innerHTML = ''; 
    bridges.forEach(bridge => {
        const card = document.createElement('div');
        card.className = 'bridge-card';
        card.onclick = () => showBridgeDetails(bridge);
        card.innerHTML = `
            <div class="bridge-info"><h3>${bridge.name}</h3><p>${bridge.location}</p></div>
            <span class="bridge-id">${bridge.id}</span>
        `;
        bridgeGrid.appendChild(card);
    });
}

function showBridgeDetails(bridge) {
    currentActiveBridge = bridge;
    document.getElementById('bridgeListView').style.display = 'none';
    document.getElementById('bridgeDetailView').style.display = 'block';

    document.getElementById('detailName').innerText = bridge.name;
    document.getElementById('detailLocation').innerText = bridge.location;
    document.getElementById('detailId').innerText = bridge.id;

    // Render Defect Chart
    let labels = [], chartData = [], colors = [];
    bridge.defects.forEach(item => {
        let severity = item[0] || 'Review Needed';
        labels.push(severity); chartData.push(item[1]);
        if (severity === 'High' || severity === 'Critical') colors.push('#ef4444');
        else if (severity === 'Low') colors.push('#10b981');
        else colors.push('#f59e0b');
    });

    const ctx = document.getElementById('defectChart').getContext('2d');
    if (detailChartInstance) detailChartInstance.destroy();
    detailChartInstance = new Chart(ctx, {
        type: 'pie',
        data: { labels: labels, datasets: [{ data: chartData, backgroundColor: colors, borderWidth: 1 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });

    // Render CRUD Image Gallery
    const galleryGrid = document.getElementById('imageGalleryGrid');
    galleryGrid.innerHTML = '';
    
    if (bridge.images.length === 0) {
        galleryGrid.innerHTML = '<p class="text-muted">No images captured for this structure yet.</p>';
        return;
    }

    bridge.images.forEach(img => {
        // Fallback if image URL is just a local filename before Cloudinary was integrated
        let imgSrc = img.url.startsWith('http') ? img.url : 'https://via.placeholder.com/300x200?text=Pending+Cloud+Upload';
        
        let dateStr = new Date(img.date).toLocaleString();
        
        const card = document.createElement('div');
        card.className = 'gallery-card';
        card.innerHTML = `
            <img src="${imgSrc}" class="gallery-img" alt="Defect">
            <div class="gallery-info">
                <p><strong>${img.span}</strong> | ${img.type}</p>
                <p class="text-muted" style="font-size: 11px;">${dateStr}</p>
                <div class="crud-controls">
                    <select class="form-control" style="width: 60%; padding: 5px; font-size: 12px;" onchange="updateDefectSeverity(${img.id}, this)">
                        <option value="Critical" ${img.severity === 'Critical' ? 'selected' : ''}>Critical</option>
                        <option value="High" ${img.severity === 'High' ? 'selected' : ''}>High</option>
                        <option value="Review Needed" ${img.severity === 'Review Needed' || !img.severity ? 'selected' : ''}>Review Needed</option>
                        <option value="Low" ${img.severity === 'Low' ? 'selected' : ''}>Low / Safe</option>
                    </select>
                    <button class="btn btn-danger" style="padding: 5px 10px; font-size: 12px;" onclick="deleteDefect(${img.id})">🗑️ Delete</button>
                </div>
            </div>
        `;
        galleryGrid.appendChild(card);
    });
}

function showBridgeList() {
    currentActiveBridge = null;
    document.getElementById('bridgeListView').style.display = 'block';
    document.getElementById('bridgeDetailView').style.display = 'none';
}