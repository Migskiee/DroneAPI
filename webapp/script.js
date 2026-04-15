let globalChartInstance = null;
let detailChartInstance = null;
let liveBridgeData = []; 
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

    fetchDatabaseStats();
});

// --- LIVE FLIGHT LOGIC ---
function logToTerminal(msg, color) {
    const term = document.getElementById('flightLogTerminal');
    term.innerHTML += `<span style="color: ${color}">${msg}</span><br>`;
    term.scrollTop = term.scrollHeight;
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
        const res = await fetch(`/api/mission/${currentActiveMission}/captures`);
        const data = await res.json();
        
        if (data.status === 'success' && data.captures.length > 0) {
            const gallery = document.getElementById('liveCaptureGallery');
            gallery.innerHTML = data.captures.map(c => `
                <div class="live-capture-card">
                    <span class="badge ${c.severity.toLowerCase()}" style="font-size: 10px; padding: 2px 4px; top: 5px; right: 5px;">${c.severity}</span>
                    <img src="${c.image_url}" alt="Defect">
                    <div class="live-capture-info">${c.defect_type}</div>
                </div>
            `).join('');
        }
    } catch(e) {
        console.error("Capture sync error:", e);
    }
}

async function toggleFlightMission() {
    const btn = document.getElementById('toggleMissionBtn');
    const bridgeSelect = document.getElementById('flightBridgeSelect');
    const spanInput = document.getElementById('flightSpanInput');
    
    if (!isFlightActive) {
        const bridgeId = parseInt(bridgeSelect.value);
        if(isNaN(bridgeId)) return alert("Please select a target bridge first!");

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
                
                btn.innerHTML = '🛑 END MISSION';
                btn.style.background = '#EF4444';
                logToTerminal(`> MISSION #${data.mission_id} INITIATED. AI ARMED.`, '#22C55E');
                
                // Start pulling images for the gallery every 3 seconds
                document.getElementById('liveCaptureGallery').innerHTML = '<p class="text-muted">Scanning...</p>';
                liveCaptureInterval = setInterval(fetchLiveCaptures, 3000);
            }
        } catch (e) {
            logToTerminal(`> ERROR starting mission: ${e}`, '#EF4444');
        }
    } else {
        try {
            await fetch('/api/mission/stop', { method: 'POST' });
            isFlightActive = false;
            currentActiveMission = null;
            bridgeSelect.disabled = false;
            
            btn.innerHTML = '▶ START MISSION & AI';
            btn.style.background = '#10B981';
            logToTerminal(`> MISSION CONCLUDED. AI Disarmed.`, '#F59E0B');
            
            clearInterval(liveCaptureInterval);
            fetchDatabaseStats(); 
        } catch (e) {
            logToTerminal(`> ERROR stopping mission: ${e}`, '#EF4444');
        }
    }
}

// --- DATABASE & CRUD LOGIC ---
async function fetchDatabaseStats() {
    try {
        const response = await fetch('/api/bridge-data');
        const data = await response.json();

        if (data.status === "success") {
            liveBridgeData = data.bridges;
            document.getElementById('g-total-bridges').innerText = data.stats.total_bridges;
            document.getElementById('g-total-defects').innerText = data.stats.total_defects;

            renderGlobalChart(data.stats.severity);
            populateBridgeDropdowns(data.bridges);
            renderBridges(data.bridges);
        }
    } catch (error) {
        console.error("Error fetching data:", error);
    }
}

function populateBridgeDropdowns(bridges) {
    const flightSelect = document.getElementById('flightBridgeSelect');
    if (flightSelect) {
        flightSelect.innerHTML = '<option value="" disabled selected>-- Select Target Bridge --</option>';
        bridges.forEach(b => {
            flightSelect.innerHTML += `<option value="${b.db_id}">${b.name} (${b.id})</option>`;
        });
    }
}

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
    } else {
        title.innerText = 'Add New Bridge';
        document.getElementById('modalBridgeId').value = '';
        document.getElementById('modalBridgeCode').value = '';
        document.getElementById('modalBridgeName').value = '';
        document.getElementById('modalBridgeLocation').value = '';
        document.getElementById('modalBridgeRemarks').value = '';
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
        remarks: document.getElementById('modalBridgeRemarks').value
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

async function updateSeverity(defectId, newSeverity) {
    await fetch(`/api/defects/${defectId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ severity: newSeverity })
    });
    fetchDatabaseStats();
}

async function deleteDefect(defectId) {
    if(confirm("Permanently delete this defect record?")) {
        await fetch(`/api/defects/${defectId}`, { method: 'DELETE' });
        fetchDatabaseStats();
    }
}

async function updateRemarks(bridgeId) {
    const btn = event.target;
    const textArea = btn.previousElementSibling;
    const newRemarks = textArea.value;
    
    btn.innerHTML = "Saving...";
    await fetch(`/api/bridges/${bridgeId}/remarks`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remarks: newRemarks })
    });
    btn.innerHTML = "Save Remarks";
    btn.style.background = "#10B981";
    setTimeout(() => { btn.style.background = "#007bff"; }, 2000);
}

function renderGlobalChart(severityData) {
    const ctx = document.getElementById('globalConditionChart').getContext('2d');
    if (globalChartInstance) globalChartInstance.destroy();

    const counts = { "Fair": 0, "Poor": 0, "Bad": 0 };
    severityData.forEach(item => { counts[item[0]] = item[1]; });

    globalChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Fair (Monitor)', 'Poor (Repair)', 'Bad (Critical)'],
            datasets: [{ data: [counts['Fair'], counts['Poor'], counts['Bad']], backgroundColor: ['#10B981', '#F59E0B', '#EF4444'] }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
}

function calculateBridgeStatus(defects) {
    if (!defects || defects.length === 0) return { label: 'FAIR', class: 'status-fair' };
    const counts = { 'Bad': 0, 'Poor': 0, 'Fair': 0 };
    defects.forEach(d => counts[d[0]] = d[1]);
    
    if (counts['Bad'] > 0) return { label: 'CRITICAL', class: 'status-bad' };
    if (counts['Poor'] > 0) return { label: 'NEEDS REPAIR', class: 'status-poor' };
    return { label: 'FAIR', class: 'status-fair' };
}

function renderBridges(bridges) {
    const container = document.getElementById('bridgeContainer');
    container.innerHTML = '';

    bridges.forEach(bridge => {
        const spans = [...new Set(bridge.images.map(img => img.span))];
        const status = calculateBridgeStatus(bridge.defects);
        
        let spanOptions = `<option value="ALL">All Spans</option>`;
        spans.forEach(s => spanOptions += `<option value="${s}">${s}</option>`);

        let html = `
            <div class="bridge-card">
                <div class="bridge-header">
                    <div>
                        <h3 class="bridge-title">${bridge.name} <span class="bridge-id">${bridge.id}</span>
                        <button onclick="openBridgeModal(${bridge.db_id})" style="margin-left: 15px; font-size: 12px; cursor: pointer; border:none; background:none; color:#2563EB;">✏️ Edit</button></h3>
                        <p class="text-muted">📍 ${bridge.location}</p>
                    </div>
                    <div>
                        <select class="filter-select" onchange="filterGallery(${bridge.db_id}, this.value)">
                            ${spanOptions}
                        </select>
                    </div>
                </div>
                
                <div class="bridge-overview-row">
                    <div class="chart-section">
                        <canvas id="chart-${bridge.db_id}" height="180"></canvas>
                    </div>
                    <div class="remarks-section">
                        <div class="status-badge ${status.class}">STATUS: ${status.label}</div>
                        <h4 style="font-size: 13px; color: #64748B; margin-bottom: 5px;">Engineering Remarks</h4>
                        <textarea class="form-control" rows="4">${bridge.remarks || ''}</textarea>
                        <button class="btn btn-primary" onclick="updateRemarks(${bridge.db_id})">Save Remarks</button>
                    </div>
                </div>

                <div id="gallery-${bridge.db_id}" style="margin-top: 30px;">
                    ${renderGalleryBySpan(bridge.images, 'ALL')}
                </div>
            </div>
        `;
        container.innerHTML += html;
    });

    bridges.forEach(bridge => {
        const ctx = document.getElementById(`chart-${bridge.db_id}`).getContext('2d');
        const counts = { "Fair": 0, "Poor": 0, "Bad": 0 };
        bridge.defects.forEach(item => { counts[item[0]] = item[1]; });

        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['Fair', 'Poor', 'Bad'],
                datasets: [{ label: 'Defect Count', data: [counts['Fair'], counts['Poor'], counts['Bad']], backgroundColor: ['#10B981', '#F59E0B', '#EF4444'] }]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }, plugins: { legend: { display: false } } }
        });
    });
}

function filterGallery(bridgeDbId, spanTarget) {
    const bridge = liveBridgeData.find(b => b.db_id === bridgeDbId);
    const galleryDiv = document.getElementById(`gallery-${bridgeDbId}`);
    galleryDiv.innerHTML = renderGalleryBySpan(bridge.images, spanTarget);
}

function renderGalleryBySpan(images, filterSpan) {
    let filteredImages = filterSpan === 'ALL' ? images : images.filter(img => img.span === filterSpan);
    if (filteredImages.length === 0) return `<p class="text-muted">No images recorded for this zone.</p>`;

    const groupedBySpan = {};
    filteredImages.forEach(img => {
        if (!groupedBySpan[img.span]) groupedBySpan[img.span] = [];
        groupedBySpan[img.span].push(img);
    });

    let html = '';
    for (const [span, imgs] of Object.entries(groupedBySpan)) {
        html += `
            <div class="span-group">
                <h4 class="span-group-title">🏷️ ${span}</h4>
                <div class="image-gallery">
                    ${imgs.map(img => `
                        <div class="image-card">
                            <span class="badge ${img.severity.toLowerCase()}">${img.severity}</span>
                            <a href="${img.url}" target="_blank"><img src="${img.url}" alt="Defect"></a>
                            <div class="image-info">
                                <p style="font-weight: bold; color: #1e293b; font-size: 14px; margin-bottom: 5px;">${img.type}</p>
                                <p class="text-muted" style="font-size: 11px; margin-bottom: 10px;">🕒 ${new Date(img.date).toLocaleString()}</p>
                                <select class="severity-select" onchange="updateSeverity(${img.id}, this.value)">
                                    <option value="Fair" ${img.severity === 'Fair' ? 'selected' : ''}>Fair</option>
                                    <option value="Poor" ${img.severity === 'Poor' ? 'selected' : ''}>Poor</option>
                                    <option value="Bad" ${img.severity === 'Bad' ? 'selected' : ''}>Bad</option>
                                </select>
                                <button class="delete-btn" onclick="deleteDefect(${img.id})">🗑️ Delete Record</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
    return html;
}