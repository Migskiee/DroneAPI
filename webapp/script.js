const BASE_URL = "https://dronebridgeanalytics.up.railway.app";

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
let currentPreviewImageId = null;

// =========================================
// ACTIVE LEARNING STATE
// =========================================
let flaggedImagesData = [];
let currentAnnotationImageId = null;
let isDrawing = false;
let startX = 0; let startY = 0;

// Multi-box array
let currentAnnotations = []; 
let currentRect = null; 

const canvas = document.getElementById('annotationCanvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let bgImage = new Image();
bgImage.crossOrigin = "Anonymous"; 

document.addEventListener('DOMContentLoaded', () => {
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.content-section');

    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('data-target');
            
            sections.forEach(section => section.style.display = 'none');
            document.getElementById(targetId).style.display = 'block';
            
            if (targetId === 'bridges') showBridgeList();
            if (targetId === 'retraining') loadRetrainingHub(); 
            
            navLinks.forEach(l => l.classList.remove('active'));
            this.classList.add('active');
        });
    });

    const searchInput = document.getElementById('bridgeSearch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const filtered = liveBridgeData.filter(bridge => 
                bridge.name.toLowerCase().includes(term) || bridge.location.toLowerCase().includes(term)
            );
            renderBridges(filtered);
        });
    }

    const bridgeSelect = document.getElementById('flightBridgeSelect');
    if (bridgeSelect) {
        bridgeSelect.addEventListener('change', function() {
            const db_id = parseInt(this.value);
            const bridge = liveBridgeData.find(b => b.db_id === db_id);
            const container = document.getElementById('dynamicSpanContainer');
            if(!container) return;

            container.innerHTML = '';
            
            if(bridge && bridge.span_count > 0) {
                for(let i = 1; i <= bridge.span_count; i++) {
                    const btn = document.createElement('button');
                    btn.className = `span-btn ${i === 1 ? 'active' : ''}`;
                    btn.innerText = `Span ${i}`;
                    btn.onclick = function() { setFlightSpan(`Span ${i}`, this); };
                    container.appendChild(btn);
                }
                const spanInput = document.getElementById('flightSpanInput');
                if(spanInput) spanInput.value = 'Span 1';
            } else {
                container.innerHTML = '<p class="text-muted" style="font-size: 12px; margin-top: 5px;">No spans configured.</p>';
                const spanInput = document.getElementById('flightSpanInput');
                if(spanInput) spanInput.value = '';
            }
        });
    }

    const savedConf = localStorage.getItem('aiConfThreshold') || '50';
    const savedSize = localStorage.getItem('aiImgSize') || '640';
    
    const confSlider = document.getElementById('aiConfSlider');
    const sizeSelect = document.getElementById('aiImgSizeSelect');
    const confDisplay = document.getElementById('confDisplay');

    if (confSlider) {
        confSlider.value = savedConf;
        if(confDisplay) confDisplay.innerText = savedConf + '%';
        confSlider.addEventListener('input', (e) => {
            if(confDisplay) confDisplay.innerText = e.target.value + '%';
        });
    }
    if (sizeSelect) sizeSelect.value = savedSize;

    if(canvas) {
        canvas.addEventListener('mousedown', startDrawing);
        canvas.addEventListener('mousemove', draw);
        canvas.addEventListener('mouseup', stopDrawing);
        canvas.addEventListener('mouseout', stopDrawing);
    }

    fetchDatabaseStats();
    fetchAvailableModels(); 
});

async function fetchAvailableModels() {
    try {
        const res = await fetch(`${BASE_URL}/api/model/list`);
        const data = await res.json();
        
        if (data.status === 'success') {
            const select = document.getElementById('aiVersionSelect');
            if (select) {
                select.innerHTML = '';
                data.models.forEach(modelName => {
                    const option = document.createElement('option');
                    option.value = modelName;
                    if (modelName === data.active) {
                        option.selected = true;
                        option.innerText = `🟢 ${modelName} (Active)`;
                    } else {
                        option.innerText = modelName;
                    }
                    select.appendChild(option);
                });
            }
        }
    } catch(e) {
        console.error("Error fetching models", e);
    }
}

window.applyAiVersion = async function() {
    const select = document.getElementById('aiVersionSelect');
    const btn = document.getElementById('applyAiVersionBtn');
    
    if (!select || !select.value) return;

    const selectedModel = select.value;
    const originalText = btn.innerHTML;

    btn.innerHTML = "⏳ Hot-Swapping...";
    btn.disabled = true;

    try {
        const res = await fetch(`${BASE_URL}/api/model/set-active`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_name: selectedModel })
        });
        const data = await res.json();

        if (res.ok && data.status === 'success') {
            btn.innerHTML = "✅ Brain Swapped!";
            btn.style.background = "#10b981";
            fetchAvailableModels(); 
        } else {
            alert("Failed to load model.");
            btn.innerHTML = originalText;
        }
    } catch(e) {
        console.error(e);
        alert("Network error.");
        btn.innerHTML = originalText;
    } finally {
        setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = "🔄 Load";
            btn.style.background = "#4f46e5";
        }, 2000);
    }
};

// =========================================
// ACTIVE LEARNING FUNCTIONS
// =========================================

window.flagImageForRetraining = async function() {
    if (!currentPreviewImageId) return;
    const btn = document.getElementById('flagRetrainBtn');
    btn.innerText = '⏳ Flagging...';
    btn.disabled = true;

    try {
        const res = await fetch(`${BASE_URL}/api/images/${currentPreviewImageId}/flag`, { method: 'POST' });
        if (res.ok) {
            btn.innerText = '✅ Flagged for Hub';
            btn.style.background = '#10b981';
            btn.style.borderColor = '#059669';
            setTimeout(() => closeImagePreview(), 1500);
        }
    } catch(e) {
        console.error(e);
        btn.innerText = '❌ Error';
    }
};

window.unflagImage = async function() {
    if (!currentAnnotationImageId) return alert("Select an image first.");
    if (!confirm("Are you sure you want to remove this image from the retraining queue?")) return;

    const btn = document.querySelector('button[onclick="unflagImage()"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = "⏳...";
    btn.disabled = true;

    try {
        const res = await fetch(`${BASE_URL}/api/images/${currentAnnotationImageId}/unflag`, { method: 'POST' });
        if (res.ok) {
            flaggedImagesData = flaggedImagesData.filter(i => i.id !== currentAnnotationImageId);
            
            currentAnnotationImageId = null;
            currentRect = null;
            currentAnnotations = [];
            
            document.getElementById('canvasPlaceholder').style.display = 'block';
            const canvasEl = document.getElementById('annotationCanvas');
            if(canvasEl) canvasEl.style.display = 'none';
            
            const badge = document.getElementById('annotationStatus');
            if(badge) {
                badge.innerText = "Select an Image";
                badge.className = "health-badge badge-pending";
            }

            renderFlaggedGrid();
        } else {
            alert("Failed to unflag image.");
        }
    } catch(e) {
        console.error(e);
        alert("Network error unflagging image.");
    } finally {
        if(btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
};

async function loadRetrainingHub() {
    try {
        const res = await fetch(`${BASE_URL}/api/retraining/flagged?t=${new Date().getTime()}`);
        const data = await res.json();
        if (data.status === 'success') {
            flaggedImagesData = data.images;
            renderFlaggedGrid();
        }
    } catch(e) { console.error("Failed to load hub", e); }
}

function renderFlaggedGrid() {
    const grid = document.getElementById('retrainImageGrid');
    const msg = document.getElementById('retrainEmptyMsg');
    grid.innerHTML = '';
    
    if (flaggedImagesData.length === 0) {
        msg.style.display = 'block';
        return;
    }
    
    msg.style.display = 'none';
    flaggedImagesData.forEach(img => {
        const isDone = img.annotation && img.annotation !== '';
        const badge = isDone ? `<span class="health-badge badge-fair" style="position:absolute; top:5px; right:5px;">✅ Ready</span>` : `<span class="health-badge badge-bad" style="position:absolute; top:5px; right:5px;">🚨 Needs Box</span>`;
        
        const card = document.createElement('div');
        card.style.position = 'relative';
        card.style.cursor = 'pointer';
        card.style.border = currentAnnotationImageId === img.id ? '3px solid #8b5cf6' : '1px solid #e2e8f0';
        card.style.borderRadius = '6px';
        card.style.overflow = 'hidden';
        card.onclick = () => loadCanvasImage(img);
        
        card.innerHTML = `
            ${badge}
            <img src="${img.url}" style="width: 100%; height: 120px; object-fit: cover; display: block;">
        `;
        grid.appendChild(card);
    });
}

function loadCanvasImage(imgData) {
    currentAnnotationImageId = imgData.id;
    currentRect = null;
    currentAnnotations = []; 
    document.getElementById('canvasPlaceholder').style.display = 'none';
    
    const badge = document.getElementById('annotationStatus');
    badge.innerText = imgData.annotation ? "✅ Annotated" : "🚨 Draw Box";
    badge.className = imgData.annotation ? "health-badge badge-fair" : "health-badge badge-bad";
    
    renderFlaggedGrid(); 

    bgImage.onload = () => {
        canvas.style.display = 'block';
        canvas.width = bgImage.width;
        canvas.height = bgImage.height;
        ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
        
        if(imgData.annotation) {
            const lines = imgData.annotation.trim().split('\n');
            lines.forEach(line => {
                const parts = line.trim().split(' ');
                if (parts.length === 5) {
                    const cx = parseFloat(parts[1]) * canvas.width;
                    const cy = parseFloat(parts[2]) * canvas.height;
                    const w = parseFloat(parts[3]) * canvas.width;
                    const h = parseFloat(parts[4]) * canvas.height;
                    currentAnnotations.push({
                        class_id: parts[0],
                        x: cx - w/2,
                        y: cy - h/2,
                        w: w,
                        h: h
                    });
                }
            });
        }
        draw(); 
    };
    bgImage.src = imgData.url;
}

function startDrawing(e) {
    if (!currentAnnotationImageId) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    startX = (e.clientX - rect.left) * scaleX;
    startY = (e.clientY - rect.top) * scaleY;
    isDrawing = true;
    currentRect = null; 
}

function draw(e) {
    if (!currentAnnotationImageId) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
    
    const classColors = ['#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6', '#06b6d4'];
    const selectDropdown = document.getElementById('annotationClassSelect');

    currentAnnotations.forEach(ann => {
        const color = classColors[ann.class_id] || '#10b981';
        
        // Extra crash-proofing: Validate the option exists before reading its text
        const option = selectDropdown.querySelector(`option[value="${ann.class_id}"]`);
        const className = option ? option.text : "Unknown Defect";
        
        ctx.strokeStyle = color; 
        ctx.lineWidth = 3;
        ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.2; 
        ctx.fillRect(ann.x, ann.y, ann.w, ann.h);
        ctx.globalAlpha = 1.0;
        
        ctx.fillStyle = color;
        ctx.font = "bold 14px Arial";
        ctx.fillText(className, ann.x, ann.y > 15 ? ann.y - 5 : ann.y + 15);
    });
    
    if (isDrawing && e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const currentX = (e.clientX - rect.left) * scaleX;
        const currentY = (e.clientY - rect.top) * scaleY;
        
        currentRect = {
            x: Math.min(startX, currentX),
            y: Math.min(startY, currentY),
            w: Math.abs(currentX - startX),
            h: Math.abs(currentY - startY)
        };
    }
    
    if (currentRect) {
        ctx.strokeStyle = '#ef4444'; 
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]); 
        ctx.strokeRect(currentRect.x, currentRect.y, currentRect.w, currentRect.h);
        ctx.setLineDash([]); 
    }
}

function stopDrawing() {
    if (isDrawing && currentRect && currentRect.w > 5 && currentRect.h > 5) {
        const class_id = document.getElementById('annotationClassSelect').value;
        currentAnnotations.push({
            class_id: class_id,
            x: currentRect.x,
            y: currentRect.y,
            w: currentRect.w,
            h: currentRect.h
        });
    }
    isDrawing = false;
    currentRect = null;
    draw(); 
}

window.undoLastAnnotation = function() {
    if (currentAnnotations.length > 0) {
        currentAnnotations.pop(); 
        draw();
    }
};

window.clearAnnotationCanvas = function() {
    currentAnnotations = []; 
    currentRect = null;
    draw(); 
};

window.saveAnnotation = async function() {
    if (!currentAnnotationImageId) return alert("Select an image first.");
    if (currentAnnotations.length === 0) return alert("Please draw at least one box. If you want to skip this image, use the Unflag button.");

    const yoloLines = currentAnnotations.map(ann => {
        const x_center = (ann.x + ann.w / 2) / canvas.width;
        const y_center = (ann.y + ann.h / 2) / canvas.height;
        const width = ann.w / canvas.width;
        const height = ann.h / canvas.height;
        return `${ann.class_id} ${x_center.toFixed(6)} ${y_center.toFixed(6)} ${width.toFixed(6)} ${height.toFixed(6)}`;
    });
    
    const yoloString = yoloLines.join('\n');

    try {
        const res = await fetch(`${BASE_URL}/api/images/${currentAnnotationImageId}/annotate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ yolo_annotation: yoloString })
        });
        if (res.ok) {
            document.getElementById('annotationStatus').innerText = "✅ Saved!";
            document.getElementById('annotationStatus').className = "health-badge badge-fair";
            const img = flaggedImagesData.find(i => i.id === currentAnnotationImageId);
            if (img) img.annotation = yoloString;
            renderFlaggedGrid();
        }
    } catch(e) {
        console.error(e);
        alert("Failed to save annotation.");
    }
};

window.exportYoloDataset = async function() {
    const readyCount = flaggedImagesData.filter(i => i.annotation && i.annotation !== '').length;
    if (readyCount === 0) return alert("You need to draw boxes and save at least one image before exporting!");
    
    const btn = document.querySelector('#retraining .btn-primary');
    const originalText = btn.innerHTML;
    btn.innerHTML = "⏳ Compiling & Sending to Cloud...";
    btn.disabled = true;
    btn.style.background = "#f59e0b";

    try {
        const res = await fetch(`${BASE_URL}/api/retraining/push-to-cloud`, { method: 'POST' });
        const data = await res.json();
        
        if (res.ok && data.status === 'success') {
            btn.innerHTML = "✅ Dataset Sent to Cloud!";
            btn.style.background = "#10b981";
            alert("Success! The dataset has been securely transferred to the cloud. You can now open Google Colab and click 'Run'.");
        } else {
            alert("Failed to send dataset to cloud.");
            btn.innerHTML = originalText;
            btn.style.background = "#8b5cf6";
        }
    } catch(e) {
        console.error("Upload error:", e);
        alert("Network error while pushing dataset.");
        btn.innerHTML = originalText;
        btn.style.background = "#8b5cf6";
    } finally {
        setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = "☁️ Push Dataset to Cloud";
            btn.style.background = "#8b5cf6";
        }, 3000);
    }
};

// =========================================
// SETTINGS FUNCTIONS
// =========================================
window.saveAiSettings = function() {
    const confVal = document.getElementById('aiConfSlider').value;
    const sizeVal = document.getElementById('aiImgSizeSelect').value;

    localStorage.setItem('aiConfThreshold', confVal);
    localStorage.setItem('aiImgSize', sizeVal);

    const btn = document.getElementById('saveSettingsBtn');
    const originalText = btn.innerHTML;
    
    btn.innerHTML = "✅ Configuration Saved!";
    btn.style.background = "#059669"; 
    btn.disabled = true;

    setTimeout(() => {
        btn.innerHTML = originalText;
        btn.style.background = "#10b981"; 
        btn.disabled = false;
    }, 2000);
};

// =========================================
// EXISTING GCS FUNCTIONS BELOW
// =========================================

window.openBridgeView = function(db_id) {
    const bridge = liveBridgeData.find(b => b.db_id === db_id);
    if(bridge) {
        showBridgeDetails(bridge);
    }
};

window.openMissionView = function(mission_id) {
    showMissionDetails(mission_id);
};

window.deleteBridge = async function(db_id) {
    if (!confirm("⚠️ WARNING: Are you sure you want to permanently delete this bridge and all of its associated flight missions and images? This action cannot be undone.")) return;

    try {
        const res = await fetch(`${BASE_URL}/api/bridges/${db_id}`, { method: 'DELETE' });
        const data = await res.json();
        
        if (data.status === 'success') {
            fetchDatabaseStats(); 
        } else {
            alert('Failed to delete bridge from database.');
        }
    } catch (error) { 
        console.error("Network Error:", error); 
        alert("Error securely connecting to backend for deletion.");
    }
};

function handleGalleryClick(event, imgId) {
    if (isDeleteMode) {
        const card = document.getElementById(`gallery-card-${imgId}`);
        if(card) {
            if (selectedForDelete.has(imgId)) {
                selectedForDelete.delete(imgId);
                card.classList.remove('selected-for-delete');
            } else {
                selectedForDelete.add(imgId);
                card.classList.add('selected-for-delete');
            }
        }
        const delCount = document.getElementById('deleteCount');
        if(delCount) delCount.innerText = `${selectedForDelete.size} Selected`;
    } else {
        openImagePreview(imgId);
    }
}

window.toggleDeleteMode = function() {
    isDeleteMode = true;
    selectedForDelete.clear();
    const sBtn = document.getElementById('startDeleteBtn');
    const aCtrl = document.getElementById('activeDeleteControls');
    const dCnt = document.getElementById('deleteCount');
    
    if(sBtn) sBtn.style.display = 'none';
    if(aCtrl) aCtrl.style.display = 'flex';
    if(dCnt) dCnt.innerText = '0 Selected';
};

window.cancelDeleteMode = function() {
    isDeleteMode = false;
    selectedForDelete.clear();
    const sBtn = document.getElementById('startDeleteBtn');
    const aCtrl = document.getElementById('activeDeleteControls');
    
    if(sBtn) sBtn.style.display = 'block';
    if(aCtrl) aCtrl.style.display = 'none';
    
    document.querySelectorAll('.gallery-card.selected-for-delete').forEach(card => {
        card.classList.remove('selected-for-delete');
    });
};

window.confirmBulkDelete = async function() {
    if (selectedForDelete.size === 0) return alert("Select at least one image to delete.");
    if (!confirm(`Are you sure you want to permanently delete ${selectedForDelete.size} image(s)? This action cannot be undone.`)) return;

    const btn = document.querySelector('#activeDeleteControls .btn-primary');
    if(btn) {
        btn.innerText = "Deleting...";
        btn.disabled = true;
    }

    try {
        const res = await fetch(`${BASE_URL}/api/images/bulk-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_ids: Array.from(selectedForDelete) })
        });
        
        if (res.ok) {
            window.cancelDeleteMode();
            fetchDatabaseStats(); 
        } else {
            alert("Failed to delete images from database.");
        }
    } catch (e) {
        console.error("Delete error:", e);
        alert("Error deleting images.");
    } finally {
        if(btn) {
            btn.innerText = "🗑️ Delete Selected";
            btn.disabled = false;
        }
    }
};

window.forceResetMission = async function() {
    if (!currentActiveMission) return;
    if(!confirm("⚠️ WARNING: Are you sure you want to Force Reset this mission? Only do this if the AI progress bar has been stuck or frozen for several minutes.")) return;
    
    const btn = document.getElementById('emergencyResetBtn');
    if(btn) btn.innerText = "RESETTING...";
    
    try {
        const res = await fetch(`${BASE_URL}/api/mission/${currentActiveMission}/force-reset`, { method: 'POST' });
        if (res.ok) {
            alert("✅ Mission successfully reset! You can now run the analysis again.");
            fetchDatabaseStats(); 
        }
    } catch(e) {
        console.error("Failed to reset mission:", e);
        alert("Network error trying to reset mission.");
    }
};

window.toggleAttributeInput = function() {
    const container = document.getElementById('attributeInputContainer');
    if (container.style.display === 'none') {
        container.style.display = 'flex';
        document.getElementById('customAttributeInput').focus();
    } else {
        container.style.display = 'none';
    }
};

window.saveImageAttribute = async function() {
    if (!currentPreviewImageId) return;
    
    const inputVal = document.getElementById('customAttributeInput').value;
    const btn = document.querySelector('#attributeInputContainer .btn-primary');
    const originalText = btn.innerText;
    
    btn.innerText = "⏳";
    btn.disabled = true;

    try {
        const res = await fetch(`${BASE_URL}/api/images/${currentPreviewImageId}/attribute`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ custom_attribute: inputVal })
        });

        if (res.ok) {
            btn.innerText = "✅";
            
            if(window.imageMetaData[currentPreviewImageId]) {
                window.imageMetaData[currentPreviewImageId].attribute = inputVal;
            }
            
            const attrText = document.getElementById('previewAttributeText');
            if (inputVal.trim() !== '') {
                attrText.innerText = "↳ " + inputVal;
                attrText.style.display = 'block';
            } else {
                attrText.style.display = 'none';
            }
            
            setTimeout(() => {
                document.getElementById('attributeInputContainer').style.display = 'none';
                btn.innerText = originalText;
                btn.disabled = false;
                fetchDatabaseStats();
            }, 1000);
        } else {
            alert("Failed to save attribute.");
            btn.innerText = originalText;
            btn.disabled = false;
        }
    } catch (e) {
        console.error(e);
        alert("Network error saving attribute.");
        btn.innerText = originalText;
        btn.disabled = false;
    }
};

function openImagePreview(imgId) {
    const data = window.imageMetaData ? window.imageMetaData[imgId] : null;
    if (!data) return;

    currentPreviewImageId = imgId;

    const pImg = document.getElementById('previewImageSrc');
    const pType = document.getElementById('previewType');
    const pConf = document.getElementById('previewConfidence');
    const pSev = document.getElementById('previewSeverity');
    const pSize = document.getElementById('previewSize');
    const pSpan = document.getElementById('previewSpan');
    const pDate = document.getElementById('previewDate');
    const pGpsLink = document.getElementById('gpsMapLink');
    const pGpsText = document.getElementById('gpsTextDisplay');
    const attrInput = document.getElementById('customAttributeInput');
    const attrText = document.getElementById('previewAttributeText');
    const attrContainer = document.getElementById('attributeInputContainer');
    
    const pBridgeName = document.getElementById('previewBridgeName');
    const pBridgeCode = document.getElementById('previewBridgeCode');
    
    const flagBtn = document.getElementById('flagRetrainBtn');
    if (flagBtn) {
        flagBtn.innerText = '🚩 AI Missed Something (Flag)';
        flagBtn.style.background = '#8b5cf6';
        flagBtn.style.borderColor = '#7c3aed';
        flagBtn.disabled = false;
    }
    
    const modal = document.getElementById('imagePreviewModal');

    if(pBridgeName) pBridgeName.innerText = data.bridgeName;
    if(pBridgeCode) pBridgeCode.innerText = data.bridgeCode;

    if(pImg) pImg.src = data.url;
    if(pType) pType.innerText = data.type;
    if(pConf) pConf.innerText = data.confidence;
    
    let sevClass = 'badge-fair';
    if(data.severity === 'Bad') sevClass = 'badge-bad';
    else if(data.severity === 'Poor') sevClass = 'badge-poor';
    else if(data.severity === 'Pending') sevClass = 'badge-pending';

    if(pSev) pSev.innerHTML = `<span class="health-badge ${sevClass}" style="margin:0; font-size: 13px; padding: 6px 12px;">${data.severity.toUpperCase()}</span>`;
    if(pSize) pSize.innerText = data.size;
    if(pSpan) pSpan.innerText = data.span;
    if(pDate) pDate.innerText = data.date;
    
    if(attrContainer) attrContainer.style.display = 'none';
    if(attrInput) attrInput.value = data.attribute || '';
    if(attrText) {
        if (data.attribute && data.attribute.trim() !== '') {
            attrText.innerText = "↳ " + data.attribute;
            attrText.style.display = 'block';
        } else {
            attrText.style.display = 'none';
        }
    }

    if (data.lat && data.lon && data.lat !== 0.0 && data.lon !== 0.0) {
        if(pGpsLink) {
            pGpsLink.style.display = 'inline';
            pGpsLink.href = `http://googleusercontent.com/maps.google.com/maps?q=${data.lat},${data.lon}`;
        }
        if(pGpsText) pGpsText.innerText = `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`;
    } else {
        if(pGpsLink) pGpsLink.style.display = 'none';
        if(pGpsText) pGpsText.innerText = "GPS Data Unavailable";
    }

    if(modal) modal.style.display = 'flex';
}

window.openLivePreview = function(url) {
    currentPreviewImageId = null;
    const pImg = document.getElementById('previewImageSrc');
    const pType = document.getElementById('previewType');
    const pConf = document.getElementById('previewConfidence');
    const pSev = document.getElementById('previewSeverity');
    const pSize = document.getElementById('previewSize');
    const pSpan = document.getElementById('previewSpan');
    const pDate = document.getElementById('previewDate');
    const pGpsLink = document.getElementById('gpsMapLink');
    const pGpsText = document.getElementById('gpsTextDisplay');
    
    const attrInput = document.getElementById('customAttributeInput');
    const attrText = document.getElementById('previewAttributeText');
    const attrContainer = document.getElementById('attributeInputContainer');
    const attrBtn = document.getElementById('addAttrBtn');
    
    const pBridgeName = document.getElementById('previewBridgeName');
    const pBridgeCode = document.getElementById('previewBridgeCode');
    const bridgeSelect = document.getElementById('flightBridgeSelect');
    const flagBtn = document.getElementById('flagRetrainBtn');
    
    if (flagBtn) flagBtn.style.display = 'none'; 
    
    let liveBName = 'Active Flight Zone';
    let liveBCode = '';
    if (bridgeSelect && bridgeSelect.value) {
        const b = liveBridgeData.find(b => b.db_id === parseInt(bridgeSelect.value));
        if (b) {
            liveBName = b.name;
            liveBCode = b.id;
        }
    }
    
    if(pBridgeName) pBridgeName.innerText = liveBName;
    if(pBridgeCode) pBridgeCode.innerText = liveBCode;
    
    const modal = document.getElementById('imagePreviewModal');

    if(pImg) pImg.src = url;
    if(pType) pType.innerText = 'Raw Unprocessed Frame';
    if(pConf) pConf.innerText = 'N/A';
    if(pSev) pSev.innerHTML = `<span class="health-badge badge-pending" style="margin:0; font-size: 13px; padding: 6px 12px;">AWAITING AI</span>`;
    if(pSize) pSize.innerText = 'N/A';
    if(pSpan) pSpan.innerText = 'Active Flight Zone';
    
    const now = new Date();
    if(pDate) pDate.innerText = now.toLocaleString('en-US', { timeZone: 'Asia/Manila' });
    
    if(pGpsLink) pGpsLink.style.display = 'none';
    if(pGpsText) pGpsText.innerText = "Syncing live telemetry...";
    
    if(attrBtn) attrBtn.style.display = 'none';
    if(attrContainer) attrContainer.style.display = 'none';
    if(attrText) attrText.style.display = 'none';

    if(modal) modal.style.display = 'flex';
};

window.closeImagePreview = function(event) {
    if (event && event.target.id !== 'imagePreviewModal' && !event.target.classList.contains('close-preview')) return;
    const modal = document.getElementById('imagePreviewModal');
    const pImg = document.getElementById('previewImageSrc');
    const attrBtn = document.getElementById('addAttrBtn');
    const flagBtn = document.getElementById('flagRetrainBtn');
    
    if(modal) modal.style.display = 'none';
    if(pImg) pImg.src = '';
    if(attrBtn) attrBtn.style.display = 'inline-block'; 
    if(flagBtn) flagBtn.style.display = 'block';
    
    currentPreviewImageId = null;
};

async function fetchDatabaseStats() {
    try {
        const response = await fetch(`${BASE_URL}/api/bridge-data?t=${new Date().getTime()}`);
        const data = await response.json();

        if (data.status === "success") {
            liveBridgeData = data.bridges;
            
            try { renderAnalytics(data.stats); } catch(e) { console.error("Analytics rendering bypassed.", e); }
            try { renderBridges(liveBridgeData); } catch(e) { console.error("Bridge rendering bypassed.", e); }
            try { populateFlightDropdown(); } catch(e) { console.error("Dropdown rendering bypassed.", e); }
            
            if(currentActiveBridge) {
                const refreshedBridge = liveBridgeData.find(b => b.db_id === currentActiveBridge.db_id);
                if(refreshedBridge) {
                    currentActiveBridge = refreshedBridge;
                    if(currentActiveMission) {
                        showMissionDetails(currentActiveMission);
                    } else {
                        showBridgeDetails(refreshedBridge);
                    }
                } else {
                    showBridgeList();
                }
            }
        }
    } catch (error) { 
        console.error("Failed to connect to backend:", error); 
    }
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

function renderAnalytics(stats) {
    const tbVal = document.getElementById('totalBridgesValue');
    if(tbVal) tbVal.innerText = stats.total_bridges;

    let healthCounts = { 'Bad': 0, 'Poor': 0, 'Fair': 0 };

    liveBridgeData.forEach(bridge => {
        healthCounts[getBridgeHealth(bridge)]++;
    });

    const cH = document.getElementById('countHigh');
    const cR = document.getElementById('countReview');
    const cL = document.getElementById('countLow');
    
    if(cH) cH.innerText = healthCounts['Bad'];
    if(cR) cR.innerText = healthCounts['Poor'];
    if(cL) cL.innerText = healthCounts['Fair'];

    const canvas = document.getElementById('globalConditionChart');
    if(canvas) {
        const ctx = canvas.getContext('2d');
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
}

function renderBridges(bridges) {
    const bridgeGrid = document.getElementById('bridgeGrid');
    if(!bridgeGrid) return;
    
    bridgeGrid.innerHTML = ''; 
    
    bridges.forEach(bridge => {
        let bridgeHealth = getBridgeHealth(bridge);

        let badgeClass = 'badge-fair'; let badgeText = 'Fair';
        if (bridgeHealth === 'Bad') { badgeClass = 'badge-bad'; badgeText = 'Bad'; } 
        else if (bridgeHealth === 'Poor') { badgeClass = 'badge-poor'; badgeText = 'Poor'; }

        const card = document.createElement('div');
        card.className = 'bridge-card';
        card.setAttribute('onclick', `openBridgeView(${bridge.db_id})`);
        
        card.innerHTML = `
            <div class="bridge-info">
                <h3>${bridge.name} <span class="health-badge ${badgeClass}">${badgeText}</span></h3>
                <p>${bridge.location}</p>
            </div>
            <div style="display: flex; align-items: center; gap: 10px;">
                <span class="bridge-id">${bridge.id}</span>
                <button class="btn btn-primary" onclick="event.stopPropagation(); openBridgeView(${bridge.db_id})" style="padding: 6px 12px; margin: 0; font-size: 13px; background: #3b82f6; border: none;">View</button>
                <button class="btn-edit" onclick="event.stopPropagation(); openBridgeModal(${bridge.db_id})">✏️ Edit</button>
                <button class="btn-edit" onclick="event.stopPropagation(); deleteBridge(${bridge.db_id})" style="color: #ef4444; border-color: #fca5a5;">🗑️ Delete</button>
            </div>
        `;
        bridgeGrid.appendChild(card);
    });
}

function showBridgeList() {
    currentActiveBridge = null; currentActiveMission = null;
    const lv = document.getElementById('bridgeListView');
    const dv = document.getElementById('bridgeDetailView');
    const mv = document.getElementById('missionDetailView');
    
    if(lv) lv.style.display = 'block';
    if(dv) dv.style.display = 'none';
    if(mv) mv.style.display = 'none';
}

function showBridgeDetails(bridge) {
    currentActiveBridge = bridge; currentActiveMission = null;
    
    const lv = document.getElementById('bridgeListView');
    const dv = document.getElementById('bridgeDetailView');
    const mv = document.getElementById('missionDetailView');
    
    if(lv) lv.style.display = 'none';
    if(mv) mv.style.display = 'none';
    if(dv) dv.style.display = 'block';

    const dn = document.getElementById('detailName');
    const dl = document.getElementById('detailLocation');
    const di = document.getElementById('detailId');
    
    if(dn) dn.innerText = bridge.name;
    if(dl) dl.innerText = bridge.location;
    if(di) di.innerText = bridge.id;

    let bridgeHealth = getBridgeHealth(bridge); 

    const badge = document.getElementById('bridgeConditionBadge');
    const remarks = document.getElementById('bridgeRemarks');
    
    if(badge && remarks) {
        if (bridgeHealth === 'Bad') {
            badge.className = 'status-badge status-bad';
            badge.innerHTML = '🚨 Condition: BAD (Critical)';
            remarks.value = bridge.remarks || "CRITICAL CONDITION: Major structural anomalies detected.";
        } else if (bridgeHealth === 'Poor') {
            badge.className = 'status-badge status-poor';
            badge.innerHTML = '⚠️ Condition: POOR (Monitor)';
            remarks.value = bridge.remarks || "MODERATE DETERIORATION: Continue monitoring required.";
        } else {
            badge.className = 'status-badge status-fair';
            badge.innerHTML = '✅ Condition: FAIR (Safe)';
            remarks.value = bridge.remarks || "SAFE CONDITION: Structure displaying normal wear.";
        }
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
            else if (severity !== 'Pending') severityCounts['Fair']++; 
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

    const canvas = document.getElementById('defectChart');
    if(canvas) {
        const ctx = canvas.getContext('2d');
        if (detailChartInstance) detailChartInstance.destroy();
        detailChartInstance = new Chart(ctx, {
            type: 'pie',
            data: { labels: labels, datasets: [{ data: chartData, backgroundColor: colors, borderWidth: 1 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
        });
    }

    const missionGrid = document.getElementById('missionListGrid');
    if(!missionGrid) return;
    
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
        
        if (mission.status === 'Awaiting Analysis') {
            urgentBadge = `<span style="color:#8b5cf6; font-size:12px; display:block; margin-top:3px;">🧠 Raw Data Ready for AI</span>`;
        } else if (urgentCount > 0) {
            urgentBadge = `<span style="color:#ef4444; font-size:12px; display:block; margin-top:3px;">⚠️ ${urgentCount} Bad Condition Issues</span>`;
        } else if (mImgs.length === 0) {
            urgentBadge = `<span style="color:#10b981; font-size:12px; display:block; margin-top:3px;">✅ No Defects Detected</span>`;
        }

        const card = document.createElement('div');
        card.className = 'mission-card';
        card.setAttribute('onclick', `openMissionView(${mId})`);
        card.innerHTML = `
            <div><div class="mission-card-title">${label}</div><div class="mission-card-subtitle">Status: ${mission.status}</div>${urgentBadge}</div>
            <div class="mission-card-stats">${mImgs.length} Images</div>
        `;
        missionGrid.appendChild(card);
    });
}

window.backToBridgeDetails = function() { 
    if(currentActiveBridge) showBridgeDetails(currentActiveBridge); 
};

function showMissionDetails(missionId) {
    currentActiveMission = missionId;
    const dv = document.getElementById('bridgeDetailView');
    const mv = document.getElementById('missionDetailView');
    const emergencyBtn = document.getElementById('emergencyResetBtn');
    
    if(dv) dv.style.display = 'none';
    if(mv) mv.style.display = 'block';

    const mt = document.getElementById('missionDetailTitle');
    if(mt) mt.innerText = `Flight Mission #${missionId}`;

    const targetMission = currentActiveBridge.missions.find(m => m.id === missionId);
    const missionStatus = targetMission ? targetMission.status : 'Unknown';

    const actionContainer = document.getElementById('missionActionContainer');
    const chartContainer = document.getElementById('defectChartContainer');
    const deleteControls = document.getElementById('deleteControls');
    
    const aiTitle = document.getElementById('aiActionTitle');
    const aiDesc = document.getElementById('aiActionDesc');
    const aiBtn = document.getElementById('runAiBtn');

    if(actionContainer) actionContainer.style.display = 'block';

    if(deleteControls) deleteControls.style.display = 'flex';
    cancelDeleteMode();

    if (missionStatus === 'Awaiting Analysis' || missionStatus === 'Processing') {
        if(chartContainer) chartContainer.style.display = 'none';
        
        if(aiTitle) aiTitle.innerText = "Data Ready for Analysis";
        if(aiDesc) aiDesc.innerHTML = "Raw images securely backed up. Configure parameters in <b>Settings</b>, then run YOLO AI.";
        if(aiBtn) {
            aiBtn.innerHTML = "🧠 RUN AI ANALYSIS";
            aiBtn.style.background = "#8b5cf6";
            aiBtn.disabled = false; 
        }
        
        if (missionStatus === 'Processing' && emergencyBtn) {
            emergencyBtn.style.display = 'block';
            aiBtn.disabled = true; 
            aiBtn.innerHTML = "⚙️ PROCESSING...";
        } else if (emergencyBtn) {
            emergencyBtn.style.display = 'none';
        }

    } else {
        if(chartContainer) chartContainer.style.display = 'block';
        isDeleteMode = false;
        if(emergencyBtn) emergencyBtn.style.display = 'none';
        
        if(aiTitle) aiTitle.innerText = "Re-Run AI Analysis";
        if(aiDesc) aiDesc.innerHTML = "Want to scan with different confidence or resolution? Update your <b>Settings</b> and re-scan this flight.";
        if(aiBtn) {
            aiBtn.innerHTML = "🔄 RE-SCAN MISSION";
            aiBtn.style.background = "#3b82f6"; 
            aiBtn.disabled = false; 
        }
    }

    const allImages = currentActiveBridge.images || [];
    const missionImages = allImages.filter(img => String(img.mission_id) === String(missionId));
    
    const ms = document.getElementById('missionDetailSubtitle');
    if(ms) {
        if(missionImages.length === 0) {
             ms.innerText = `✅ Clean Inspection: No structural defects detected during this mission.`;
        } else {
             ms.innerText = `${missionImages.length} Data points captured for ${currentActiveBridge.name}`;
        }
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

    const canvas = document.getElementById('missionDefectChart');
    if(canvas) {
        const ctx = canvas.getContext('2d');
        if (missionChartInstance) missionChartInstance.destroy();
        missionChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: { labels: labels, datasets: [{ data: chartData, backgroundColor: colors, borderWidth: 1 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } }, cutout: '50%' }
        });
    }

    const ft = document.getElementById('filterType');
    if(ft) ft.value = 'all'; 
    
    applyGalleryFilters();
}

window.startAiAnalysis = async function() {
    if (!currentActiveMission) return;
    
    cancelDeleteMode();
    const delCtrls = document.getElementById('deleteControls');
    if(delCtrls) delCtrls.style.display = 'none';
    
    const btn = document.getElementById('runAiBtn');
    const emergencyBtn = document.getElementById('emergencyResetBtn');
    const progressContainer = document.getElementById('analysisProgressBarContainer');
    const progressBar = document.getElementById('analysisProgressBar');
    const progressText = document.getElementById('analysisProgressText');

    const savedConf = localStorage.getItem('aiConfThreshold') || '50';
    const savedSize = localStorage.getItem('aiImgSize') || '640';
    
    const confVal = parseInt(savedConf) / 100.0;
    const imgSizeVal = parseInt(savedSize);

    if(btn) {
        btn.disabled = true;
        btn.innerHTML = '⚙️ RUNNING YOLO AI...';
        btn.style.background = '#f59e0b';
    }
    if (emergencyBtn) emergencyBtn.style.display = 'block';
    
    if(progressContainer) progressContainer.style.display = 'block';
    if(progressText) {
        progressText.style.display = 'block';
        progressText.innerText = 'Downloading images from Cloudinary...';
    }
    if(progressBar) progressBar.style.width = '0%';

    try {
        await fetch(`${BASE_URL}/api/mission/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                mission_id: currentActiveMission,
                conf_threshold: confVal,
                img_size: imgSizeVal
            })
        });
        
        const pollInterval = setInterval(async () => {
            const statusRes = await fetch(`${BASE_URL}/api/mission/${currentActiveMission}/status?t=${new Date().getTime()}`);
            const statusData = await statusRes.json();
            
            if (statusData.status === 'Processing') {
                if(progressBar) progressBar.style.width = `${statusData.progress}%`;
                if (statusData.total > 0 && progressText) {
                    progressText.innerText = `Analyzing Frames: ${statusData.processed} / ${statusData.total} Complete`;
                }
            }
            
            if(statusData.status === 'Completed' || statusData.status === 'Awaiting Analysis' || statusData.status === 'Unknown') {
                clearInterval(pollInterval);
                if(btn) {
                    btn.innerHTML = '✅ ANALYSIS COMPLETE';
                    btn.style.background = '#10b981';
                    btn.disabled = false;
                }
                if (emergencyBtn) emergencyBtn.style.display = 'none';
                if(progressText) progressText.innerText = 'Database updated successfully!';
                
                setTimeout(() => { fetchDatabaseStats(); }, 1500);
            }
        }, 1000); 
    } catch (e) {
        console.error("AI Error:", e);
        if(btn) {
            btn.disabled = false;
            btn.innerHTML = '❌ ERROR. TRY AGAIN.';
            btn.style.background = '#ef4444';
        }
    }
};

window.applyGalleryFilters = function() {
    if (!currentActiveBridge || !currentActiveMission) return;
    const allImages = currentActiveBridge.images || [];
    const missionImages = allImages.filter(img => String(img.mission_id) === String(currentActiveMission));
    
    const ft = document.getElementById('filterType');
    const selectedType = ft ? ft.value.toLowerCase() : 'all';
    
    const filteredImages = missionImages.filter(img => {
        const imgType = (img.defect_type || img.type || 'Unknown').toLowerCase();
        return selectedType === 'all' || imgType.includes(selectedType);
    });
    
    renderImageGallery(filteredImages);
};

function renderImageGallery(images) {
    const containerDefects = document.getElementById('galleryContainerDefects');
    const containerRaw = document.getElementById('galleryContainerRaw');
    
    if(!containerDefects || !containerRaw) return;
    
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

    const bName = currentActiveBridge ? currentActiveBridge.name : 'Unknown Structure';
    const bCode = currentActiveBridge ? currentActiveBridge.id : 'Unknown Code';

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
            let typeHtml = `<strong style="color: #dc2626;"> Type:</strong> <strong>${defectType}</strong>`;
            let statusHtml = '';
            
            if (defectSeverity === 'Pending') {
                topBadge = `<span class="health-badge badge-pending" style="position: absolute; top: 8px; right: 8px;">⏳ AWAITING AI</span>`;
                typeHtml = `<strong>📸 Capture:</strong> <strong style="color:#64748b;">Raw Surface</strong>`;
                statusHtml = `<p class="text-muted" style="font-size: 12px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: center;">☁️ Stored in Cloud</p>`;
            } else if (defectType === 'Raw Image') {
                topBadge = `<span class="health-badge badge-fair" style="position: absolute; top: 8px; right: 8px;">✅ ANALYZED - SAFE</span>`;
                typeHtml = `<strong>📸 Capture:</strong> <strong style="color:#10b981;">Clean Structure</strong>`;
                statusHtml = `<p class="text-muted" style="font-size: 12px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: center;">Verified by AI</p>`;
            } else {
                if (defectSeverity === 'Critical' || defectSeverity === 'High') defectSeverity = 'Bad';
                if (defectSeverity === 'Review Needed') defectSeverity = 'Poor';
                
                let badgeColorClass = defectSeverity === 'Bad' ? 'badge-bad' : (defectSeverity === 'Poor' ? 'badge-poor' : 'badge-fair');
                topBadge = `<span class="health-badge ${badgeColorClass}" style="position: absolute; top: 8px; right: 8px;">${defectSeverity.toUpperCase()}</span>`;
                statusHtml = `<p class="text-muted" style="font-size: 12px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #cbd5e1; text-align: center;"> Defect Logged in Database</p>`;
            }
            
            let dateStr = 'Recent Capture';
            const rawDate = img.date || img.created_at || img.captured_at;
            if (rawDate) {
                const utcStr = rawDate.toString().endsWith('Z') ? rawDate : rawDate + 'Z';
                const d = new Date(utcStr);
                dateStr = d.toLocaleString('en-US', { 
                    timeZone: 'Asia/Manila',
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
            }
            
            let gpsHtml = '';
            if (img.lat && img.lon && img.lat !== 0.0 && img.lon !== 0.0) {
                gpsHtml = `<p class="text-muted" style="font-size: 11px; margin-bottom: 5px; font-family: monospace;">📍 ${img.lat.toFixed(5)}, ${img.lon.toFixed(5)}</p>`;
            } else {
                gpsHtml = `<p class="text-muted" style="font-size: 11px; margin-bottom: 5px; font-style: italic;">📍 GPS Unavailable</p>`;
            }
            
            window.imageMetaData[img.id] = {
                url: imgSrc,
                type: defectType,
                severity: defectSeverity,
                date: dateStr,
                span: span,
                size: img.size && img.size !== 'N/A' ? img.size : 'N/A',
                confidence: img.confidence && img.confidence !== 'N/A' ? img.confidence : 'N/A',
                lat: img.lat || 0.0,
                lon: img.lon || 0.0,
                attribute: img.attribute || '',
                bridgeName: bName, 
                bridgeCode: bCode  
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
                    <p class="text-muted" style="font-size: 11px; margin-bottom: 2px;"><b>${bName}</b> (${bCode})</p>
                    <p class="text-muted" style="font-size: 11px; margin-bottom: 2px;">🕒 ${dateStr}</p>
                    ${gpsHtml}
                    ${statusHtml}
                </div>
            `;
            grid.appendChild(card);
        });
        spanGroup.appendChild(grid);
        container.appendChild(spanGroup);
    });
}

window.openBridgeModal = function(db_id = null) {
    const modal = document.getElementById('bridgeModal');
    const title = document.getElementById('bridgeModalTitle');
    
    if (db_id) {
        if(title) title.innerText = 'Edit Bridge Parameters';
        const bridge = liveBridgeData.find(b => b.db_id === db_id);
        if(document.getElementById('modalBridgeId')) document.getElementById('modalBridgeId').value = bridge.db_id;
        if(document.getElementById('modalBridgeCode')) document.getElementById('modalBridgeCode').value = bridge.id; 
        if(document.getElementById('modalBridgeName')) document.getElementById('modalBridgeName').value = bridge.name;
        if(document.getElementById('modalBridgeLocation')) document.getElementById('modalBridgeLocation').value = bridge.location;
        if(document.getElementById('modalBridgeRemarks')) document.getElementById('modalBridgeRemarks').value = bridge.remarks || '';
        if(document.getElementById('modalBridgeSpanCount')) document.getElementById('modalBridgeSpanCount').value = bridge.span_count || 1;
    } else {
        if(title) title.innerText = 'Add New Bridge';
        if(document.getElementById('modalBridgeId')) document.getElementById('modalBridgeId').value = '';
        if(document.getElementById('modalBridgeCode')) document.getElementById('modalBridgeCode').value = '';
        if(document.getElementById('modalBridgeName')) document.getElementById('modalBridgeName').value = '';
        if(document.getElementById('modalBridgeLocation')) document.getElementById('modalBridgeLocation').value = '';
        if(document.getElementById('modalBridgeRemarks')) document.getElementById('modalBridgeRemarks').value = '';
        if(document.getElementById('modalBridgeSpanCount')) document.getElementById('modalBridgeSpanCount').value = 1;
    }
    if(modal) modal.style.display = 'flex';
};

// =========================================
// COLAB CODE COPY FUNCTION
// =========================================
window.copyColabCode = function() {
    const codeElement = document.getElementById('colabCodeSnippet');
    const btn = document.getElementById('copyColabBtn');

    navigator.clipboard.writeText(codeElement.innerText).then(() => {
        const originalText = btn.innerHTML;
        btn.innerHTML = "✅ Copied!";
        btn.style.background = "#10b981"; 
        btn.style.borderColor = "#059669";

        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.style.background = "#3b82f6";
            btn.style.borderColor = "transparent";
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy text: ', err);
        alert("Failed to copy code to clipboard.");
    });
};

window.closeBridgeModal = function() {
    const modal = document.getElementById('bridgeModal');
    if(modal) modal.style.display = 'none';
};

window.saveBridge = async function() {
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
    const url = db_id ? `${BASE_URL}/api/bridges/${db_id}` : `${BASE_URL}/api/bridges`;

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.status === 'success') {
            window.closeBridgeModal();
            fetchDatabaseStats(); 
        } else alert('Database update failed.');
    } catch (error) { console.error("Network Error:", error); }
};

window.saveBridgeRemarks = async function() {
    if (!currentActiveBridge) return;
    const newRemarks = document.getElementById('bridgeRemarks').value;
    const btn = document.querySelector('.remarks-section .btn-primary');
    if(btn) btn.innerText = "Saving...";
    
    try {
        const response = await fetch(`${BASE_URL}/api/bridges/${currentActiveBridge.db_id}/remarks`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ remarks: newRemarks })
        });
        
        if(response.ok) {
            if(btn) btn.innerText = "✅ Saved Successfully!";
            fetchDatabaseStats(); 
            setTimeout(() => { if(btn) btn.innerText = "💾 Save Remarks"; }, 2000);
        }
    } catch (e) {
        console.error("Save failed", e);
        if(btn) btn.innerText = "💾 Save Remarks";
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const streamImg = document.getElementById('liveVideoStream');
    const offlineOverlay = document.getElementById('offlineOverlay');

    if (streamImg) {
        streamImg.onerror = function() {
            this.style.display = 'none';
            if(offlineOverlay) offlineOverlay.style.display = 'flex';
            logToTerminal(`> WARNING: Video stream connection lost.`, '#EF4444');
        };
        streamImg.onload = function() {
            this.style.display = 'block';
            if(offlineOverlay) offlineOverlay.style.display = 'none';
        };
    }
});

window.retryStream = function() {
    const streamImg = document.getElementById('liveVideoStream');
    const offlineOverlay = document.getElementById('offlineOverlay');
    logToTerminal(`> Attempting to re-establish video link...`, '#FACC15');
    if(offlineOverlay) offlineOverlay.style.display = 'none'; 
    if(streamImg) {
        streamImg.style.display = 'block';
        streamImg.src = `${BASE_URL}/video_feed?t=` + new Date().getTime();
    }
};

function populateFlightDropdown() {
    const select = document.getElementById('flightBridgeSelect');
    if(!select) return;
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
    if(!terminal) return;
    const time = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Manila' });
    terminal.innerHTML += `<span style="color:${color}">[${time}] ${msg}</span><br>`;
    terminal.scrollTop = terminal.scrollHeight;
}

window.setFlightSpan = async function(span, btnElement) {
    const fsi = document.getElementById('flightSpanInput');
    if(fsi) fsi.value = span;
    
    document.querySelectorAll('.span-btn').forEach(b => b.classList.remove('active'));
    if(btnElement) btnElement.classList.add('active');
    
    if(isFlightActive) {
        try {
            const res = await fetch(`${BASE_URL}/api/mission/span`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ span_target: span })
            });
            if(res.ok) logToTerminal(`> Flight Zone dynamically shifted to: ${span}`, '#22C55E');
        } catch(e) { console.error("Failed to update span mid-flight:", e); }
    } else {
        logToTerminal(`> Target Zone set to: ${span}`, '#38BDF8');
    }
};

async function fetchLiveCaptures() {
    if (!currentActiveMission) return;
    try {
        const gallery = document.getElementById('liveCaptureGallery');
        
        if (isFlightActive && gallery) {
            const res = await fetch(`${BASE_URL}/api/mission/${currentActiveMission}/live_frames?t=${new Date().getTime()}`);
            const data = await res.json();
            if (data.status === 'success' && data.frames.length > 0) {
                gallery.innerHTML = data.frames.map(f => `
                    <div class="live-capture-card" onclick="openLivePreview('${BASE_URL}${f.url}')">
                        <span class="health-badge badge-fair" style="position: absolute; top: 5px; right: 5px;">Raw Frame</span>
                        <img src="${BASE_URL}${f.url}" alt="Raw Capture">
                        <div class="live-capture-info">Captured</div>
                    </div>
                `).join('');
                
                gallery.scrollTop = gallery.scrollHeight; 
            }
        }
    } catch(e) { console.error("Capture sync error:", e); }
}

window.triggerManualCapture = async function() {
    const btn = document.getElementById('manualCaptureBtn');
    if(!btn) return;
    
    btn.disabled = true;
    btn.innerText = "📸 SNAP REQUEST SENT...";
    btn.style.background = "#f59e0b";
    btn.style.borderColor = "#b45309";
    
    try {
        const res = await fetch(`${BASE_URL}/api/mission/capture`, { method: 'POST' });
        if(res.ok) {
            logToTerminal(`> 📸 Manual Capture signal transmitted to Drone.`, '#FACC15');
            setTimeout(() => {
                btn.disabled = false;
                btn.innerText = "📸 SNAP PHOTO NOW";
                btn.style.background = "#3b82f6";
                btn.style.borderColor = "#1d4ed8";
            }, 1500); 
        }
    } catch(e) {
        console.error("Capture trigger failed", e);
        btn.disabled = false;
        btn.innerText = "❌ ERROR: RETRY SNAP";
        btn.style.background = "#ef4444";
    }
};

window.toggleFlightMission = async function() {
    const btn = document.getElementById('toggleMissionBtn');
    const bridgeSelect = document.getElementById('flightBridgeSelect');
    const spanInput = document.getElementById('flightSpanInput');
    const modeSelect = document.getElementById('flightCaptureMode'); 
    const manualBtn = document.getElementById('manualCaptureBtn'); 
    
    const progressContainer = document.getElementById('aiProgressBarContainer');
    const progressBar = document.getElementById('aiProgressBar');
    const progressText = document.getElementById('aiProgressText');

    if (!isFlightActive) {
        const bridgeId = parseInt(bridgeSelect.value);
        const captureMode = modeSelect ? modeSelect.value : "auto";

        if(isNaN(bridgeId)) return alert("Please select a target bridge from the dropdown.");
        if(!spanInput.value) return alert("Please select a target span.");

        try {
            const res = await fetch(`${BASE_URL}/api/mission/start`, {
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ 
                    bridge_id: bridgeId, 
                    span_target: spanInput.value,
                    capture_mode: captureMode 
                })
            });
            const data = await res.json();
            
            if(data.status === "success") {
                isFlightActive = true;
                currentActiveMission = data.mission_id;
                bridgeSelect.disabled = true;
                if(modeSelect) modeSelect.disabled = true;
                
                if(btn) {
                    btn.innerHTML = '🛑 STOP MISSION & SAVE DATA';
                    btn.style.background = '#EF4444';
                }
                
                logToTerminal(`> MISSION #${data.mission_id} INITIATED.`, '#22C55E');
                
                const lcg = document.getElementById('liveCaptureGallery');
                
                if(captureMode === "manual") {
                    logToTerminal(`> 📸 Manual Mode Active. Awaiting Pilot command to capture...`, '#FACC15');
                    if(manualBtn) manualBtn.style.display = 'block';
                    if(lcg) lcg.innerHTML = '<p class="text-muted" style="margin-top: 10px;">📸 Awaiting Pilot manual capture command...</p>';
                } else {
                    logToTerminal(`> ⏱️ Auto Mode Active. Capturing frames automatically...`, '#FACC15');
                    if(lcg) lcg.innerHTML = '<p class="text-muted" style="margin-top: 10px;">📸 Awaiting first high-res frame from drone...</p>';
                }
                
                liveCaptureInterval = setInterval(fetchLiveCaptures, 2000);
            }
        } catch (e) { logToTerminal(`> ERROR starting mission: ${e}`, '#EF4444'); }
    } else {
        clearInterval(liveCaptureInterval);
        
        if(manualBtn) manualBtn.style.display = 'none'; 
        
        if(btn) {
            btn.innerHTML = '☁️ UPLOADING TO CLOUD...';
            btn.disabled = true;
            btn.style.background = '#F59E0B'; 
        }
        
        if(progressContainer) progressContainer.style.display = 'block';
        if(progressText) {
            progressText.style.display = 'block';
            progressText.innerText = 'Securing files to Cloudinary...';
        }
        if(progressBar) progressBar.style.width = '0%';

        logToTerminal(`> Mission stopped. Saving raw data securely to Cloudinary Database...`, '#F59E0B');
        
        try {
            await fetch(`${BASE_URL}/api/mission/stop`, { method: 'POST' });
            isFlightActive = false;
            
            const pollInterval = setInterval(async () => {
                const statusRes = await fetch(`${BASE_URL}/api/mission/${currentActiveMission}/status?t=${new Date().getTime()}`);
                const statusData = await statusRes.json();
                
                if (statusData.status === 'Saving to Cloud') {
                    if(progressBar) progressBar.style.width = `${statusData.progress}%`;
                    if (statusData.total > 0 && progressText) {
                        progressText.innerText = `Uploading Frames: ${statusData.processed} / ${statusData.total} Secured`;
                    }
                }
                
                if(statusData.status === 'Awaiting Analysis' || statusData.status === 'Unknown') {
                    clearInterval(pollInterval);
                    
                    if(progressContainer) progressContainer.style.display = 'none';
                    if(progressText) progressText.style.display = 'none';
                    
                    if(btn) {
                        btn.disabled = false;
                        btn.innerHTML = '▶ START MISSION';
                        btn.style.background = '#10B981';
                    }
                    
                    logToTerminal(`> ✅ Cloud Upload Complete! Open the Database to run AI Analysis.`, '#22C55E');
                    
                    fetchDatabaseStats(); 
                    currentActiveMission = null;
                    if(bridgeSelect) bridgeSelect.disabled = false;
                    if(modeSelect) modeSelect.disabled = false;
                    
                    const lcg = document.getElementById('liveCaptureGallery');
                    if(lcg) lcg.innerHTML = '<p class="text-muted" style="margin-top: 10px;">✅ Mission Saved.</p>';
                }
            }, 1000); 
            
        } catch (e) {
            logToTerminal(`> ERROR stopping mission: ${e}`, '#EF4444');
            if(btn) btn.disabled = false;
        }
    }
};