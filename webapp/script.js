let globalChartInstance = null;
let detailChartInstance = null;
let missionChartInstance = null; 
let liveBridgeData = []; 
let currentActiveBridge = null;
let currentActiveMission = null; 
let isFlightActive = false;
let liveCaptureInterval = null;

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

    document.getElementById('flightBridgeSelect').addEventListener('change', function() {
        const db_id = parseInt(this.value);
        const bridge = liveBridgeData.find(b => b.db_id === db_id);
        const container = document.getElementById('dynamicSpanContainer');
        container.innerHTML = '';
        
        if(bridge && bridge.span_count > 0) {
            for(let i = 1; i <= bridge.span_count; i++) {
                const btn = document.createElement('button');
                btn.className = `span-btn ${i === 1 ? 'active' : ''}`;
                btn.innerText = `Span ${i}`;
                btn.onclick = function() { setFlightSpan(`Span ${i}`, this); };
                container.appendChild(btn);
            }
            document.getElementById('flightSpanInput').value = 'Span 1';
        } else {
            container.innerHTML = '<p class="text-muted" style="font-size: 12px; margin-top: 5px;">No spans configured.</p>';
            document.getElementById('flightSpanInput').value = '';
        }
    });

    fetchDatabaseStats();
});

// --- NEW: LIGHTBOX PREVIEW LOGIC ---
function openImagePreview(url) {
    const modal = document.getElementById('imagePreviewModal');
    const img = document.getElementById('previewImageSrc');
    img.src = url;
    modal.style.display = 'flex';
}

function closeImagePreview() {
    document.getElementById('imagePreviewModal').style.display = 'none';
    document.getElementById('previewImageSrc').src = '';
}

// --- CORE DATA FETCHING ---
async function fetchDatabaseStats() {
    try {
        const response = await fetch('/api/bridge-data');
        const data = await response.json();

        if (data.status === "success") {
            liveBridgeData = data.bridges;
            renderAnalytics(data.stats);
            renderBridges(liveBridgeData);
            populateFlightDropdown();
            
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
        }
    } catch (error) { console.error("Failed to connect to backend:", error); }
}

function getBridgeHealth(bridge) {
    if (!bridge.missions || bridge.missions.length === 0) return 'Fair';
    const latestMissionId = bridge.missions[0].id;
    const images = bridge.images || [];
    const latestImages = images.filter(img => img.mission_id === latestMissionId);
    
    if (latestImages.length === 0) return 'Fair';
    
    let health = 'Fair';
    for (let img of latestImages) {
        let sev = img.severity || 'Fair';
        let defType = (img.defect_type || img.type || '').toLowerCase();
        let isMajor = defType.includes('crack') || defType.includes('rebar');

        if (sev === 'Bad' || sev === 'Critical' || sev === 'High') {
            if (isMajor) { health = 'Bad'; break; }
            else if (health !== 'Bad') health = 'Poor';
        } else if (sev === 'Poor' || sev === 'Review Needed') {
            if (health !== 'Bad') health = 'Poor';
        }
    }
    return health;
}

// --- ADD/EDIT BRIDGE LOGIC ---
function openBridgeModal(db_id = null) {
    const modal = document.getElementById('bridgeModal');
    const title = document.getElementById('bridgeModalTitle');
    
    if (db_id) {
        title.innerText = 'Edit Bridge Parameters';
        const bridge = liveBridgeData.find(b => b.db_id === db_id);
        document.getElementById('modalBridgeId').value = bridge.db_id;
        document.getElementById('modalBridgeCode').value = bridge.id; 
        document.getElementById('modalBridgeName').value = bridge.name;
        document.getElementById('modalBridgeLocation').value = bridge.location;
        document.getElementById('modalBridgeRemarks').value = bridge.remarks || '';
        document.getElementById('modalBridgeSpanCount').value = bridge.span_count || 1;
    } else {
        title.innerText = 'Add New Bridge';
        document.getElementById('modalBridgeId').value = '';
        document.getElementById('modalBridgeCode').value = '';
        document.getElementById('modalBridgeName').value = '';
        document.getElementById('modalBridgeLocation').value = '';
        document.getElementById('modalBridgeRemarks').value = '';
        document.getElementById('modalBridgeSpanCount').value = 1;
    }
    modal.style.display = 'flex';
}

function closeBridgeModal() {
    document.getElementById('bridgeModal').style.display = 'none';
}

async function saveBridge() {
    const db_id = document.getElementById('modalBridgeId').value;
    const payload = {
        bridge_code: document.getElementById('modalBridgeCode').value,
        name: document.getElementById('modalBridgeName').value,
        location: document.getElementById('modalBridgeLocation').value,
        remarks: document.getElementById('modalBridgeRemarks').value,
        span_count: parseInt(document.getElementById('modalBridgeSpanCount').value) || 1
    };

    if(!payload.bridge_code || !payload.name) return alert("Bridge Code and Name are required!");

    const method = db_id ? 'PUT' : 'POST';
    const url = db_id ? `/api/bridges/${db_id}` : '/api/bridges';

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.status === 'success') {
            closeBridgeModal();
            fetchDatabaseStats(); 
        } else alert('Database update failed.');
    } catch (error) { console.error("Network Error:", error); }
}

async function updateDefectSeverity(defectId, dropdownElement) {
    const newSeverity = dropdownElement.value;
    try {
        const response = await fetch(`/api/defects/${defectId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ severity: newSeverity })
        });
        if(response.ok) fetchDatabaseStats(); 
    } catch (e) { console.error("Update failed", e); }
}

async function deleteDefect(defectId) {
    if(!confirm("Are you sure you want to permanently delete this record?")) return;
    try {
        const response = await fetch(`/api/defects/${defectId}`, { method: 'DELETE' });
        if(response.ok) fetchDatabaseStats(); 
    } catch (e) { console.error("Delete failed", e); }
}

async function saveBridgeRemarks() {
    if (!currentActiveBridge) return;
    const newRemarks = document.getElementById('bridgeRemarks').value;
    const btn = document.querySelector('.remarks-section .btn-primary');
    btn.innerText = "Saving...";
    
    try {
        const response = await fetch(`/api/bridges/${currentActiveBridge.db_id}/remarks`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ remarks: newRemarks })
        });
        
        if(response.ok) {
            btn.innerText = "✅ Saved Successfully!";
            fetchDatabaseStats(); 
            setTimeout(() => { btn.innerText = "💾 Save Remarks"; }, 2000);
        }
    } catch (e) {
        console.error("Save failed", e);
        btn.innerText = "💾 Save Remarks";
    }
}

function renderAnalytics(stats) {
    document.getElementById('totalBridgesValue').innerText = stats.total_bridges;
    document.getElementById('totalDefectsValue').innerText = stats.total_defects;

    let healthCounts = { 'Bad': 0, 'Poor': 0, 'Fair': 0 };

    liveBridgeData.forEach(bridge => {
        healthCounts[getBridgeHealth(bridge)]++;
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
        let bridgeHealth = getBridgeHealth(bridge);

        let badgeClass = 'badge-fair'; let badgeText = 'Fair';
        if (bridgeHealth === 'Bad') { badgeClass = 'badge-bad'; badgeText = 'Bad'; } 
        else if (bridgeHealth === 'Poor') { badgeClass = 'badge-poor'; badgeText = 'Poor'; }

        const card = document.createElement('div');
        card.className = 'bridge-card';
        card.onclick = () => showBridgeDetails(bridge);
        card.innerHTML = `
            <div class="bridge-info">
                <h3>${bridge.name} <span class="health-badge ${badgeClass}">${badgeText}</span></h3>
                <p>${bridge.location}</p>
            </div>
            <div style="display: flex; align-items: center; gap: 15px;">
                <span class="bridge-id">${bridge.id}</span>
                <button class="btn-edit" onclick="event.stopPropagation(); openBridgeModal(${bridge.db_id})">✏️ Edit</button>
            </div>
        `;
        bridgeGrid.appendChild(card);
    });
}

function showBridgeList() {
    currentActiveBridge = null; currentActiveMission = null;
    document.getElementById('bridgeListView').style.display = 'block';
    document.getElementById('bridgeDetailView').style.display = 'none';
    document.getElementById('missionDetailView').style.display = 'none';
}

function showBridgeDetails(bridge) {
    currentActiveBridge = bridge; currentActiveMission = null;
    document.getElementById('bridgeListView').style.display = 'none';
    document.getElementById('missionDetailView').style.display = 'none';
    document.getElementById('bridgeDetailView').style.display = 'block';

    document.getElementById('detailName').innerText = bridge.name;
    document.getElementById('detailLocation').innerText = bridge.location;
    document.getElementById('detailId').innerText = bridge.id;

    let bridgeHealth = getBridgeHealth(bridge); 

    const badge = document.getElementById('bridgeConditionBadge');
    if (bridgeHealth === 'Bad') {
        badge.className = 'status-badge status-bad';
        badge.innerHTML = '🚨 Condition: BAD (Critical)';
        document.getElementById('bridgeRemarks').value = bridge.remarks || "CRITICAL CONDITION: Major structural anomalies detected.";
    } else if (bridgeHealth === 'Poor') {
        badge.className = 'status-badge status-poor';
        badge.innerHTML = '⚠️ Condition: POOR (Monitor)';
        document.getElementById('bridgeRemarks').value = bridge.remarks || "MODERATE DETERIORATION: Continue monitoring required.";
    } else {
        badge.className = 'status-badge status-fair';
        badge.innerHTML = '✅ Condition: FAIR (Safe)';
        document.getElementById('bridgeRemarks').value = bridge.remarks || "SAFE CONDITION: Structure displaying normal wear.";
    }

    let latestMissionIdLabel = 'Unknown';
    let severityCounts = { 'Bad': 0, 'Poor': 0, 'Fair': 0 };
    
    if (bridge.missions && bridge.missions.length > 0) {
        const latestMissionId = bridge.missions[0].id;
        latestMissionIdLabel = latestMissionId;
        const latestImages = (bridge.images || []).filter(img => img.mission_id === latestMissionId);
        
        latestImages.forEach(img => {
            let severity = img.severity || 'Fair';
            if (severity === 'Bad' || severity === 'Critical' || severity === 'High') severityCounts['Bad']++;
            else if (severity === 'Poor' || severity === 'Review Needed') severityCounts['Poor']++;
            else severityCounts['Fair']++; 
        });
    }

    const descElement = document.getElementById('latestMissionChartDesc');
    if(descElement) descElement.innerText = (bridge.missions && bridge.missions.length > 0) ? `Defect breakdown from the most recent flight (Mission #${latestMissionIdLabel}).` : `No flight data available.`;

    let labels = [], chartData = [], colors = [];
    for (const [sev, count] of Object.entries(severityCounts)) {
        if(count > 0) {
            labels.push(sev); chartData.push(count);
            if (sev === 'Bad') colors.push('#ef4444');
            else if (sev === 'Fair') colors.push('#10b981');
            else colors.push('#f59e0b'); 
        }
    }

    const ctx = document.getElementById('defectChart').getContext('2d');
    if (detailChartInstance) detailChartInstance.destroy();
    detailChartInstance = new Chart(ctx, {
        type: 'pie',
        data: { labels: labels, datasets: [{ data: chartData, backgroundColor: colors, borderWidth: 1 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });

    const missionGrid = document.getElementById('missionListGrid');
    missionGrid.innerHTML = '';
    
    if (!bridge.missions || bridge.missions.length === 0) {
        missionGrid.innerHTML = '<p class="text-muted" style="grid-column: 1 / -1;">No flight missions logged for this bridge yet.</p>';
        return;
    }

    const groupedByMission = {};
    (bridge.images || []).forEach(img => {
        const mId = img.mission_id || 'Unassigned';
        if (!groupedByMission[mId]) groupedByMission[mId] = [];
        groupedByMission[mId].push(img);
    });

    bridge.missions.forEach(mission => {
        const mId = mission.id;
        const mImgs = groupedByMission[mId] || [];
        const label = `Mission #${mId}`;
        
        const urgentCount = mImgs.filter(i => i.severity === 'Bad' || i.severity === 'Critical' || i.severity === 'High').length;
        let urgentBadge = '';
        
        if (urgentCount > 0) {
            urgentBadge = `<span style="color:#ef4444; font-size:12px; display:block; margin-top:3px;">⚠️ ${urgentCount} Bad Condition Issues</span>`;
        } else if (mImgs.length === 0) {
            urgentBadge = `<span style="color:#10b981; font-size:12px; display:block; margin-top:3px;">✅ No Defects Detected</span>`;
        }

        const card = document.createElement('div');
        card.className = 'mission-card';
        card.onclick = () => showMissionDetails(mId);
        card.innerHTML = `
            <div><div class="mission-card-title">🚁 ${label}</div><div class="mission-card-subtitle">Status: ${mission.status}</div>${urgentBadge}</div>
            <div class="mission-card-stats">${mImgs.length} Images</div>
        `;
        missionGrid.appendChild(card);
    });
}

function backToBridgeDetails() { if(currentActiveBridge) showBridgeDetails(currentActiveBridge); }

function showMissionDetails(missionId) {
    currentActiveMission = missionId;
    document.getElementById('bridgeDetailView').style.display = 'none';
    document.getElementById('missionDetailView').style.display = 'block';

    const missionLabel = `Flight Mission #${missionId}`;
    document.getElementById('missionDetailTitle').innerText = missionLabel;

    const allImages = currentActiveBridge.images || [];
    const missionImages = allImages.filter(img => String(img.mission_id) === String(missionId));
    
    if(missionImages.length === 0) {
         document.getElementById('missionDetailSubtitle').innerText = `✅ Clean Inspection: No structural defects detected during this mission.`;
    } else {
         document.getElementById('missionDetailSubtitle').innerText = `${missionImages.length} Data points captured for ${currentActiveBridge.name}`;
    }

    let severityCounts = { 'Bad':0, 'Poor':0, 'Fair':0 };
    missionImages.forEach(img => {
        let s = img.severity || 'Fair';
        if (s === 'Critical' || s === 'High' || s === 'Bad') severityCounts['Bad']++;
        else if (s === 'Review Needed' || s === 'Poor') severityCounts['Poor']++;
        else severityCounts['Fair']++; 
    });

    let labels = [], chartData = [], colors = [];
    for (const [sev, count] of Object.entries(severityCounts)) {
        if(count > 0) {
            labels.push(sev); chartData.push(count);
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
    const missionImages = allImages.filter(img => String(img.mission_id) === String(currentActiveMission));
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
        container.innerHTML = '<p class="text-muted" style="padding: 20px; background: #fff; border-radius: 8px;">✅ Mission completely clean. No defects to display.</p>';
        return;
    }

    const groupedBySpan = {};
    images.forEach(img => {
        const span = img.span_target || img.span || 'Unknown Span';
        if (!groupedBySpan[span]) groupedBySpan[span] = [];
        groupedBySpan[span].push(img);
    });

    const sortedSpans = Object.keys(groupedBySpan).sort((a, b) => parseInt(a.replace(/[^\d]/g, '')) - parseInt(b.replace(/[^\d]/g, '')));

    sortedSpans.forEach(span => {
        const spanImages = groupedBySpan[span];
        const spanGroup = document.createElement('div');
        spanGroup.className = 'span-group';
        spanGroup.innerHTML = `<h4 class="span-group-title">📍 ${span} <span class="badge badge-online" style="margin-left:10px; background:#e2e8f0; color:#475569;">${spanImages.length} Photos</span></h4>`;
        const grid = document.createElement('div');
        grid.className = 'image-gallery-grid';

        spanImages.forEach(img => {
            const rawUrl = img.image_url || img.url || '';
            const imgSrc = rawUrl.startsWith('http') ? rawUrl : 'https://via.placeholder.com/300x200?text=No+Image+Available';
            const defectType = img.defect_type || img.type || 'Unknown Defect';
            let defectSeverity = img.severity || 'Fair';
            if (defectSeverity === 'Critical' || defectSeverity === 'High') defectSeverity = 'Bad';
            if (defectSeverity === 'Review Needed') defectSeverity = 'Poor';
            const dateStr = img.date || img.created_at || img.captured_at ? new Date(img.date || img.created_at || img.captured_at).toLocaleString() : 'Recent Capture';
            
            const card = document.createElement('div');
            card.className = 'gallery-card';
            // Click to Preview
            card.innerHTML = `
                <img src="${imgSrc}" class="gallery-img" alt="Defect" onclick="openImagePreview('${imgSrc}')" style="cursor: pointer;">
                <div class="gallery-info">
                    <p style="font-size: 14px; margin-bottom: 6px;"><strong style="color: #dc2626;">🚨 Defect:</strong> <strong>${defectType}</strong></p>
                    <p class="text-muted" style="font-size: 11px; margin-bottom: 12px;">🕒 Captured: ${dateStr}</p>
                    <div class="crud-controls">
                        <select class="form-control" style="width: 60%; padding: 5px; font-size: 12px;" onchange="updateDefectSeverity(${img.id || img.defect_id}, this)">
                            <option value="Bad" ${defectSeverity === 'Bad' ? 'selected' : ''}>Bad</option>
                            <option value="Poor" ${defectSeverity === 'Poor' ? 'selected' : ''}>Poor</option>
                            <option value="Fair" ${defectSeverity === 'Fair' ? 'selected' : ''}>Fair</option>
                        </select>
                        <button class="btn btn-danger" style="padding: 5px 10px; font-size: 12px;" onclick="deleteDefect(${img.id || img.defect_id})">🗑️ Delete</button>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });
        spanGroup.appendChild(grid);
        container.appendChild(spanGroup);
    });
}

// --- NEW: STREAM CONNECTION LOGIC ---
document.addEventListener('DOMContentLoaded', () => {
    const streamImg = document.getElementById('liveVideoStream');
    const offlineOverlay = document.getElementById('offlineOverlay');

    if (streamImg) {
        // If the stream breaks or server disconnects, show OFFLINE
        streamImg.onerror = function() {
            this.style.display = 'none';
            offlineOverlay.style.display = 'flex';
            logToTerminal(`> WARNING: Video stream connection lost.`, '#EF4444');
        };
        
        // If the stream reconnects, hide OFFLINE
        streamImg.onload = function() {
            this.style.display = 'block';
            offlineOverlay.style.display = 'none';
        };
    }
});

// Function attached to the "Retry Connection" button
window.retryStream = function() {
    const streamImg = document.getElementById('liveVideoStream');
    const offlineOverlay = document.getElementById('offlineOverlay');
    
    logToTerminal(`> Attempting to re-establish video link...`, '#FACC15');
    offlineOverlay.style.display = 'none'; 
    streamImg.style.display = 'block';
    
    // Force the browser to bypass cache and try loading the stream again
    streamImg.src = "/video_feed?t=" + new Date().getTime();
};

// ==========================================
// LIVE FLIGHT GCS LOGIC
// ==========================================
function populateFlightDropdown() {
    const select = document.getElementById('flightBridgeSelect');
    select.innerHTML = '<option value="" disabled selected>-- Select Target Bridge --</option>';
    liveBridgeData.forEach(bridge => {
        const option = document.createElement('option');
        option.value = bridge.db_id;
        option.text = `${bridge.id} - ${bridge.name}`;
        select.appendChild(option);
    });
}

function logToTerminal(msg, color="#38BDF8") {
    const terminal = document.getElementById('flightLogTerminal');
    const time = new Date().toLocaleTimeString();
    terminal.innerHTML += `<span style="color:${color}">[${time}] ${msg}</span><br>`;
    terminal.scrollTop = terminal.scrollHeight;
}

function setFlightSpan(span, btnElement) {
    if(isFlightActive) return alert("Cannot change span while mission is active!");
    document.getElementById('flightSpanInput').value = span;
    document.querySelectorAll('.span-btn').forEach(b => b.classList.remove('active'));
    btnElement.classList.add('active');
    logToTerminal(`> Target Zone set to: ${span}`, '#38BDF8');
}

async function fetchLiveCaptures() {
    if (!currentActiveMission) return;
    try {
        const gallery = document.getElementById('liveCaptureGallery');
        
        if (isFlightActive) {
            const res = await fetch(`/api/mission/${currentActiveMission}/live_frames`);
            const data = await res.json();
            if (data.status === 'success' && data.frames.length > 0) {
                // Ensure latest frames are shown and clickable!
                gallery.innerHTML = data.frames.map(f => `
                    <div class="live-capture-card" onclick="openImagePreview('${f.url}')">
                        <span class="health-badge badge-fair" style="position: absolute; top: 5px; right: 5px;">Raw Frame</span>
                        <img src="${f.url}" alt="Raw Capture">
                        <div class="live-capture-info">Auto-Capture</div>
                    </div>
                `).join('');
                
                // Auto-scroll gallery to right to see newest images
                gallery.scrollLeft = gallery.scrollWidth;
            }
        } else {
            const res = await fetch(`/api/mission/${currentActiveMission}/captures`);
            const data = await res.json();
            
            if (data.status === 'success') {
                if (data.captures.length > 0) {
                    gallery.innerHTML = data.captures.map(c => `
                        <div class="live-capture-card" onclick="openImagePreview('${c.image_url}')">
                            <span class="health-badge ${c.severity.toLowerCase() === 'bad' ? 'badge-bad' : c.severity.toLowerCase() === 'poor' ? 'badge-poor' : 'badge-fair'}" style="position: absolute; top: 5px; right: 5px;">${c.severity}</span>
                            <img src="${c.image_url}" alt="Defect">
                            <div class="live-capture-info">${c.defect_type}</div>
                        </div>
                    `).join('');
                }
            }
        }
    } catch(e) { console.error("Capture sync error:", e); }
}

async function toggleFlightMission() {
    const btn = document.getElementById('toggleMissionBtn');
    const bridgeSelect = document.getElementById('flightBridgeSelect');
    const spanInput = document.getElementById('flightSpanInput');
    
    const progressContainer = document.getElementById('aiProgressBarContainer');
    const progressBar = document.getElementById('aiProgressBar');
    const progressText = document.getElementById('aiProgressText');

    if (!isFlightActive) {
        // --- START MISSION ---
        const bridgeId = parseInt(bridgeSelect.value);
        if(isNaN(bridgeId)) return alert("Please select a target bridge from the dropdown.");
        if(!spanInput.value) return alert("Please select a target span.");

        try {
            const res = await fetch('/api/mission/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bridge_id: bridgeId, span_target: spanInput.value })
            });
            const data = await res.json();
            
            if(data.status === "success") {
                isFlightActive = true;
                currentActiveMission = data.mission_id;
                bridgeSelect.disabled = true;
                
                btn.innerHTML = '🛑 END MISSION & RUN AI';
                btn.style.background = '#EF4444';
                logToTerminal(`> MISSION #${data.mission_id} INITIATED. Auto-Capture ARMED.`, '#22C55E');
                logToTerminal(`> Capturing HD raw photos via secondary pipeline...`, '#FACC15');

                document.getElementById('liveCaptureGallery').innerHTML = '<p class="text-muted" style="margin-top: 10px;">📸 Awaiting first raw frame...</p>';
                liveCaptureInterval = setInterval(fetchLiveCaptures, 2000);
            }
        } catch (e) { logToTerminal(`> ERROR starting mission: ${e}`, '#EF4444'); }
    } else {
        // --- STOP MISSION & RUN BATCH PROCESSOR ---
        clearInterval(liveCaptureInterval);
        btn.innerHTML = '⚙️ PREPARING AI...';
        btn.disabled = true;
        btn.style.background = '#F59E0B'; 
        
        progressContainer.style.display = 'block';
        progressText.style.display = 'block';
        progressBar.style.width = '0%';
        progressText.innerText = 'Counting captures...';

        logToTerminal(`> Mission complete. Engaging YOLO AI processing engine...`, '#F59E0B');
        
        try {
            await fetch('/api/mission/stop', { method: 'POST' });
            isFlightActive = false;
            
            // Poll Backend every 1000ms for ultra-smooth UI updates
            const pollInterval = setInterval(async () => {
                const statusRes = await fetch(`/api/mission/${currentActiveMission}/status`);
                const statusData = await statusRes.json();
                
                if (statusData.status === 'Processing') {
                    progressBar.style.width = `${statusData.progress}%`;
                    
                    if (statusData.total > 0) {
                        progressText.innerText = `Analyzing Frames: ${statusData.processed} / ${statusData.total} Complete`;
                        btn.innerHTML = `⚙️ PROCESSING AI... ${statusData.progress}%`;
                    } else {
                        progressText.innerText = `Searching for images...`;
                    }
                }
                
                if(statusData.status === 'Completed' || statusData.status === 'Unknown') {
                    clearInterval(pollInterval);
                    
                    progressContainer.style.display = 'none';
                    progressText.style.display = 'none';
                    btn.disabled = false;
                    btn.innerHTML = '▶ START MISSION';
                    btn.style.background = '#10B981';
                    
                    if (statusData.total === 0) {
                        logToTerminal(`> AI Complete. No defects were captured during flight.`, '#64748B');
                        document.getElementById('liveCaptureGallery').innerHTML = '<p class="text-muted" style="margin-top: 10px;">❌ No frames captured. Flight too short.</p>';
                    } else {
                        logToTerminal(`> AI Processing Complete! Filtering and saving defects to Database.`, '#22C55E');
                        fetchLiveCaptures(); 
                    }
                    
                    fetchDatabaseStats(); 
                    currentActiveMission = null;
                    bridgeSelect.disabled = false;
                }
            }, 1000); 
            
        } catch (e) {
            logToTerminal(`> ERROR stopping mission: ${e}`, '#EF4444');
            btn.disabled = false;
            progressContainer.style.display = 'none';
            progressText.style.display = 'none';
        }
    }
}