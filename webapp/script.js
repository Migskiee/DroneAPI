let globalChartInstance = null;
let detailChartInstance = null;
let missionChartInstance = null; 
let liveBridgeData = []; 
let currentActiveBridge = null;
let currentActiveMission = null; 
let isFlightActive = false;
let liveCaptureInterval = null;

let isDeleteMode = false;
let selectedForDelete = new Set();

document.addEventListener('DOMContentLoaded', () => {
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.content-section');

    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('data-target');
            
            sections.forEach(section => section.style.display = 'none');
            document.getElementById(targetId).style.display = 'block';
            
            // FIXED: If you click Bridge Database in the sidebar, always force it to reset to the list grid.
            if (targetId === 'bridges') {
                showBridgeList();
            }
            
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

    const savedConf = localStorage.getItem('aiConfThreshold') || '50';
    const savedSize = localStorage.getItem('aiImgSize') || '640';
    
    const confSlider = document.getElementById('aiConfSlider');
    const sizeSelect = document.getElementById('aiImgSizeSelect');
    const confDisplay = document.getElementById('confDisplay');

    if (confSlider) {
        confSlider.value = savedConf;
        confDisplay.innerText = savedConf + '%';
        confSlider.addEventListener('input', (e) => {
            confDisplay.innerText = e.target.value + '%';
        });
    }
    
    if (sizeSelect) {
        sizeSelect.value = savedSize;
    }

    fetchDatabaseStats();
});

function saveAiSettings() {
    const confVal = document.getElementById('aiConfSlider').value;
    const sizeVal = document.getElementById('aiImgSizeSelect').value;
    
    localStorage.setItem('aiConfThreshold', confVal);
    localStorage.setItem('aiImgSize', sizeVal);
    
    const btn = document.getElementById('saveSettingsBtn');
    btn.innerText = "✅ Configuration Saved!";
    btn.style.background = "#059669";
    
    setTimeout(() => {
        btn.innerText = "💾 Save Configuration";
        btn.style.background = "#10b981";
    }, 2000);
}

function handleGalleryClick(event, imgId) {
    if (isDeleteMode) {
        const card = document.getElementById(`gallery-card-${imgId}`);
        if (selectedForDelete.has(imgId)) {
            selectedForDelete.delete(imgId);
            card.classList.remove('selected-for-delete');
        } else {
            selectedForDelete.add(imgId);
            card.classList.add('selected-for-delete');
        }
        document.getElementById('deleteCount').innerText = `${selectedForDelete.size} Selected`;
    } else {
        openImagePreview(imgId);
    }
}

function toggleDeleteMode() {
    isDeleteMode = true;
    selectedForDelete.clear();
    document.getElementById('startDeleteBtn').style.display = 'none';
    document.getElementById('activeDeleteControls').style.display = 'flex';
    document.getElementById('deleteCount').innerText = '0 Selected';
}

function cancelDeleteMode() {
    isDeleteMode = false;
    selectedForDelete.clear();
    const btn = document.getElementById('startDeleteBtn');
    if (btn) btn.style.display = 'block';
    
    const controls = document.getElementById('activeDeleteControls');
    if (controls) controls.style.display = 'none';
    
    document.querySelectorAll('.gallery-card.selected-for-delete').forEach(card => {
        card.classList.remove('selected-for-delete');
    });
}

async function confirmBulkDelete() {
    if (selectedForDelete.size === 0) return alert("Select at least one image to delete.");
    if (!confirm(`Are you sure you want to permanently delete ${selectedForDelete.size} image(s)? This action cannot be undone.`)) return;

    const btn = document.querySelector('#activeDeleteControls .btn-primary');
    btn.innerText = "Deleting...";
    btn.disabled = true;

    try {
        const res = await fetch('/api/images/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_ids: Array.from(selectedForDelete) })
        });
        
        if (res.ok) {
            cancelDeleteMode();
            fetchDatabaseStats(); 
        } else {
            alert("Failed to delete images from database.");
        }
    } catch (e) {
        console.error("Delete error:", e);
        alert("Error deleting images.");
    } finally {
        btn.innerText = "🗑️ Delete Selected";
        btn.disabled = false;
    }
}

function openImagePreview(imgId) {
    const data = window.imageMetaData ? window.imageMetaData[imgId] : null;
    if (!data) return;

    document.getElementById('previewImageSrc').src = data.url;
    document.getElementById('previewType').innerText = data.type;
    document.getElementById('previewConfidence').innerText = data.confidence;
    
    let sevClass = 'badge-fair';
    if(data.severity === 'Bad') sevClass = 'badge-bad';
    else if(data.severity === 'Poor') sevClass = 'badge-poor';
    else if(data.severity === 'Pending') sevClass = 'badge-pending';

    document.getElementById('previewSeverity').innerHTML = `<span class="health-badge ${sevClass}" style="margin:0; font-size: 13px; padding: 6px 12px;">${data.severity.toUpperCase()}</span>`;
    document.getElementById('previewSize').innerText = data.size;
    document.getElementById('previewSpan').innerText = data.span;
    document.getElementById('previewDate').innerText = data.date;

    document.getElementById('imagePreviewModal').style.display = 'flex';
}

function openLivePreview(url) {
    document.getElementById('previewImageSrc').src = url;
    document.getElementById('previewType').innerText = 'Raw Unprocessed Frame';
    document.getElementById('previewConfidence').innerText = 'N/A';
    document.getElementById('previewSeverity').innerHTML = `<span class="health-badge badge-pending" style="margin:0; font-size: 13px; padding: 6px 12px;">AWAITING AI</span>`;
    document.getElementById('previewSize').innerText = 'N/A';
    document.getElementById('previewSpan').innerText = 'Active Flight Zone';
    document.getElementById('previewDate').innerText = new Date().toLocaleString();

    document.getElementById('imagePreviewModal').style.display = 'flex';
}

function closeImagePreview(event) {
    if (event && event.target.id !== 'imagePreviewModal' && !event.target.classList.contains('close-preview')) return;
    document.getElementById('imagePreviewModal').style.display = 'none';
    document.getElementById('previewImageSrc').src = '';
}

async function fetchDatabaseStats() {
    try {
        const response = await fetch(`/api/bridge-data?t=${new Date().getTime()}`);
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
        // The whole card is clickable
        card.onclick = () => showBridgeDetails(bridge);
        card.innerHTML = `
            <div class="bridge-info">
                <h3>${bridge.name} <span class="health-badge ${badgeClass}">${badgeText}</span></h3>
                <p>${bridge.location}</p>
            </div>
            <div style="display: flex; align-items: center; gap: 10px;">
                <span class="bridge-id">${bridge.id}</span>
                <button class="btn btn-primary" style="padding: 6px 12px; margin: 0; font-size: 13px; background: #3b82f6; border: none;">👁️ View</button>
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

function showMissionDetails(missionId) {
    currentActiveMission = missionId;
    document.getElementById('bridgeDetailView').style.display = 'none';
    document.getElementById('missionDetailView').style.display = 'block';

    const missionLabel = `Flight Mission #${missionId}`;
    document.getElementById('missionDetailTitle').innerText = missionLabel;

    const targetMission = currentActiveBridge.missions.find(m => m.id === missionId);
    const missionStatus = targetMission ? targetMission.status : 'Unknown';

    const actionContainer = document.getElementById('missionActionContainer');
    const chartContainer = document.getElementById('defectChartContainer');
    const deleteControls = document.getElementById('deleteControls');
    
    const aiTitle = document.getElementById('aiActionTitle');
    const aiDesc = document.getElementById('aiActionDesc');
    const aiBtn = document.getElementById('runAiBtn');

    // Make sure the action box is displayed
    if(actionContainer) actionContainer.style.display = 'block';

    // Safely apply JS updates using null-checks
    if (missionStatus === 'Awaiting Analysis' || missionStatus === 'Processing') {
        if(chartContainer) chartContainer.style.display = 'none';
        if(deleteControls) deleteControls.style.display = 'flex';
        cancelDeleteMode();
        
        if(aiTitle) aiTitle.innerText = "Data Ready for Analysis";
        if(aiDesc) aiDesc.innerHTML = "Raw images securely backed up. Configure parameters in <b>Settings</b>, then run YOLO AI.";
        if(aiBtn) {
            aiBtn.innerHTML = "🧠 RUN AI ANALYSIS";
            aiBtn.style.background = "#8b5cf6";
        }
    } else {
        if(chartContainer) chartContainer.style.display = 'block';
        if(deleteControls) deleteControls.style.display = 'none';
        isDeleteMode = false;
        
        if(aiTitle) aiTitle.innerText = "Re-Run AI Analysis";
        if(aiDesc) aiDesc.innerHTML = "Want to scan with different confidence or resolution? Update your <b>Settings</b> and re-scan this flight.";
        if(aiBtn) {
            aiBtn.innerHTML = "🔄 RE-SCAN MISSION";
            aiBtn.style.background = "#3b82f6"; 
        }
    }

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
        if (s === 'Pending') return; 
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

async function startAiAnalysis() {
    if (!currentActiveMission) return;
    
    cancelDeleteMode();
    document.getElementById('deleteControls').style.display = 'none';
    
    const btn = document.getElementById('runAiBtn');
    const progressContainer = document.getElementById('analysisProgressBarContainer');
    const progressBar = document.getElementById('analysisProgressBar');
    const progressText = document.getElementById('analysisProgressText');

    const savedConf = localStorage.getItem('aiConfThreshold') || '50';
    const savedSize = localStorage.getItem('aiImgSize') || '640';
    
    const confVal = parseInt(savedConf) / 100.0;
    const imgSizeVal = parseInt(savedSize);

    btn.disabled = true;
    btn.innerHTML = '⚙️ RUNNING YOLO AI...';
    btn.style.background = '#f59e0b';
    
    progressContainer.style.display = 'block';
    progressText.style.display = 'block';
    progressBar.style.width = '0%';
    progressText.innerText = 'Downloading images from Cloudinary...';

    try {
        await fetch('/api/mission/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                mission_id: currentActiveMission,
                conf_threshold: confVal,
                img_size: imgSizeVal
            })
        });
        
        const pollInterval = setInterval(async () => {
            const statusRes = await fetch(`/api/mission/${currentActiveMission}/status?t=${new Date().getTime()}`);
            const statusData = await statusRes.json();
            
            if (statusData.status === 'Processing') {
                progressBar.style.width = `${statusData.progress}%`;
                if (statusData.total > 0) {
                    progressText.innerText = `Analyzing Frames: ${statusData.processed} / ${statusData.total} Complete`;
                }
            }
            
            if(statusData.status === 'Completed' || statusData.status === 'Unknown') {
                clearInterval(pollInterval);
                btn.innerHTML = '✅ ANALYSIS COMPLETE';
                btn.style.background = '#10b981';
                progressText.innerText = 'Database updated successfully!';
                
                setTimeout(() => { fetchDatabaseStats(); }, 1500);
            }
        }, 1000); 
    } catch (e) {
        console.error("AI Error:", e);
        btn.disabled = false;
        btn.innerHTML = '❌ ERROR. TRY AGAIN.';
        btn.style.background = '#ef4444';
    }
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
    const containerDefects = document.getElementById('galleryContainerDefects');
    const containerRaw = document.getElementById('galleryContainerRaw');
    containerDefects.innerHTML = '';
    containerRaw.innerHTML = '';
    
    if (!images || images.length === 0) {
        containerDefects.innerHTML = '<p class="text-muted" style="padding: 15px; background: #fff; border-radius: 8px;">No images found.</p>';
        containerRaw.innerHTML = '<p class="text-muted" style="padding: 15px; background: #fff; border-radius: 8px;">No images found.</p>';
        return;
    }

    const defectImages = images.filter(img => {
        const t = (img.defect_type || img.type || '');
        return t !== 'Raw Image' && t !== 'Unknown Defect';
    });
    
    const rawImages = images.filter(img => {
        const t = (img.defect_type || img.type || '');
        return t === 'Raw Image' || t === 'Unknown Defect';
    });

    if (defectImages.length === 0) {
        containerDefects.innerHTML = '<p class="text-muted" style="padding: 15px; background: #f8fafc; border-radius: 8px;">No structural defects detected.</p>';
    } else {
        buildGalleryGrid(defectImages, containerDefects);
    }

    if (rawImages.length === 0) {
        containerRaw.innerHTML = '<p class="text-muted" style="padding: 15px; background: #f8fafc; border-radius: 8px;">No raw images available.</p>';
    } else {
        buildGalleryGrid(rawImages, containerRaw);
    }
}

function buildGalleryGrid(imageArray, container) {
    const groupedBySpan = {};
    
    window.imageMetaData = window.imageMetaData || {};

    imageArray.forEach(img => {
        const span = img.span_target || img.span || 'Unknown Span';
        if (!groupedBySpan[span]) groupedBySpan[span] = [];
        groupedBySpan[span].push(img);
    });

    const sortedSpans = Object.keys(groupedBySpan).sort((a, b) => parseInt(a.replace(/[^\d]/g, '')) - parseInt(b.replace(/[^\d]/g, '')));

    sortedSpans.forEach(span => {
        const spanImages = groupedBySpan[span];
        const spanGroup = document.createElement('div');
        spanGroup.className = 'span-group';
        spanGroup.style.marginBottom = '20px';
        spanGroup.innerHTML = `<h5 style="font-size: 16px; color: #1e293b; margin-bottom: 12px;">📍 ${span} <span class="badge badge-online" style="margin-left:10px; background:#e2e8f0; color:#475569;">${spanImages.length} Photos</span></h5>`;
        
        const grid = document.createElement('div');
        grid.className = 'image-gallery-grid';
        
        spanImages.forEach(img => {
            const rawUrl = img.image_url || img.url || '';
            const imgSrc = rawUrl.startsWith('http') ? rawUrl : 'https://via.placeholder.com/300x200?text=No+Image+Available';
            const defectType = img.defect_type || img.type || 'Unknown Defect';
            let defectSeverity = img.severity || 'Fair';
            
            let topBadge = '';
            let typeHtml = `<strong style="color: #dc2626;">🚨 Type:</strong> <strong>${defectType}</strong>`;
            let statusHtml = '';
            
            if (defectSeverity === 'Pending') {
                topBadge = `<span class="health-badge badge-pending" style="position: absolute; top: 8px; right: 8px;">⏳ AWAITING AI</span>`;
                typeHtml = `<strong>📸 Capture:</strong> <strong style="color:#64748b;">Raw Surface</strong>`;
                statusHtml = `<p class="text-muted" style="font-size: 12px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: center;">☁️ Stored in Cloud</p>`;
            } else if (defectType === 'Raw Image') {
                topBadge = `<span class="health-badge badge-fair" style="position: absolute; top: 8px; right: 8px;">✅ ANALYZED - SAFE</span>`;
                typeHtml = `<strong>📸 Capture:</strong> <strong style="color:#10b981;">Clean Structure</strong>`;
                statusHtml = `<p class="text-muted" style="font-size: 12px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: center;">🛡️ Verified by AI</p>`;
            } else {
                if (defectSeverity === 'Critical' || defectSeverity === 'High') defectSeverity = 'Bad';
                if (defectSeverity === 'Review Needed') defectSeverity = 'Poor';
                
                let badgeColorClass = defectSeverity === 'Bad' ? 'badge-bad' : (defectSeverity === 'Poor' ? 'badge-poor' : 'badge-fair');
                topBadge = `<span class="health-badge ${badgeColorClass}" style="position: absolute; top: 8px; right: 8px;">${defectSeverity.toUpperCase()}</span>`;
                statusHtml = `<p class="text-muted" style="font-size: 12px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: center;">🚨 Defect Logged in Database</p>`;
            }
            
            const dateStr = img.date || img.created_at || img.captured_at ? new Date(img.date || img.created_at || img.captured_at).toLocaleString() : 'Recent Capture';
            
            window.imageMetaData[img.id] = {
                url: imgSrc,
                type: defectType,
                severity: defectSeverity,
                date: dateStr,
                span: span,
                size: img.size && img.size !== 'N/A' ? img.size : 'N/A',
                confidence: img.confidence && img.confidence !== 'N/A' ? img.confidence : 'N/A'
            };

            const card = document.createElement('div');
            card.className = 'gallery-card';
            card.id = `gallery-card-${img.id}`; 
            
            card.onclick = (e) => {
                e.stopPropagation();
                handleGalleryClick(e, img.id);
            };

            card.innerHTML = `
                <div style="position: relative;">
                    ${topBadge}
                    <img src="${imgSrc}" class="gallery-img" alt="Capture">
                </div>
                <div class="gallery-info">
                    <p style="font-size: 14px; margin-bottom: 6px;">${typeHtml}</p>
                    <p class="text-muted" style="font-size: 11px; margin-bottom: 5px;">🕒 ${dateStr}</p>
                    ${statusHtml}
                </div>
            `;
            grid.appendChild(card);
        });
        spanGroup.appendChild(grid);
        container.appendChild(spanGroup);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const streamImg = document.getElementById('liveVideoStream');
    const offlineOverlay = document.getElementById('offlineOverlay');

    if (streamImg) {
        streamImg.onerror = function() {
            this.style.display = 'none';
            offlineOverlay.style.display = 'flex';
            logToTerminal(`> WARNING: Video stream connection lost.`, '#EF4444');
        };
        streamImg.onload = function() {
            this.style.display = 'block';
            offlineOverlay.style.display = 'none';
        };
    }
});

window.retryStream = function() {
    const streamImg = document.getElementById('liveVideoStream');
    const offlineOverlay = document.getElementById('offlineOverlay');
    logToTerminal(`> Attempting to re-establish video link...`, '#FACC15');
    offlineOverlay.style.display = 'none'; 
    streamImg.style.display = 'block';
    streamImg.src = "/video_feed?t=" + new Date().getTime();
};

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

async function setFlightSpan(span, btnElement) {
    document.getElementById('flightSpanInput').value = span;
    document.querySelectorAll('.span-btn').forEach(b => b.classList.remove('active'));
    btnElement.classList.add('active');
    
    if(isFlightActive) {
        try {
            const res = await fetch('/api/mission/span', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ span_target: span })
            });
            if(res.ok) logToTerminal(`> Flight Zone dynamically shifted to: ${span}`, '#22C55E');
        } catch(e) { console.error("Failed to update span mid-flight:", e); }
    } else {
        logToTerminal(`> Target Zone set to: ${span}`, '#38BDF8');
    }
}

async function fetchLiveCaptures() {
    if (!currentActiveMission) return;
    try {
        const gallery = document.getElementById('liveCaptureGallery');
        
        if (isFlightActive) {
            const res = await fetch(`/api/mission/${currentActiveMission}/live_frames?t=${new Date().getTime()}`);
            const data = await res.json();
            if (data.status === 'success' && data.frames.length > 0) {
                gallery.innerHTML = data.frames.map(f => `
                    <div class="live-capture-card" onclick="openLivePreview('${f.url}')">
                        <span class="health-badge badge-fair" style="position: absolute; top: 5px; right: 5px;">Raw Frame</span>
                        <img src="${f.url}" alt="Raw Capture">
                        <div class="live-capture-info">Auto-Capture</div>
                    </div>
                `).join('');
                
                gallery.scrollTop = gallery.scrollHeight; 
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
        const bridgeId = parseInt(bridgeSelect.value);
        if(isNaN(bridgeId)) return alert("Please select a target bridge from the dropdown.");
        if(!spanInput.value) return alert("Please select a target span.");

        try {
            const res = await fetch('/api/mission/start', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bridge_id: bridgeId, span_target: spanInput.value })
            });
            const data = await res.json();
            
            if(data.status === "success") {
                isFlightActive = true;
                currentActiveMission = data.mission_id;
                bridgeSelect.disabled = true;
                
                btn.innerHTML = '🛑 STOP MISSION & SAVE DATA';
                btn.style.background = '#EF4444';
                logToTerminal(`> MISSION #${data.mission_id} INITIATED. Auto-Capture ARMED.`, '#22C55E');
                logToTerminal(`> Capturing HD raw photos via secondary pipeline...`, '#FACC15');

                document.getElementById('liveCaptureGallery').innerHTML = '<p class="text-muted" style="margin-top: 10px;">📸 Awaiting first high-res frame from drone...</p>';
                liveCaptureInterval = setInterval(fetchLiveCaptures, 2000);
            }
        } catch (e) { logToTerminal(`> ERROR starting mission: ${e}`, '#EF4444'); }
    } else {
        clearInterval(liveCaptureInterval);
        btn.innerHTML = '☁️ UPLOADING TO CLOUD...';
        btn.disabled = true;
        btn.style.background = '#F59E0B'; 
        
        progressContainer.style.display = 'block';
        progressText.style.display = 'block';
        progressBar.style.width = '0%';
        progressText.innerText = 'Securing files to Cloudinary...';

        logToTerminal(`> Mission stopped. Saving raw data securely to Cloudinary Database...`, '#F59E0B');
        
        try {
            await fetch('/api/mission/stop', { method: 'POST' });
            isFlightActive = false;
            
            const pollInterval = setInterval(async () => {
                const statusRes = await fetch(`/api/mission/${currentActiveMission}/status?t=${new Date().getTime()}`);
                const statusData = await statusRes.json();
                
                if (statusData.status === 'Saving to Cloud') {
                    progressBar.style.width = `${statusData.progress}%`;
                    if (statusData.total > 0) {
                        progressText.innerText = `Uploading Frames: ${statusData.processed} / ${statusData.total} Secured`;
                    }
                }
                
                if(statusData.status === 'Awaiting Analysis' || statusData.status === 'Unknown') {
                    clearInterval(pollInterval);
                    
                    progressContainer.style.display = 'none';
                    progressText.style.display = 'none';
                    btn.disabled = false;
                    btn.innerHTML = '▶ START MISSION';
                    btn.style.background = '#10B981';
                    
                    logToTerminal(`> ✅ Cloud Upload Complete! Open the Database to run AI Analysis.`, '#22C55E');
                    
                    fetchDatabaseStats(); 
                    currentActiveMission = null;
                    bridgeSelect.disabled = false;
                    document.getElementById('liveCaptureGallery').innerHTML = '<p class="text-muted" style="margin-top: 10px;">✅ Mission Saved.</p>';
                }
            }, 1000); 
            
        } catch (e) {
            logToTerminal(`> ERROR stopping mission: ${e}`, '#EF4444');
            btn.disabled = false;
        }
    }
}