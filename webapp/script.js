let globalChartInstance = null;
let detailChartInstance = null;
let missionChartInstance = null; 
let liveBridgeData = []; 
let currentActiveBridge = null;
let currentActiveMission = null; 

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

// --- API FETCH LOGIC ---
async function fetchDatabaseStats() {
    try {
        const response = await fetch('/api/bridge-data');
        const data = await response.json();

        if (data.status === "success") {
            liveBridgeData = data.bridges;
            renderAnalytics(data.stats);
            renderBridges(liveBridgeData);
            
            if(currentActiveBridge) {
                const refreshedBridge = liveBridgeData.find(b => b.db_id === currentActiveBridge.db_id);
                if(refreshedBridge) {
                    currentActiveBridge = refreshedBridge;
                    if(currentActiveMission) {
                        showMissionDetails(currentActiveMission);
                    } else {
                        showBridgeDetails(refreshedBridge);
                    }
                }
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
            fetchDatabaseStats(); 
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
            fetchDatabaseStats(); 
        } else {
            alert("Failed to delete record.");
        }
    } catch (e) {
        console.error("Delete failed", e);
    }
}

// --- RENDERING UI: LEVEL 1 (ANALYTICS & LIST) ---
function renderAnalytics(stats) {
    document.getElementById('totalBridgesValue').innerText = stats.total_bridges;
    document.getElementById('totalDefectsValue').innerText = stats.total_defects;

    // --- CIVIL ENGINEERING HEALTH ALGORITHM ---
    let healthCounts = { 'Bad': 0, 'Poor': 0, 'Fair': 0 };

    liveBridgeData.forEach(bridge => {
        const imgs = bridge.images || [];
        if (imgs.length === 0) {
            healthCounts['Fair']++; // No defects detected = Fair/Good
            return;
        }

        // 1. Group images by mission to find the latest flight
        const missions = {};
        imgs.forEach(img => {
            const mId = img.mission_id || 0;
            if (!missions[mId]) missions[mId] = [];
            missions[mId].push(img);
        });

        const latestMissionId = Math.max(...Object.keys(missions).map(Number));
        const latestImages = missions[latestMissionId];

        // 2. Worst-Case Aggregation: Find the worst defect in the latest mission
        let bridgeHealth = 'Fair'; 
        for (let img of latestImages) {
            let sev = img.severity || 'Fair';
            if (sev === 'Bad' || sev === 'Critical') {
                bridgeHealth = 'Bad';
                break; // Max severity reached, stop checking
            } else if (sev === 'Poor' || sev === 'High') {
                bridgeHealth = 'Poor';
            }
        }
        healthCounts[bridgeHealth]++;
    });

    document.getElementById('countHigh').innerText = healthCounts['Bad'];
    document.getElementById('countReview').innerText = healthCounts['Poor'];
    document.getElementById('countLow').innerText = healthCounts['Fair'];

    const ctx = document.getElementById('globalConditionChart').getContext('2d');
    if (globalChartInstance) globalChartInstance.destroy();
    
    globalChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: { 
            labels: ['Bad (Critical)', 'Poor (Review)', 'Fair (Safe)'], 
            datasets: [{ 
                data: [healthCounts['Bad'], healthCounts['Poor'], healthCounts['Fair']], 
                backgroundColor: ['#ef4444', '#f59e0b', '#10b981'], 
                borderWidth: 0 
            }] 
        },
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
            <div class="bridge-info">
                <h3>${bridge.name}</h3>
                <p>${bridge.location}</p>
            </div>
            <span class="bridge-id">${bridge.id}</span>
        `;
        bridgeGrid.appendChild(card);
    });
}

// --- RENDERING UI: LEVEL 2 (BRIDGE DETAILS & MISSION LIST) ---
function showBridgeList() {
    currentActiveBridge = null;
    currentActiveMission = null;
    document.getElementById('bridgeListView').style.display = 'block';
    document.getElementById('bridgeDetailView').style.display = 'none';
    document.getElementById('missionDetailView').style.display = 'none';
}

function showBridgeDetails(bridge) {
    currentActiveBridge = bridge;
    currentActiveMission = null;
    document.getElementById('bridgeListView').style.display = 'none';
    document.getElementById('missionDetailView').style.display = 'none';
    document.getElementById('bridgeDetailView').style.display = 'block';

    document.getElementById('detailName').innerText = bridge.name;
    document.getElementById('detailLocation').innerText = bridge.location;
    document.getElementById('detailId').innerText = bridge.id;

    // Render Overall Chart for Bridge (Historical)
    let labels = [], chartData = [], colors = [];
    if(bridge.defects) {
        bridge.defects.forEach(item => {
            let severity = item[0] || 'Fair';
            labels.push(severity); 
            chartData.push(item[1]);
            
            if (severity === 'Bad' || severity === 'Critical') colors.push('#ef4444');
            else if (severity === 'Fair' || severity === 'Low') colors.push('#10b981');
            else colors.push('#f59e0b'); // Poor
        });
    }

    const ctx = document.getElementById('defectChart').getContext('2d');
    if (detailChartInstance) detailChartInstance.destroy();
    
    detailChartInstance = new Chart(ctx, {
        type: 'pie',
        data: { labels: labels, datasets: [{ data: chartData, backgroundColor: colors, borderWidth: 1 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });

    // Generate Mission Cards
    const imgList = bridge.images || [];
    const groupedByMission = {};
    imgList.forEach(img => {
        const mId = img.mission_id || 'Unassigned';
        if (!groupedByMission[mId]) groupedByMission[mId] = [];
        groupedByMission[mId].push(img);
    });

    const missionGrid = document.getElementById('missionListGrid');
    missionGrid.innerHTML = '';

    if (Object.keys(groupedByMission).length === 0) {
        missionGrid.innerHTML = '<p class="text-muted" style="grid-column: 1 / -1;">No flight missions logged for this bridge yet.</p>';
        return;
    }

    const sortedMissions = Object.keys(groupedByMission).sort((a,b) => b - a);

    sortedMissions.forEach(mId => {
        const mImgs = groupedByMission[mId];
        const label = mId === 'Unassigned' ? 'Unassigned Captures' : `Mission #${mId}`;
        const dateStr = mImgs[0] && (mImgs[0].date || mImgs[0].captured_at) 
            ? new Date(mImgs[0].date || mImgs[0].captured_at).toLocaleDateString() 
            : 'Recent';

        const urgentCount = mImgs.filter(i => i.severity === 'Bad' || i.severity === 'Critical').length;
        const urgentBadge = urgentCount > 0 ? `<span style="color:#ef4444; font-size:12px; display:block; margin-top:3px;">⚠️ ${urgentCount} Bad Condition Issues</span>` : '';

        const card = document.createElement('div');
        card.className = 'mission-card';
        card.onclick = () => showMissionDetails(mId);
        card.innerHTML = `
            <div>
                <div class="mission-card-title">🚁 ${label}</div>
                <div class="mission-card-subtitle">Flight Date: ${dateStr}</div>
                ${urgentBadge}
            </div>
            <div class="mission-card-stats">
                ${mImgs.length} Images
            </div>
        `;
        missionGrid.appendChild(card);
    });
}

// --- RENDERING UI: LEVEL 3 (SPECIFIC MISSION DETAILS) ---
function backToBridgeDetails() {
    if(currentActiveBridge) showBridgeDetails(currentActiveBridge);
}

function showMissionDetails(missionId) {
    currentActiveMission = missionId;
    document.getElementById('bridgeDetailView').style.display = 'none';
    document.getElementById('missionDetailView').style.display = 'block';

    const missionLabel = missionId === 'Unassigned' ? 'Unassigned Captures' : `Flight Mission #${missionId}`;
    document.getElementById('missionDetailTitle').innerText = missionLabel;

    const allImages = currentActiveBridge.images || [];
    const missionImages = allImages.filter(img => String(img.mission_id || 'Unassigned') === String(missionId));

    document.getElementById('missionDetailSubtitle').innerText = `${missionImages.length} Data points captured for ${currentActiveBridge.name}`;

    let severityCounts = { 'Bad':0, 'Poor':0, 'Fair':0 };
    missionImages.forEach(img => {
        let s = img.severity || 'Fair';
        if (s === 'Critical') s = 'Bad'; // Backwards compatibility for old records
        if (severityCounts[s] !== undefined) severityCounts[s]++;
        else severityCounts['Poor']++; 
    });

    let labels = [], chartData = [], colors = [];
    for (const [sev, count] of Object.entries(severityCounts)) {
        if(count > 0) {
            labels.push(sev);
            chartData.push(count);
            if (sev === 'Bad') colors.push('#ef4444');
            else if (sev === 'Fair') colors.push('#10b981');
            else colors.push('#f59e0b');
        }
    }

    const ctx = document.getElementById('missionDefectChart').getContext('2d');
    if (missionChartInstance) missionChartInstance.destroy();
    
    missionChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: chartData, backgroundColor: colors, borderWidth: 1 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } }, cutout: '50%' }
    });

    document.getElementById('filterType').value = 'all'; 
    applyGalleryFilters();
}

function applyGalleryFilters() {
    if (!currentActiveBridge || !currentActiveMission) return;

    const allImages = currentActiveBridge.images || [];
    const missionImages = allImages.filter(img => String(img.mission_id || 'Unassigned') === String(currentActiveMission));

    const selectedType = document.getElementById('filterType').value.toLowerCase();

    const filteredImages = missionImages.filter(img => {
        const imgType = (img.defect_type || img.type || 'Unknown').toLowerCase();
        return selectedType === 'all' || imgType.includes(selectedType);
    });

    renderImageGallery(filteredImages);
}

function renderImageGallery(images) {
    const container = document.getElementById('galleryContainer');
    container.innerHTML = '';
    
    if (!images || images.length === 0) {
        container.innerHTML = '<p class="text-muted" style="padding: 20px; background: #fff; border-radius: 8px;">No images match your current filter.</p>';
        return;
    }

    const groupedBySpan = {};
    images.forEach(img => {
        const span = img.span_target || img.span || 'Unknown Span';
        if (!groupedBySpan[span]) groupedBySpan[span] = [];
        groupedBySpan[span].push(img);
    });

    const sortedSpans = Object.keys(groupedBySpan).sort((a, b) => {
        const numA = parseInt(a.replace(/[^\d]/g, '')) || 0;
        const numB = parseInt(b.replace(/[^\d]/g, '')) || 0;
        return numA - numB;
    });

    sortedSpans.forEach(span => {
        const spanImages = groupedBySpan[span];
        
        const spanGroup = document.createElement('div');
        spanGroup.className = 'span-group';
        
        const spanTitle = document.createElement('h4');
        spanTitle.className = 'span-group-title';
        spanTitle.innerHTML = `📍 ${span} <span class="badge badge-online" style="margin-left:10px; background:#e2e8f0; color:#475569;">${spanImages.length} Photos</span>`;
        spanGroup.appendChild(spanTitle);

        const grid = document.createElement('div');
        grid.className = 'image-gallery-grid';

        spanImages.forEach(img => {
            const rawUrl = img.image_url || img.url || '';
            const imgSrc = rawUrl.startsWith('http') ? rawUrl : 'https://via.placeholder.com/300x200?text=No+Image+Available';
            const defectType = img.defect_type || img.type || 'Unknown Defect';
            
            // Upgrade backwards compatibility for older tests
            let defectSeverity = img.severity || 'Fair';
            if (defectSeverity === 'Critical' || defectSeverity === 'High') defectSeverity = 'Bad';
            if (defectSeverity === 'Review Needed') defectSeverity = 'Poor';
            if (defectSeverity === 'Low') defectSeverity = 'Fair';
            
            const defectId = img.id || img.defect_id;
            
            let dateStr = 'Recent Capture';
            if (img.date || img.created_at || img.captured_at) {
                dateStr = new Date(img.date || img.created_at || img.captured_at).toLocaleString();
            }
            
            const card = document.createElement('div');
            card.className = 'gallery-card';
            card.innerHTML = `
                <img src="${imgSrc}" class="gallery-img" alt="Defect">
                <div class="gallery-info">
                    <p style="font-size: 14px; margin-bottom: 6px;">
                        <strong style="color: #dc2626;">🚨 Defect:</strong> <strong>${defectType}</strong>
                    </p>
                    <p class="text-muted" style="font-size: 11px; margin-bottom: 12px;">🕒 Captured: ${dateStr}</p>
                    
                    <div class="crud-controls">
                        <select class="form-control" style="width: 60%; padding: 5px; font-size: 12px;" onchange="updateDefectSeverity(${defectId}, this)">
                            <option value="Bad" ${defectSeverity === 'Bad' ? 'selected' : ''}>Bad</option>
                            <option value="Poor" ${defectSeverity === 'Poor' ? 'selected' : ''}>Poor</option>
                            <option value="Fair" ${defectSeverity === 'Fair' ? 'selected' : ''}>Fair</option>
                        </select>
                        <button class=\"btn btn-danger\" style=\"padding: 5px 10px; font-size: 12px;\" onclick=\"deleteDefect(${defectId})\">🗑️ Delete</button>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });

        spanGroup.appendChild(grid);
        container.appendChild(spanGroup);
    });
}