(() => {
  // ============ CONSTANTS ============
  const PALETTE = [
    '#000000','#434343','#666666','#999999','#b7b7b7','#cccccc','#d9d9d9','#ffffff',
    '#ff0000','#ff4444','#ff6600','#ff9900','#ffcc00','#ffff00','#ccff00','#66ff00',
    '#00ff00','#00ff66','#00ffcc','#00ffff','#00ccff','#0099ff','#0066ff','#0000ff',
    '#6600ff','#9900ff','#cc00ff','#ff00ff','#ff0099','#ff0066','#993300','#663300',
    '#cc6633','#ffcc99','#ffe0cc','#996633','#336633','#006666',
    '#003366','#333399','#663399','#993366',
  ];

  // ============ STATE ============
  let currentTool = 'brush';
  let currentColor = '#000000';
  let brushSize = 4;
  let opacity = 1;
  let fillShape = false;
  let layers = [];
  let activeLayerIdx = 0;
  let undoStack = [];
  let redoStack = [];
  let isDrawing = false;
  let startX = 0, startY = 0;
  let lastX = 0, lastY = 0;
  let textPos = null;

  // ============ ELEMENTS ============
  const canvasContainer = document.getElementById('canvasContainer');
  const mainCanvas = document.getElementById('drawCanvas');
  const previewCanvas = document.getElementById('previewCanvas');
  const mainCtx = mainCanvas.getContext('2d');
  const previewCtx = previewCanvas.getContext('2d');

  const colorPreview = document.getElementById('colorPreview');
  const colorPicker = document.getElementById('colorPicker');
  const colorPaletteEl = document.getElementById('colorPalette');
  const brushSizeSlider = document.getElementById('brushSize');
  const sizeValueEl = document.getElementById('sizeValue');
  const sizePreviewEl = document.getElementById('sizePreview');
  const opacitySlider = document.getElementById('opacitySlider');
  const opacityValueEl = document.getElementById('opacityValue');
  const shapeOptions = document.getElementById('shapeOptions');
  const fillShapeCheck = document.getElementById('fillShape');
  const layerListEl = document.getElementById('layerList');
  const addLayerBtn = document.getElementById('addLayerBtn');
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const clearBtn = document.getElementById('clearBtn');
  const saveBtn = document.getElementById('saveBtn');
  const cursorPosEl = document.getElementById('cursorPos');
  const canvasSizeEl = document.getElementById('canvasSize');

  // Text modal
  const textModal = document.getElementById('textModal');
  const textInput = document.getElementById('textInput');
  const fontFamily = document.getElementById('fontFamily');
  const fontSize = document.getElementById('fontSize');
  const fontBold = document.getElementById('fontBold');
  const fontItalic = document.getElementById('fontItalic');
  const textConfirm = document.getElementById('textConfirm');
  const textCancel = document.getElementById('textCancel');

  // ============ INIT ============
  function initCanvas() {
    const rect = canvasContainer.getBoundingClientRect();
    const w = Math.floor(rect.width - 40);
    const h = Math.floor(rect.height - 40);
    mainCanvas.width = w;
    mainCanvas.height = h;
    previewCanvas.width = w;
    previewCanvas.height = h;
    mainCanvas.style.width = w + 'px';
    mainCanvas.style.height = h + 'px';
    previewCanvas.style.width = w + 'px';
    previewCanvas.style.height = h + 'px';
    canvasSizeEl.textContent = `${w} x ${h}`;
  }

  function createLayer(name) {
    const canvas = document.createElement('canvas');
    canvas.width = mainCanvas.width;
    canvas.height = mainCanvas.height;
    return { name, canvas, visible: true };
  }

  function init() {
    initCanvas();
    layers = [createLayer('Background')];
    // Fill background white
    const bgCtx = layers[0].canvas.getContext('2d');
    bgCtx.fillStyle = '#ffffff';
    bgCtx.fillRect(0, 0, layers[0].canvas.width, layers[0].canvas.height);
    activeLayerIdx = 0;
    renderLayers();
    buildPalette();
    updateColorPreview();
    updateSizePreview();
    saveState();
  }

  // ============ LAYERS ============
  function renderLayers() {
    layerListEl.innerHTML = '';
    layers.forEach((layer, i) => {
      const div = document.createElement('div');
      div.className = 'layer-item' + (i === activeLayerIdx ? ' active' : '');
      div.innerHTML = `
        <div class="layer-eye ${layer.visible ? '' : 'hidden'}" data-idx="${i}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </div>
        <span class="layer-name">${layer.name}</span>
        ${layers.length > 1 ? `<div class="layer-del" data-idx="${i}">&times;</div>` : ''}
      `;
      div.addEventListener('click', (e) => {
        if (e.target.closest('.layer-eye') || e.target.closest('.layer-del')) return;
        activeLayerIdx = i;
        renderLayers();
      });
      layerListEl.appendChild(div);
    });

    // Eye toggles
    layerListEl.querySelectorAll('.layer-eye').forEach(el => {
      el.addEventListener('click', () => {
        const idx = +el.dataset.idx;
        layers[idx].visible = !layers[idx].visible;
        renderLayers();
        compositeToMain();
      });
    });

    // Delete
    layerListEl.querySelectorAll('.layer-del').forEach(el => {
      el.addEventListener('click', () => {
        const idx = +el.dataset.idx;
        if (layers.length <= 1) return;
        layers.splice(idx, 1);
        if (activeLayerIdx >= layers.length) activeLayerIdx = layers.length - 1;
        saveState();
        renderLayers();
        compositeToMain();
      });
    });
  }

  addLayerBtn.addEventListener('click', () => {
    const layer = createLayer(`Layer ${layers.length + 1}`);
    layers.splice(activeLayerIdx + 1, 0, layer);
    activeLayerIdx = activeLayerIdx + 1;
    saveState();
    renderLayers();
  });

  function compositeToMain() {
    mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
    layers.forEach(layer => {
      if (layer.visible) {
        mainCtx.drawImage(layer.canvas, 0, 0);
      }
    });
  }

  // ============ UNDO / REDO ============
  function saveState() {
    const state = layers.map(l => {
      const c = document.createElement('canvas');
      c.width = l.canvas.width;
      c.height = l.canvas.height;
      c.getContext('2d').drawImage(l.canvas, 0, 0);
      return { name: l.name, canvas: c, visible: l.visible };
    });
    undoStack.push({ layers: state, activeIdx: activeLayerIdx });
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
    compositeToMain();
  }

  function undo() {
    if (undoStack.length <= 1) return;
    redoStack.push(undoStack.pop());
    const state = undoStack[undoStack.length - 1];
    restoreState(state);
  }

  function redo() {
    if (redoStack.length === 0) return;
    const state = redoStack.pop();
    undoStack.push(state);
    restoreState(state);
  }

  function restoreState(state) {
    layers = state.layers.map(l => {
      const c = document.createElement('canvas');
      c.width = l.canvas.width;
      c.height = l.canvas.height;
      c.getContext('2d').drawImage(l.canvas, 0, 0);
      return { name: l.name, canvas: c, visible: l.visible };
    });
    activeLayerIdx = state.activeIdx;
    if (activeLayerIdx >= layers.length) activeLayerIdx = layers.length - 1;
    renderLayers();
    compositeToMain();
  }

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // ============ PALETTE ============
  function buildPalette() {
    colorPaletteEl.innerHTML = '';
    PALETTE.forEach(c => {
      const div = document.createElement('div');
      div.className = 'color-swatch' + (c === currentColor ? ' active' : '');
      div.style.background = c;
      div.addEventListener('click', () => {
        currentColor = c;
        colorPicker.value = c;
        updateColorPreview();
        buildPalette();
      });
      colorPaletteEl.appendChild(div);
    });
  }

  function updateColorPreview() {
    colorPreview.style.background = currentColor;
  }

  colorPreview.addEventListener('click', () => colorPicker.click());
  colorPicker.addEventListener('input', (e) => {
    currentColor = e.target.value;
    updateColorPreview();
    buildPalette();
  });

  // ============ SIZE & OPACITY ============
  brushSizeSlider.addEventListener('input', (e) => {
    brushSize = +e.target.value;
    sizeValueEl.textContent = brushSize;
    updateSizePreview();
  });

  function updateSizePreview() {
    const s = Math.max(2, Math.min(brushSize, 40));
    sizePreviewEl.style.width = s + 'px';
    sizePreviewEl.style.height = s + 'px';
  }

  opacitySlider.addEventListener('input', (e) => {
    opacity = +e.target.value / 100;
    opacityValueEl.textContent = e.target.value + '%';
  });

  fillShapeCheck.addEventListener('change', (e) => {
    fillShape = e.target.checked;
  });

  // ============ TOOLS ============
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
      shapeOptions.style.display = ['rect','circle','line'].includes(currentTool) ? 'block' : 'none';
    });
  });

  // ============ DRAWING ============
  function getCanvasPos(e) {
    const rect = mainCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left),
      y: (e.clientY - rect.top)
    };
  }

  function getLayerCtx() {
    return layers[activeLayerIdx].canvas.getContext('2d');
  }

  function setupCtx(ctx) {
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = currentTool === 'eraser' ? '#ffffff' : currentColor;
    ctx.fillStyle = currentTool === 'eraser' ? '#ffffff' : currentColor;
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  // Brush / Pencil stroke
  function drawSegment(ctx, x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Preview shapes
  function previewShape(x1, y1, x2, y2) {
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    setupCtx(previewCtx);
    if (currentTool === 'line') {
      previewCtx.beginPath();
      previewCtx.moveTo(x1, y1);
      previewCtx.lineTo(x2, y2);
      previewCtx.stroke();
    } else if (currentTool === 'rect') {
      const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
      const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
      if (fillShape) {
        previewCtx.fillRect(rx, ry, rw, rh);
      }
      previewCtx.strokeRect(rx, ry, rw, rh);
    } else if (currentTool === 'circle') {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      previewCtx.beginPath();
      previewCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (fillShape) previewCtx.fill();
      previewCtx.stroke();
    }
    previewCtx.globalAlpha = 1;
  }

  // Commit shape to layer
  function commitShape(x1, y1, x2, y2) {
    const ctx = getLayerCtx();
    setupCtx(ctx);
    if (currentTool === 'line') {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (currentTool === 'rect') {
      const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
      const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
      if (fillShape) ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
    } else if (currentTool === 'circle') {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (fillShape) ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    saveState();
  }

  // Flood fill
  function floodFill(startX, startY) {
    const ctx = getLayerCtx();
    const w = layers[activeLayerIdx].canvas.width;
    const h = layers[activeLayerIdx].canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const sx = Math.round(startX), sy = Math.round(startY);
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return;

    const startIdx = (sy * w + sx) * 4;
    const sr = data[startIdx], sg = data[startIdx+1], sb = data[startIdx+2], sa = data[startIdx+3];

    // Parse fill color
    const tmp = document.createElement('canvas');
    tmp.width = 1; tmp.height = 1;
    const tmpCtx = tmp.getContext('2d');
    tmpCtx.fillStyle = currentColor;
    tmpCtx.globalAlpha = opacity;
    tmpCtx.fillRect(0, 0, 1, 1);
    const fc = tmpCtx.getImageData(0, 0, 1, 1).data;
    const fr = fc[0], fg = fc[1], fb = fc[2], fa = fc[3];

    if (sr === fr && sg === fg && sb === fb && sa === fa) return;

    const tolerance = 30;
    const stack = [[sx, sy]];
    const visited = new Uint8Array(w * h);

    function match(i) {
      return Math.abs(data[i] - sr) <= tolerance &&
             Math.abs(data[i+1] - sg) <= tolerance &&
             Math.abs(data[i+2] - sb) <= tolerance &&
             Math.abs(data[i+3] - sa) <= tolerance;
    }

    while (stack.length > 0) {
      const [cx, cy] = stack.pop();
      const idx = cy * w + cx;
      if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
      if (visited[idx]) continue;
      const pi = idx * 4;
      if (!match(pi)) continue;
      visited[idx] = 1;
      data[pi] = fr; data[pi+1] = fg; data[pi+2] = fb; data[pi+3] = fa;
      stack.push([cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]);
    }

    ctx.putImageData(imageData, 0, 0);
    saveState();
  }

  // ============ MOUSE EVENTS ============
  mainCanvas.addEventListener('mousedown', (e) => {
    const pos = getCanvasPos(e);
    isDrawing = true;
    startX = pos.x; startY = pos.y;
    lastX = pos.x; lastY = pos.y;

    if (currentTool === 'fill') {
      floodFill(pos.x, pos.y);
      isDrawing = false;
      return;
    }

    if (currentTool === 'text') {
      textPos = { x: pos.x, y: pos.y };
      textModal.style.display = 'flex';
      textInput.value = '';
      textInput.focus();
      isDrawing = false;
      return;
    }

    if (currentTool === 'brush' || currentTool === 'pencil' || currentTool === 'eraser') {
      const ctx = getLayerCtx();
      setupCtx(ctx);
      if (currentTool === 'pencil') ctx.lineWidth = 1;
      // Draw a dot for single click
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, (currentTool === 'pencil' ? 0.5 : brushSize / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      compositeToMain();
    }
  });

  mainCanvas.addEventListener('mousemove', (e) => {
    const pos = getCanvasPos(e);
    cursorPosEl.textContent = `${Math.round(pos.x)}, ${Math.round(pos.y)}`;

    if (!isDrawing) return;

    if (currentTool === 'brush' || currentTool === 'pencil' || currentTool === 'eraser') {
      const ctx = getLayerCtx();
      setupCtx(ctx);
      if (currentTool === 'pencil') ctx.lineWidth = 1;
      drawSegment(ctx, lastX, lastY, pos.x, pos.y);
      ctx.globalAlpha = 1;
      lastX = pos.x; lastY = pos.y;
      compositeToMain();
    } else if (['line','rect','circle'].includes(currentTool)) {
      previewShape(startX, startY, pos.x, pos.y);
    }
  });

  mainCanvas.addEventListener('mouseup', (e) => {
    if (!isDrawing) return;
    isDrawing = false;
    const pos = getCanvasPos(e);

    if (['line','rect','circle'].includes(currentTool)) {
      commitShape(startX, startY, pos.x, pos.y);
    } else if (currentTool === 'brush' || currentTool === 'pencil' || currentTool === 'eraser') {
      saveState();
    }
  });

  mainCanvas.addEventListener('mouseleave', () => {
    if (isDrawing && (currentTool === 'brush' || currentTool === 'pencil' || currentTool === 'eraser')) {
      isDrawing = false;
      saveState();
    }
  });

  // ============ TOUCH SUPPORT ============
  mainCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousedown', { clientX: touch.clientX, clientY: touch.clientY });
    mainCanvas.dispatchEvent(mouseEvent);
  }, { passive: false });

  mainCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousemove', { clientX: touch.clientX, clientY: touch.clientY });
    mainCanvas.dispatchEvent(mouseEvent);
  }, { passive: false });

  mainCanvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    const mouseEvent = new MouseEvent('mouseup', {});
    mainCanvas.dispatchEvent(mouseEvent);
  }, { passive: false });

  // ============ TEXT MODAL ============
  textConfirm.addEventListener('click', () => {
    if (!textPos || !textInput.value.trim()) { textModal.style.display = 'none'; return; }
    const ctx = getLayerCtx();
    setupCtx(ctx);
    const size = +fontSize.value || 24;
    const style = (fontBold.checked ? 'bold ' : '') + (fontItalic.checked ? 'italic ' : '');
    ctx.font = `${style}${size}px ${fontFamily.value}`;
    ctx.textBaseline = 'top';

    const lines = textInput.value.split('\n');
    lines.forEach((line, i) => {
      ctx.fillText(line, textPos.x, textPos.y + i * (size * 1.3));
    });
    ctx.globalAlpha = 1;
    textModal.style.display = 'none';
    saveState();
  });

  textCancel.addEventListener('click', () => { textModal.style.display = 'none'; });

  // ============ CLEAR & SAVE ============
  clearBtn.addEventListener('click', () => {
    const ctx = getLayerCtx();
    ctx.clearRect(0, 0, layers[activeLayerIdx].canvas.width, layers[activeLayerIdx].canvas.height);
    if (activeLayerIdx === 0) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, layers[activeLayerIdx].canvas.width, layers[activeLayerIdx].canvas.height);
    }
    saveState();
  });

  saveBtn.addEventListener('click', () => {
    // Composite all visible
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = mainCanvas.width;
    exportCanvas.height = mainCanvas.height;
    const exCtx = exportCanvas.getContext('2d');
    layers.forEach(l => { if (l.visible) exCtx.drawImage(l.canvas, 0, 0); });
    const link = document.createElement('a');
    link.download = 'drawing.png';
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  });

  // ============ KEYBOARD SHORTCUTS ============
  document.addEventListener('keydown', (e) => {
    if (textModal.style.display === 'flex') return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveBtn.click(); }

    const keyMap = { b: 'brush', p: 'pencil', l: 'line', r: 'rect', c: 'circle', e: 'eraser', f: 'fill', t: 'text' };
    if (!e.ctrlKey && !e.metaKey && !e.altKey && keyMap[e.key]) {
      const btn = document.querySelector(`[data-tool="${keyMap[e.key]}"]`);
      if (btn) btn.click();
    }
  });

  // ============ RESIZE ============
  window.addEventListener('resize', () => {
    // Store existing layers data
    const oldData = layers.map(l => {
      const c = document.createElement('canvas');
      c.width = l.canvas.width;
      c.height = l.canvas.height;
      c.getContext('2d').drawImage(l.canvas, 0, 0);
      return c;
    });

    initCanvas();

    // Resize layer canvases and restore data
    layers.forEach((l, i) => {
      l.canvas.width = mainCanvas.width;
      l.canvas.height = mainCanvas.height;
      l.canvas.getContext('2d').drawImage(oldData[i], 0, 0);
    });

    compositeToMain();
  });

  // ============ START ============
  init();
})();
