// --- GLOBAL VARIABLES ---
let globalChartInstance = null;
let detailChartInstance = null;
let liveBridgeData = []; 
let currentActiveBridge = null;

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

    // Fetch initial data when the page loads
    fetchDatabaseStats();
});

// --- API FETCH LOGIC ---
async function fetchDatabaseStats() {
    try {
        const response = await fetch('/api/bridge-data');
        const data = await response.json();

        if (data.status === "success") {
            liveBridgeData = data.bridges;
            renderAnalytics(data.stats);
            renderBridges(liveBridgeData);
            
            // If the user is currently looking at a specific bridge, refresh its details dynamically
            if(currentActiveBridge) {
                const refreshedBridge = liveBridgeData.find(b => b.db_id === currentActiveBridge.db_id);
                if(refreshedBridge) showBridgeDetails(refreshedBridge);
            }
        } else {
            console.error("API Error:", data.message);
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
        
        if(response.ok) {
            fetchDatabaseStats(); // Refresh the charts and gallery with the new data
        } else {
            alert("Failed to update severity.");
        }
    } catch (e) {
        console.error("Update failed", e);
    }
}

async function deleteDefect(defectId) {
    if(!confirm("Are you sure you want to permanently delete this record?")) return;
    
    try {
        const response = await fetch(`/api/defects/${defectId}`, { 
            method: 'DELETE' 
        });
        
        if(response.ok) {
            fetchDatabaseStats(); // Refresh the UI after deletion
        } else {
            alert("Failed to delete record.");
        }
    } catch (e) {
        console.error("Delete failed", e);
    }
}

// --- RENDERING UI ---
function renderAnalytics(stats) {
    document.getElementById('totalBridgesValue').innerText = stats.total_bridges;
    document.getElementById('totalDefectsValue').innerText = stats.total_defects;

    let high = 0, review = 0, low = 0;
    let labels = [], chartData = [], colors = [];

    stats.severity.forEach(item => {
        let severity = item[0] || 'Review Needed';
        let count = item[1];
        
        labels.push(severity);
        chartData.push(count);

        if (severity === 'High' || severity === 'Critical') { 
            high += count; 
            colors.push('#ef4444'); 
        }
        else if (severity === 'Low') { 
            low += count; 
            colors.push('#10b981'); 
        }
        else { 
            review += count; 
            colors.push('#f59e0b'); 
        }
    });

    document.getElementById('countHigh').innerText = high;
    document.getElementById('countReview').innerText = review;
    document.getElementById('countLow').innerText = low;

    const ctx = document.getElementById('globalConditionChart').getContext('2d');
    if (globalChartInstance) globalChartInstance.destroy();
    
    globalChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: { 
            labels: labels, 
            datasets: [{ data: chartData, backgroundColor: colors, borderWidth: 0 }] 
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false, 
            plugins: { legend: { position: 'right' } }, 
            cutout: '65%' 
        }
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
    currentActiveBridge = bridge;
    document.getElementById('bridgeListView').style.display = 'none';
    document.getElementById('bridgeDetailView').style.display = 'block';

    document.getElementById('detailName').innerText = bridge.name;
    document.getElementById('detailLocation').innerText = bridge.location;
    document.getElementById('detailId').innerText = bridge.id;

    // 1. Render Defect Chart for this specific bridge
    let labels = [], chartData = [], colors = [];
    bridge.defects.forEach(item => {
        let severity = item[0] || 'Review Needed';
        labels.push(severity); 
        chartData.push(item[1]);
        
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

    // 2. Draw the Gallery (automatically defaults to showing all types)
    document.getElementById('filterType').value = 'all';
    applyGalleryFilters();
}

function showBridgeList() {
    currentActiveBridge = null;
    document.getElementById('bridgeListView').style.display = 'block';
    document.getElementById('bridgeDetailView').style.display = 'none';
}

// --- DYNAMIC MISSION AND SPAN GROUPING LOGIC ---
function applyGalleryFilters() {
    if (!currentActiveBridge || !currentActiveBridge.images) return;

    const selectedType = document.getElementById('filterType').value;

    // Filter images based on the explicit Defect Type dropdown
    const filteredImages = currentActiveBridge.images.filter(img => {
        return selectedType === 'all' || img.type === selectedType;
    });

    renderImageGallery(filteredImages);
}

function renderImageGallery(images) {
    const container = document.getElementById('galleryContainer');
    container.innerHTML = '';
    
    if (!images || images.length === 0) {
        container.innerHTML = '<p class="text-muted">No images match your current filters.</p>';
        return;
    }

    // 1. Group the filtered images by MISSION ID First
    const groupedByMission = {};
    images.forEach(img => {
        const mId = img.mission_id || 'Unassigned';
        if (!groupedByMission[mId]) groupedByMission[mId] = [];
        groupedByMission[mId].push(img);
    });

    // 2. Sort missions (newest first)
    const sortedMissions = Object.keys(groupedByMission).sort((a,b) => b - a);

    // 3. Loop through every Mission to build its container
    sortedMissions.forEach(mission => {
        const missionImages = groupedByMission[mission];
        
        // Create the Mission wrapper
        const missionDiv = document.createElement('div');
        missionDiv.className = 'mission-group';
        
        // Create the Mission Header
        const missionHeader = document.createElement('h3');
        missionHeader.className = 'mission-header';
        const missionLabel = mission === 'Unassigned' ? 'Unassigned Captures' : `Flight Mission #${mission}`;
        missionHeader.innerHTML = `🚁 ${missionLabel} <span class="badge badge-online" style="margin-left:10px;">${missionImages.length} Captures</span>`;
        missionDiv.appendChild(missionHeader);

        // --- SUB-GROUPING: Now group by Span inside this Mission ---
        const groupedBySpan = {};
        missionImages.forEach(img => {
            const span = img.span || 'Unknown Span';
            if (!groupedBySpan[span]) groupedBySpan[span] = [];
            groupedBySpan[span].push(img);
        });

        // Sort spans naturally (Span 1, Span 2...)
        const sortedSpans = Object.keys(groupedBySpan).sort((a, b) => {
            const numA = parseInt(a.replace(/[^\d]/g, '')) || 0;
            const numB = parseInt(b.replace(/[^\d]/g, '')) || 0;
            return numA - numB;
        });

        // Render each Span Grid inside the Mission Div
        sortedSpans.forEach(span => {
            const spanImages = groupedBySpan[span];
            
            const spanGroup = document.createElement('div');
            spanGroup.className = 'span-group';
            
            const spanTitle = document.createElement('h4');
            spanTitle.className = 'span-group-title';
            spanTitle.innerHTML = `📍 ${span}`;
            spanGroup.appendChild(spanTitle);

            const grid = document.createElement('div');
            grid.className = 'image-gallery-grid';

            spanImages.forEach(img => {
                let imgSrc = (img.url && img.url.startsWith('http')) ? img.url : 'https://via.placeholder.com/300x200?text=No+Image+Available';
                let dateStr = new Date(img.date).toLocaleString();
                
                const card = document.createElement('div');
                card.className = 'gallery-card';
                card.innerHTML = `
                    <img src="${imgSrc}" class="gallery-img" alt="Defect">
                    <div class="gallery-info">
                        <p style="font-size: 14px; margin-bottom: 6px;">
                            <strong style="color: #dc2626;">🚨 Defect:</strong> <strong>${img.type}</strong>
                        </p>
                        <p class="text-muted" style="font-size: 11px; margin-bottom: 12px;">🕒 Captured: ${dateStr}</p>
                        
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
                grid.appendChild(card);
            });

            spanGroup.appendChild(grid);
            missionDiv.appendChild(spanGroup);
        });

        // Finally, add the fully constructed Mission Div to the page
        container.appendChild(missionDiv);
    });
}