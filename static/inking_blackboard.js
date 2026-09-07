const slideCanvas = document.getElementById('slideInkCanvas');
const slideCtx = slideCanvas.getContext('2d');
const boardCanvas = document.getElementById('boardInkCanvas');
const boardCtx = boardCanvas.getContext('2d');

let isPenDrawing = false; 
let isPenLocked = false; 
let isPenModeActive = false; // New state variable

// By default, let clicks pass THROUGH the canvas to the slide & media drawer
if (slideCanvas) {
    slideCanvas.style.pointerEvents = 'none';
}

// --- Pen Toggle Logic ---
function togglePenMode() {
    isPenModeActive = !isPenModeActive;
    const btn = document.getElementById('penToggleBtn');
    
    if (isPenModeActive) {
        btn.style.color = 'var(--math-color)'; 
        btn.style.background = 'rgba(56, 189, 248, 0.2)';
        btn.style.borderRadius = '6px';
        // Allow the canvas to catch ink strokes
        slideCanvas.style.pointerEvents = 'auto'; 
    } else {
        btn.style.color = 'white';
        btn.style.background = 'transparent';
        // Let clicks pass through to the media drawer and slide steps
        slideCanvas.style.pointerEvents = 'none'; 
    }
}

// Match canvas to window size and explicitly set blackboard internal resolution
function resizeCanvases() {
    let tempCanvas = document.createElement('canvas');
    let tempCtx = tempCanvas.getContext('2d');
    tempCanvas.width = slideCanvas.width || slideCanvas.offsetWidth;
    tempCanvas.height = slideCanvas.height || slideCanvas.offsetHeight;
    if (slideCanvas.width > 0 && slideCanvas.height > 0) {
        tempCtx.drawImage(slideCanvas, 0, 0);
    }
    
    slideCanvas.width = slideCanvas.offsetWidth;
    slideCanvas.height = slideCanvas.offsetHeight;
    slideCtx.drawImage(tempCanvas, 0, 0);
    
    if (boardCanvas.width !== 2500) {
        boardCanvas.width = 2500;
        boardCanvas.height = 2500;
    }
}
window.addEventListener('resize', resizeCanvases);
resizeCanvases();

// Bezier Tracker State
let pointerState = { activeId: null, lastPt: {x:0, y:0}, lastMid: {x:0, y:0} };

function getThickness(pressure) {
    return 4 * (0.4 + (pressure * 0.8));
}

// --- Drawing Engine Functions ---
function startDraw(e, canvas, ctx) {
    // Abort if trying to draw on the slide while pen mode is off
    if (canvas === slideCanvas && !isPenModeActive) return;

    if (e.pointerType === "pen") isPenLocked = true;
    if (pointerState.activeId !== null) return;
    
    pointerState.activeId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);

    const rect = canvas.getBoundingClientRect();
    let startX = (e.clientX - rect.left) * (canvas.width / rect.width);
    let startY = (e.clientY - rect.top) * (canvas.height / rect.height);
    let pressure = e.pressure !== 0 ? e.pressure : 0.5;

    pointerState.lastPt = {x: startX, y: startY};
    pointerState.lastMid = {x: startX, y: startY};
    
    ctx.beginPath();
    ctx.arc(startX, startY, getThickness(pressure)/2, 0, Math.PI*2);
    ctx.fillStyle = "#fbbf24"; // Bright amber ink
    ctx.fill();
    isPenDrawing = true;
}

function continueDraw(e, canvas, ctx) {
    if (pointerState.activeId !== e.pointerId) return;

    const rect = canvas.getBoundingClientRect();
    let currentX = (e.clientX - rect.left) * (canvas.width / rect.width);
    let currentY = (e.clientY - rect.top) * (canvas.height / rect.height);
    let pressure = e.pressure !== 0 ? e.pressure : 0.5;

    let midX = (pointerState.lastPt.x + currentX) / 2;
    let midY = (pointerState.lastPt.y + currentY) / 2;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = getThickness(pressure);
    ctx.strokeStyle = "#fbbf24";

    ctx.beginPath();
    ctx.moveTo(pointerState.lastMid.x, pointerState.lastMid.y);
    ctx.quadraticCurveTo(pointerState.lastPt.x, pointerState.lastPt.y, midX, midY);
    ctx.stroke();

    pointerState.lastPt = {x: currentX, y: currentY};
    pointerState.lastMid = {x: midX, y: midY};
}

function endDraw(e, canvas) {
    if (pointerState.activeId !== e.pointerId) return;
    canvas.releasePointerCapture(e.pointerId);
    pointerState.activeId = null;
    
    setTimeout(() => { isPenDrawing = false; isPenLocked = false; }, 100);
}

// --- Wire up Slide Overlay Ink ---
slideCanvas.addEventListener('pointerdown', (e) => startDraw(e, slideCanvas, slideCtx));
slideCanvas.addEventListener('pointermove', (e) => continueDraw(e, slideCanvas, slideCtx));
slideCanvas.addEventListener('pointerup', (e) => endDraw(e, slideCanvas));

// --- Wire up Blackboard Ink ---
// (Blackboard always accepts ink, regardless of the Pen Mode toggle for the main slide)
boardCanvas.addEventListener('pointerdown', (e) => { e.stopPropagation(); startDraw(e, boardCanvas, boardCtx); });
boardCanvas.addEventListener('pointermove', (e) => { e.stopPropagation(); continueDraw(e, boardCanvas, boardCtx); });
boardCanvas.addEventListener('pointerup', (e) => { e.stopPropagation(); endDraw(e, boardCanvas); });

function clearSlideInk() {
    slideCtx.clearRect(0, 0, slideCanvas.width, slideCanvas.height);
}

// --- Floating Blackboard Logic ---
let isBbVisible = false;
function toggleFloatingBlackboard() {
    const bb = document.getElementById('floatingBlackboard');
    isBbVisible = !isBbVisible;
    bb.style.display = isBbVisible ? 'flex' : 'none';
}

function clearBlackboard() {
    boardCtx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);
}

// Draggable Blackboard Handle Logic
const bbHandle = document.getElementById('bbHandle');
const bbBoard = document.getElementById('floatingBlackboard');
let isDraggingBB = false, dragOffX = 0, dragOffY = 0;

bbHandle.addEventListener('pointerdown', (e) => {
    // Ignore clicks on buttons so they function normally
    if(e.target.closest('button')) return;
    isDraggingBB = true;
    const rect = bbBoard.getBoundingClientRect();
    dragOffX = e.clientX - rect.left;
    dragOffY = e.clientY - rect.top;
    bbHandle.setPointerCapture(e.pointerId);
});

bbHandle.addEventListener('pointermove', (e) => {
    if (!isDraggingBB) return;
    bbBoard.style.left = (e.clientX - dragOffX) + 'px';
    bbBoard.style.top = (e.clientY - dragOffY) + 'px';
});

bbHandle.addEventListener('pointerup', (e) => {
    isDraggingBB = false;
    try { bbHandle.releasePointerCapture(e.pointerId); } catch(e) {}
});