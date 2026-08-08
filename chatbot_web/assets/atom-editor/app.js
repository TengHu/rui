// ===== ATOM EDITOR — Main Application =====

const state = {
  tabs: [],          // { id, path, name, language, content, originalContent, modified, cursorPos }
  activeTab: null,
  sidebarVisible: true,
  minimapVisible: true,
  fileTree: [],
  allFiles: [],      // flat list for file finder
  fontSize: 13,
  wordWrap: false,
  contextTarget: null,
  findVisible: false,
  findMatches: [],
  findIndex: -1,
  undoStacks: {},    // per-tab undo
  selectedPaletteIndex: 0,
};

let tabIdCounter = 0;

// ===== File Icons =====
function getFileIcon(name, isDir = false, isOpen = false) {
  if (isDir) {
    return `<span class="tree-icon file-icon-folder${isOpen ? ' open' : ''}">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="${isOpen ? 'M1 4h14v1H2v8h12V6H7.5L5.5 4H1z' : 'M1 3h5l2 2h7v9H1V3z'}"/></svg>
    </span>`;
  }
  const ext = name.split('.').pop().toLowerCase();
  const iconMap = {
    js: { cls: 'file-icon-js', letter: 'JS' },
    jsx: { cls: 'file-icon-js', letter: 'JSX' },
    ts: { cls: 'file-icon-ts', letter: 'TS' },
    tsx: { cls: 'file-icon-ts', letter: 'TSX' },
    py: { cls: 'file-icon-py', letter: 'PY' },
    html: { cls: 'file-icon-html', letter: '◇' },
    htm: { cls: 'file-icon-html', letter: '◇' },
    css: { cls: 'file-icon-css', letter: '#' },
    scss: { cls: 'file-icon-css', letter: '#' },
    json: { cls: 'file-icon-json', letter: '{}' },
    md: { cls: 'file-icon-md', letter: 'M' },
    sh: { cls: 'file-icon-sh', letter: '$' },
    bash: { cls: 'file-icon-sh', letter: '$' },
    go: { cls: 'file-icon-go', letter: 'GO' },
    rs: { cls: 'file-icon-rs', letter: 'RS' },
    yaml: { cls: 'file-icon-yaml', letter: 'Y' },
    yml: { cls: 'file-icon-yaml', letter: 'Y' },
    png: { cls: 'file-icon-img', letter: '▣' },
    jpg: { cls: 'file-icon-img', letter: '▣' },
    svg: { cls: 'file-icon-img', letter: '▣' },
    toml: { cls: 'file-icon-yaml', letter: 'T' },
  };
  const info = iconMap[ext] || { cls: 'file-icon-default', letter: '◻' };
  return `<span class="tree-icon ${info.cls}" style="font-size:10px;font-weight:bold">${info.letter}</span>`;
}

// ===== File Tree =====
async function loadFileTree() {
  try {
    const res = await fetch('/api/tree');
    state.fileTree = await res.json();
    state.allFiles = flattenTree(state.fileTree);
    renderTree();
  } catch (e) {
    console.error('Failed to load tree:', e);
  }
}

function flattenTree(tree, result = []) {
  for (const item of tree) {
    if (item.type === 'file') result.push(item);
    if (item.children) flattenTree(item.children, result);
  }
  return result;
}

function renderTree() {
  const container = document.getElementById('fileTree');
  const filter = document.getElementById('treeSearch').value.toLowerCase();
  container.innerHTML = renderTreeItems(state.fileTree, 0, filter);
}

function renderTreeItems(items, depth, filter) {
  let html = '';
  for (const item of items) {
    if (filter) {
      if (item.type === 'file' && !item.name.toLowerCase().includes(filter)) continue;
      if (item.type === 'directory') {
        const childHtml = renderTreeItems(item.children || [], depth + 1, filter);
        if (!childHtml && !item.name.toLowerCase().includes(filter)) continue;
      }
    }
    const paddingLeft = 8 + depth * 16;
    const isActive = state.activeTab && state.tabs.find(t => t.id === state.activeTab)?.path === item.path;

    if (item.type === 'directory') {
      const isOpen = item._open !== false;
      html += `<div class="tree-item${isActive ? ' active' : ''}" style="padding-left:${paddingLeft}px"
        onclick="toggleDir(this, '${item.path}')"
        oncontextmenu="showContextMenu(event, '${item.path}', 'directory')"
        data-path="${item.path}" data-type="directory">
        <span class="tree-arrow${isOpen ? ' open' : ''}">▶</span>
        ${getFileIcon(item.name, true, isOpen)}
        <span class="tree-name">${item.name}</span>
      </div>`;
      html += `<div class="tree-children${isOpen ? '' : ' collapsed'}" data-dir="${item.path}">`;
      html += renderTreeItems(item.children || [], depth + 1, filter);
      html += '</div>';
    } else {
      html += `<div class="tree-item${isActive ? ' active' : ''}" style="padding-left:${paddingLeft}px"
        onclick="openFile('${item.path}')"
        oncontextmenu="showContextMenu(event, '${item.path}', 'file')"
        data-path="${item.path}" data-type="file">
        <span class="tree-arrow hidden">▶</span>
        ${getFileIcon(item.name)}
        <span class="tree-name">${item.name}</span>
      </div>`;
    }
  }
  return html;
}

function findInTree(tree, path) {
  for (const item of tree) {
    if (item.path === path) return item;
    if (item.children) {
      const found = findInTree(item.children, path);
      if (found) return found;
    }
  }
  return null;
}

function toggleDir(el, path) {
  const item = findInTree(state.fileTree, path);
  if (item) {
    item._open = item._open === false ? true : false;
    renderTree();
  }
}

function refreshTree() {
  loadFileTree();
  showToast('File tree refreshed', 'info');
}

// ===== File Operations =====
async function openFile(filePath) {
  // Check if already open
  const existing = state.tabs.find(t => t.path === filePath);
  if (existing) {
    activateTab(existing.id);
    return;
  }

  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    if (!res.ok) throw new Error('Failed to load file');
    const data = await res.json();

    const tab = {
      id: ++tabIdCounter,
      path: filePath,
      name: filePath.split('/').pop(),
      language: data.language,
      content: data.content,
      originalContent: data.content,
      modified: false,
      cursorPos: { line: 1, col: 1 },
      scrollTop: 0,
    };
    state.tabs.push(tab);
    activateTab(tab.id);
    renderTabs();
  } catch (e) {
    showToast('Failed to open file: ' + e.message, 'error');
  }
}

async function saveFile(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;

  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tab.path, content: tab.content }),
    });
    if (!res.ok) throw new Error('Save failed');
    tab.originalContent = tab.content;
    tab.modified = false;
    renderTabs();
    showToast(`Saved ${tab.name}`, 'success');
  } catch (e) {
    showToast('Failed to save: ' + e.message, 'error');
  }
}

// ===== Tab Management =====
function renderTabs() {
  const container = document.getElementById('tabsContainer');
  container.innerHTML = state.tabs.map(tab => {
    const active = tab.id === state.activeTab;
    return `<div class="tab${active ? ' active' : ''}${tab.modified ? ' modified' : ''}"
      data-tab="${tab.id}" onclick="activateTab(${tab.id})"
      onmousedown="handleTabMouseDown(event, ${tab.id})"
      title="${tab.path}">
      <span class="tab-dot"></span>
      <span class="tab-name">${tab.name}</span>
      <button class="tab-close" onclick="event.stopPropagation(); closeTab(${tab.id})" title="Close">×</button>
    </div>`;
  }).join('');
}

function activateTab(tabId) {
  // Save current tab state
  if (state.activeTab) {
    const current = state.tabs.find(t => t.id === state.activeTab);
    if (current) {
      const input = document.getElementById('codeInput');
      current.content = input.value;
      current.scrollTop = document.getElementById('editor').scrollTop;
      current.selectionStart = input.selectionStart;
      current.selectionEnd = input.selectionEnd;
    }
  }

  state.activeTab = tabId;
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;

  // Show editor, hide welcome
  document.getElementById('welcomeScreen').classList.add('hidden');
  document.getElementById('editor').classList.remove('hidden');

  const input = document.getElementById('codeInput');
  input.value = tab.content;
  updateHighlight();
  updateLineNumbers();

  // Restore scroll and cursor
  setTimeout(() => {
    document.getElementById('editor').scrollTop = tab.scrollTop || 0;
    if (tab.selectionStart !== undefined) {
      input.selectionStart = tab.selectionStart;
      input.selectionEnd = tab.selectionEnd;
    }
    input.focus();
  }, 0);

  // Update status bar
  document.getElementById('statusLanguage').textContent = tab.language || 'Plain Text';
  document.getElementById('titleText').textContent = `${tab.name} — Atom Editor`;
  updateCursorPosition();

  renderTabs();
  highlightActiveFile();
  updateMinimap();
}

function closeTab(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;

  if (tab.modified) {
    if (!confirm(`${tab.name} has unsaved changes. Close anyway?`)) return;
  }

  const idx = state.tabs.indexOf(tab);
  state.tabs.splice(idx, 1);

  if (state.activeTab === tabId) {
    if (state.tabs.length > 0) {
      const newIdx = Math.min(idx, state.tabs.length - 1);
      activateTab(state.tabs[newIdx].id);
    } else {
      state.activeTab = null;
      document.getElementById('welcomeScreen').classList.remove('hidden');
      document.getElementById('editor').classList.add('hidden');
      document.getElementById('titleText').textContent = 'Atom Editor';
    }
  }
  renderTabs();
}

function closeActiveTab() {
  if (state.activeTab) closeTab(state.activeTab);
}

function handleTabMouseDown(e, tabId) {
  if (e.button === 1) { // Middle click
    e.preventDefault();
    closeTab(tabId);
  }
}

function highlightActiveFile() {
  document.querySelectorAll('.tree-item').forEach(el => {
    el.classList.remove('active');
    const tab = state.tabs.find(t => t.id === state.activeTab);
    if (tab && el.dataset.path === tab.path) {
      el.classList.add('active');
    }
  });
}

// ===== Syntax Highlighting =====
function updateHighlight() {
  const input = document.getElementById('codeInput');
  const highlightCode = document.getElementById('codeHighlightCode');
  const tab = state.tabs.find(t => t.id === state.activeTab);

  let text = input.value;
  // Ensure text ends with newline for proper rendering
  if (!text.endsWith('\n')) text += '\n';

  highlightCode.textContent = text;
  highlightCode.className = '';
  if (tab && tab.language && tab.language !== 'plaintext') {
    highlightCode.classList.add(`language-${tab.language}`);
  }
  hljs.highlightElement(highlightCode);
}

// ===== Line Numbers =====
function updateLineNumbers() {
  const input = document.getElementById('codeInput');
  const lineNumbers = document.getElementById('lineNumbers');
  const lines = input.value.split('\n');
  const cursorLine = getCursorLine();

  let html = '';
  for (let i = 0; i < lines.length; i++) {
    const num = i + 1;
    const cls = num === cursorLine ? ' active' : '';
    html += `<span class="ln${cls}">${num}</span>`;
  }
  lineNumbers.innerHTML = html;
}

function getCursorLine() {
  const input = document.getElementById('codeInput');
  const text = input.value.substring(0, input.selectionStart);
  return (text.match(/\n/g) || []).length + 1;
}

function getCursorCol() {
  const input = document.getElementById('codeInput');
  const text = input.value.substring(0, input.selectionStart);
  const lastNewline = text.lastIndexOf('\n');
  return input.selectionStart - lastNewline;
}

function updateCursorPosition() {
  const line = getCursorLine();
  const col = getCursorCol();
  document.getElementById('statusCursor').textContent = `Ln ${line}, Col ${col}`;

  const input = document.getElementById('codeInput');
  const selLen = Math.abs(input.selectionEnd - input.selectionStart);
  document.getElementById('statusSelection').textContent = selLen > 0 ? `(${selLen} selected)` : '';
}

// ===== Editor Sync =====
function syncScroll() {
  const editor = document.getElementById('editor');
  const highlight = document.getElementById('codeHighlight');
  const lineNumbers = document.getElementById('lineNumbers');
  const input = document.getElementById('codeInput');

  highlight.scrollTop = input.scrollTop;
  highlight.scrollLeft = input.scrollLeft;
  lineNumbers.scrollTop = input.scrollTop;

  updateMinimapViewport();
}

// ===== Minimap =====
function updateMinimap() {
  const canvas = document.getElementById('minimapCanvas');
  const ctx = canvas.getContext('2d');
  const input = document.getElementById('codeInput');
  const text = input.value;
  const lines = text.split('\n');

  const width = 80;
  const lineHeight = 2.5;
  const height = Math.max(lines.length * lineHeight, 200);

  canvas.width = width * 2;
  canvas.height = height * 2;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.scale(2, 2);

  ctx.fillStyle = '#1e1f2b';
  ctx.fillRect(0, 0, width, height);

  lines.forEach((line, i) => {
    const y = i * lineHeight;
    const trimmed = line.replace(/\t/g, '  ');
    const indent = (trimmed.length - trimmed.trimStart().length) * 0.5;
    const charWidth = Math.min(trimmed.trim().length * 0.5, width - indent - 4);
    if (charWidth > 0) {
      // Color based on content
      if (trimmed.trim().startsWith('//') || trimmed.trim().startsWith('#') || trimmed.trim().startsWith('/*')) {
        ctx.fillStyle = 'rgba(92, 95, 120, 0.5)';
      } else if (trimmed.includes('function') || trimmed.includes('class') || trimmed.includes('def ') || trimmed.includes('const ') || trimmed.includes('let ') || trimmed.includes('var ')) {
        ctx.fillStyle = 'rgba(78, 201, 176, 0.35)';
      } else if (trimmed.includes('"') || trimmed.includes("'") || trimmed.includes('`')) {
        ctx.fillStyle = 'rgba(152, 195, 121, 0.35)';
      } else {
        ctx.fillStyle = 'rgba(200, 202, 216, 0.25)';
      }
      ctx.fillRect(indent + 4, y, charWidth, lineHeight - 0.5);
    }
  });

  updateMinimapViewport();
}

function updateMinimapViewport() {
  const input = document.getElementById('codeInput');
  const viewport = document.getElementById('minimapViewport');
  const canvas = document.getElementById('minimapCanvas');
  const lines = input.value.split('\n');
  const lineHeight = 2.5;
  const totalHeight = lines.length * lineHeight;

  if (totalHeight === 0) return;

  const scrollFraction = input.scrollTop / (input.scrollHeight || 1);
  const visibleFraction = input.clientHeight / (input.scrollHeight || 1);
  const canvasHeight = parseFloat(canvas.style.height);

  viewport.style.top = (scrollFraction * canvasHeight) + 'px';
  viewport.style.height = Math.max(visibleFraction * canvasHeight, 20) + 'px';
}

// ===== Minimap click to scroll =====
document.getElementById('minimap')?.addEventListener('mousedown', (e) => {
  const canvas = document.getElementById('minimapCanvas');
  const input = document.getElementById('codeInput');
  const rect = canvas.getBoundingClientRect();
  const fraction = (e.clientY - rect.top) / rect.height;
  input.scrollTop = fraction * input.scrollHeight;
});

// ===== Menu System =====
let openMenu = null;
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const menuId = 'menu-' + item.dataset.menu;
    const menu = document.getElementById(menuId);
    if (!menu) return;

    closeAllMenus();
    const rect = item.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = rect.bottom + 'px';
    menu.classList.add('show');
    openMenu = menu;
  });

  item.addEventListener('mouseenter', () => {
    if (openMenu) {
      closeAllMenus();
      const menuId = 'menu-' + item.dataset.menu;
      const menu = document.getElementById(menuId);
      if (!menu) return;
      const rect = item.getBoundingClientRect();
      menu.style.left = rect.left + 'px';
      menu.style.top = rect.bottom + 'px';
      menu.classList.add('show');
      openMenu = menu;
    }
  });
});

function closeAllMenus() {
  document.querySelectorAll('.menu-dropdown').forEach(m => m.classList.remove('show'));
  openMenu = null;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-dropdown') && !e.target.closest('.menu-item')) {
    closeAllMenus();
  }
  const ctx = document.getElementById('contextMenu');
  if (!e.target.closest('.context-menu')) {
    ctx.classList.add('hidden');
  }
});

// ===== Sidebar =====
function toggleSidebar() {
  state.sidebarVisible = !state.sidebarVisible;
  document.getElementById('sidebar').classList.toggle('collapsed', !state.sidebarVisible);
  document.getElementById('sidebarResizer').style.display = state.sidebarVisible ? '' : 'none';
  closeAllMenus();
}

function toggleMinimap() {
  state.minimapVisible = !state.minimapVisible;
  document.getElementById('minimap').classList.toggle('hidden', !state.minimapVisible);
  closeAllMenus();
}

// ===== Sidebar Resize =====
let isResizing = false;
document.getElementById('sidebarResizer').addEventListener('mousedown', (e) => {
  isResizing = true;
  document.getElementById('sidebarResizer').classList.add('active');
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const sidebar = document.getElementById('sidebar');
  const newWidth = Math.max(180, Math.min(500, e.clientX));
  sidebar.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    document.getElementById('sidebarResizer').classList.remove('active');
    document.body.style.cursor = '';
  }
});

// ===== Context Menu =====
function showContextMenu(e, path, type) {
  e.preventDefault();
  e.stopPropagation();
  state.contextTarget = { path, type };
  const menu = document.getElementById('contextMenu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.remove('hidden');
}

document.querySelectorAll('.ctx-entry').forEach(entry => {
  entry.addEventListener('click', () => {
    const action = entry.dataset.action;
    const target = state.contextTarget;
    if (!target) return;
    document.getElementById('contextMenu').classList.add('hidden');

    switch (action) {
      case 'newFile': handleNewFileIn(target.path); break;
      case 'newFolder': handleNewFolderIn(target.path); break;
      case 'delete': handleDelete(target.path); break;
      case 'rename': handleRename(target.path); break;
      case 'copyPath': navigator.clipboard.writeText(target.path); showToast('Path copied', 'info'); break;
    }
  });
});

// ===== File CRUD =====
async function handleNewFile() {
  const name = prompt('New file name:');
  if (!name) return;
  try {
    await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name, content: '' }),
    });
    await loadFileTree();
    openFile(name);
    showToast(`Created ${name}`, 'success');
  } catch (e) {
    showToast('Failed to create file', 'error');
  }
  closeAllMenus();
}

async function handleNewFileIn(dirPath) {
  const dir = dirPath.includes('.') ? dirPath.split('/').slice(0, -1).join('/') : dirPath;
  const name = prompt('New file name:');
  if (!name) return;
  const fullPath = dir ? `${dir}/${name}` : name;
  try {
    await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath, content: '' }),
    });
    await loadFileTree();
    openFile(fullPath);
    showToast(`Created ${name}`, 'success');
  } catch (e) {
    showToast('Failed to create file', 'error');
  }
}

async function handleNewFolder() {
  const name = prompt('New folder name:');
  if (!name) return;
  try {
    await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name, type: 'directory' }),
    });
    await loadFileTree();
    showToast(`Created folder ${name}`, 'success');
  } catch (e) {
    showToast('Failed to create folder', 'error');
  }
  closeAllMenus();
}

async function handleNewFolderIn(dirPath) {
  const dir = dirPath.includes('.') ? dirPath.split('/').slice(0, -1).join('/') : dirPath;
  const name = prompt('New folder name:');
  if (!name) return;
  const fullPath = dir ? `${dir}/${name}` : name;
  try {
    await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath, type: 'directory' }),
    });
    await loadFileTree();
    showToast(`Created folder ${name}`, 'success');
  } catch (e) {
    showToast('Failed to create folder', 'error');
  }
}

async function handleDelete(path) {
  if (!confirm(`Delete "${path}"?`)) return;
  try {
    await fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    // Close tab if open
    const tab = state.tabs.find(t => t.path === path);
    if (tab) closeTab(tab.id);
    await loadFileTree();
    showToast(`Deleted ${path}`, 'success');
  } catch (e) {
    showToast('Failed to delete', 'error');
  }
}

function handleRename(path) {
  const oldName = path.split('/').pop();
  const newName = prompt('Rename to:', oldName);
  if (!newName || newName === oldName) return;
  const dir = path.split('/').slice(0, -1).join('/');
  const newPath = dir ? `${dir}/${newName}` : newName;

  // Use fetch to read, write new, delete old
  fetch(`/api/file?path=${encodeURIComponent(path)}`)
    .then(res => res.json())
    .then(data => {
      return fetch('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath, content: data.content || '' }),
      });
    })
    .then(() => fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }))
    .then(() => {
      loadFileTree();
      showToast(`Renamed to ${newName}`, 'success');
    })
    .catch(() => showToast('Rename failed', 'error'));
}

function handleSave() {
  if (state.activeTab) saveFile(state.activeTab);
  closeAllMenus();
}

function handleSaveAll() {
  state.tabs.filter(t => t.modified).forEach(t => saveFile(t.id));
  closeAllMenus();
}

// ===== Find & Replace =====
function toggleFindPanel(showReplace = false) {
  const panel = document.getElementById('findPanel');
  const replaceRow = document.getElementById('replaceRow');

  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    if (showReplace) replaceRow.classList.remove('hidden');
    else replaceRow.classList.add('hidden');
    document.getElementById('findInput').focus();

    // Pre-fill with selection
    const input = document.getElementById('codeInput');
    const sel = input.value.substring(input.selectionStart, input.selectionEnd);
    if (sel && !sel.includes('\n')) {
      document.getElementById('findInput').value = sel;
      performFind();
    }
  } else {
    if (showReplace && replaceRow.classList.contains('hidden')) {
      replaceRow.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
      state.findMatches = [];
      state.findIndex = -1;
      document.getElementById('findCount').textContent = '';
    }
  }
  closeAllMenus();
}

function performFind() {
  const query = document.getElementById('findInput').value;
  const input = document.getElementById('codeInput');
  const text = input.value;

  if (!query) {
    state.findMatches = [];
    state.findIndex = -1;
    document.getElementById('findCount').textContent = '';
    return;
  }

  state.findMatches = [];
  let idx = 0;
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  while (idx < text.length) {
    const found = lowerText.indexOf(lowerQuery, idx);
    if (found === -1) break;
    state.findMatches.push({ start: found, end: found + query.length });
    idx = found + 1;
  }

  state.findIndex = state.findMatches.length > 0 ? 0 : -1;
  document.getElementById('findCount').textContent = state.findMatches.length > 0
    ? `${state.findIndex + 1} of ${state.findMatches.length}`
    : 'No results';

  if (state.findIndex >= 0) {
    scrollToMatch(state.findMatches[state.findIndex]);
  }
}

function findNext() {
  if (state.findMatches.length === 0) { performFind(); return; }
  state.findIndex = (state.findIndex + 1) % state.findMatches.length;
  document.getElementById('findCount').textContent = `${state.findIndex + 1} of ${state.findMatches.length}`;
  scrollToMatch(state.findMatches[state.findIndex]);
}

function findPrev() {
  if (state.findMatches.length === 0) return;
  state.findIndex = (state.findIndex - 1 + state.findMatches.length) % state.findMatches.length;
  document.getElementById('findCount').textContent = `${state.findIndex + 1} of ${state.findMatches.length}`;
  scrollToMatch(state.findMatches[state.findIndex]);
}

function scrollToMatch(match) {
  const input = document.getElementById('codeInput');
  input.focus();
  input.selectionStart = match.start;
  input.selectionEnd = match.end;

  // Scroll to visible
  const linesBefore = input.value.substring(0, match.start).split('\n').length;
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight);
  input.scrollTop = Math.max(0, (linesBefore - 5) * lineHeight);
}

function replaceNext() {
  if (state.findIndex < 0 || state.findMatches.length === 0) return;
  const input = document.getElementById('codeInput');
  const replacement = document.getElementById('replaceInput').value;
  const match = state.findMatches[state.findIndex];

  input.value = input.value.substring(0, match.start) + replacement + input.value.substring(match.end);
  updateContent();
  performFind();
}

function replaceAll() {
  const query = document.getElementById('findInput').value;
  const replacement = document.getElementById('replaceInput').value;
  if (!query) return;

  const input = document.getElementById('codeInput');
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  input.value = input.value.replace(regex, replacement);
  updateContent();
  performFind();
  showToast(`Replaced all occurrences`, 'success');
}

document.getElementById('findInput').addEventListener('input', performFind);
document.getElementById('findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.shiftKey ? findPrev() : findNext(); }
  if (e.key === 'Escape') toggleFindPanel();
});

// ===== Command Palette =====
const commands = [
  { name: 'New File', shortcut: 'Ctrl+N', action: handleNewFile },
  { name: 'Save File', shortcut: 'Ctrl+S', action: handleSave },
  { name: 'Save All', shortcut: 'Ctrl+Shift+S', action: handleSaveAll },
  { name: 'Close Tab', shortcut: 'Ctrl+W', action: closeActiveTab },
  { name: 'Toggle Sidebar', shortcut: 'Ctrl+B', action: toggleSidebar },
  { name: 'Toggle Minimap', shortcut: '', action: toggleMinimap },
  { name: 'Toggle Terminal', shortcut: 'Ctrl+`', action: toggleTerminal },
  { name: 'Find', shortcut: 'Ctrl+F', action: () => toggleFindPanel() },
  { name: 'Find and Replace', shortcut: 'Ctrl+H', action: () => toggleFindPanel(true) },
  { name: 'Go to File', shortcut: 'Ctrl+P', action: toggleFileFinder },
  { name: 'Go to Line', shortcut: 'Ctrl+G', action: toggleGoToLine },
  { name: 'Increase Font Size', shortcut: 'Ctrl++', action: increaseFontSize },
  { name: 'Decrease Font Size', shortcut: 'Ctrl+-', action: decreaseFontSize },
  { name: 'Reset Font Size', shortcut: 'Ctrl+0', action: resetFontSize },
  { name: 'Toggle Word Wrap', shortcut: '', action: toggleWordWrap },
  { name: 'Refresh File Tree', shortcut: '', action: refreshTree },
  { name: 'About Atom Editor', shortcut: '', action: showAbout },
  { name: 'Keyboard Shortcuts', shortcut: '', action: showKeybindings },
];

function toggleCommandPalette() {
  const palette = document.getElementById('commandPalette');
  if (palette.classList.contains('show')) {
    palette.classList.remove('show');
    return;
  }
  palette.classList.add('show');
  const input = document.getElementById('paletteInput');
  input.value = '';
  input.focus();
  state.selectedPaletteIndex = 0;
  renderPaletteResults('');
  closeAllMenus();
}

function renderPaletteResults(filter) {
  const results = commands.filter(c =>
    c.name.toLowerCase().includes(filter.toLowerCase())
  );
  const container = document.getElementById('paletteResults');
  container.innerHTML = results.map((cmd, i) =>
    `<div class="palette-result${i === state.selectedPaletteIndex ? ' selected' : ''}"
      data-index="${i}" onclick="executePaletteCommand(${commands.indexOf(cmd)})">
      <span class="pr-icon">❯</span>
      <span>${cmd.name}</span>
      ${cmd.shortcut ? `<span class="pr-shortcut">${cmd.shortcut}</span>` : ''}
    </div>`
  ).join('');
  return results;
}

function executePaletteCommand(index) {
  document.getElementById('commandPalette').classList.remove('show');
  commands[index].action();
}

document.getElementById('paletteInput').addEventListener('input', (e) => {
  state.selectedPaletteIndex = 0;
  renderPaletteResults(e.target.value);
});

document.getElementById('paletteInput').addEventListener('keydown', (e) => {
  const results = commands.filter(c => c.name.toLowerCase().includes(e.target.value.toLowerCase()));
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.selectedPaletteIndex = Math.min(state.selectedPaletteIndex + 1, results.length - 1);
    renderPaletteResults(e.target.value);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    state.selectedPaletteIndex = Math.max(state.selectedPaletteIndex - 1, 0);
    renderPaletteResults(e.target.value);
  } else if (e.key === 'Enter') {
    if (results[state.selectedPaletteIndex]) {
      executePaletteCommand(commands.indexOf(results[state.selectedPaletteIndex]));
    }
  } else if (e.key === 'Escape') {
    toggleCommandPalette();
  }
});

// ===== File Finder =====
function toggleFileFinder() {
  const finder = document.getElementById('fileFinder');
  if (finder.classList.contains('show')) {
    finder.classList.remove('show');
    return;
  }
  finder.classList.add('show');
  const input = document.getElementById('fileFinderInput');
  input.value = '';
  input.focus();
  state.selectedPaletteIndex = 0;
  renderFileFinderResults('');
  closeAllMenus();
}

function renderFileFinderResults(filter) {
  let results = state.allFiles;
  if (filter) {
    const lower = filter.toLowerCase();
    results = results.filter(f =>
      f.name.toLowerCase().includes(lower) || f.path.toLowerCase().includes(lower)
    ).slice(0, 30);
  } else {
    results = results.slice(0, 30);
  }

  const container = document.getElementById('fileFinderResults');
  container.innerHTML = results.map((file, i) =>
    `<div class="palette-result${i === state.selectedPaletteIndex ? ' selected' : ''}"
      data-index="${i}" onclick="openFileFromFinder('${file.path}')">
      ${getFileIcon(file.name)}
      <span>${file.name}</span>
      <span class="pr-path">${file.path}</span>
    </div>`
  ).join('');
  return results;
}

function openFileFromFinder(path) {
  document.getElementById('fileFinder').classList.remove('show');
  openFile(path);
}

document.getElementById('fileFinderInput').addEventListener('input', (e) => {
  state.selectedPaletteIndex = 0;
  renderFileFinderResults(e.target.value);
});

document.getElementById('fileFinderInput').addEventListener('keydown', (e) => {
  const results = renderFileFinderResults(document.getElementById('fileFinderInput').value);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.selectedPaletteIndex = Math.min(state.selectedPaletteIndex + 1, results.length - 1);
    renderFileFinderResults(e.target.value);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    state.selectedPaletteIndex = Math.max(state.selectedPaletteIndex - 1, 0);
    renderFileFinderResults(e.target.value);
  } else if (e.key === 'Enter') {
    if (results[state.selectedPaletteIndex]) {
      openFileFromFinder(results[state.selectedPaletteIndex].path);
    }
  } else if (e.key === 'Escape') {
    toggleFileFinder();
  }
});

// ===== Go to Line =====
function toggleGoToLine() {
  const overlay = document.getElementById('goToLineOverlay');
  if (overlay.classList.contains('show')) {
    overlay.classList.remove('show');
    return;
  }
  overlay.classList.add('show');
  const input = document.getElementById('goToLineInput');
  input.value = '';
  input.focus();
  closeAllMenus();
}

document.getElementById('goToLineInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const lineNum = parseInt(e.target.value);
    if (lineNum > 0) goToLine(lineNum);
    document.getElementById('goToLineOverlay').classList.remove('show');
  } else if (e.key === 'Escape') {
    document.getElementById('goToLineOverlay').classList.remove('show');
  }
});

function goToLine(lineNum) {
  const input = document.getElementById('codeInput');
  const lines = input.value.split('\n');
  const targetLine = Math.min(lineNum, lines.length);
  let pos = 0;
  for (let i = 0; i < targetLine - 1; i++) {
    pos += lines[i].length + 1;
  }
  input.focus();
  input.selectionStart = pos;
  input.selectionEnd = pos;
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight);
  input.scrollTop = Math.max(0, (targetLine - 5) * lineHeight);
  updateCursorPosition();
  updateLineNumbers();
}

// ===== Font Size =====
function increaseFontSize() {
  state.fontSize = Math.min(28, state.fontSize + 1);
  applyFontSize();
  closeAllMenus();
}

function decreaseFontSize() {
  state.fontSize = Math.max(8, state.fontSize - 1);
  applyFontSize();
  closeAllMenus();
}

function resetFontSize() {
  state.fontSize = 13;
  applyFontSize();
  closeAllMenus();
}

function applyFontSize() {
  document.documentElement.style.setProperty('--font-size', state.fontSize + 'px');
  updateLineNumbers();
  updateMinimap();
}

// ===== Word Wrap =====
function toggleWordWrap() {
  state.wordWrap = !state.wordWrap;
  const input = document.getElementById('codeInput');
  const highlight = document.getElementById('codeHighlight');
  input.style.whiteSpace = state.wordWrap ? 'pre-wrap' : 'pre';
  highlight.style.whiteSpace = state.wordWrap ? 'pre-wrap' : 'pre';
  showToast(`Word wrap ${state.wordWrap ? 'enabled' : 'disabled'}`, 'info');
  closeAllMenus();
}

// ===== Text Editing Helpers =====
function selectLine() {
  const input = document.getElementById('codeInput');
  const text = input.value;
  const lineStart = text.lastIndexOf('\n', input.selectionStart - 1) + 1;
  let lineEnd = text.indexOf('\n', input.selectionStart);
  if (lineEnd === -1) lineEnd = text.length;
  input.selectionStart = lineStart;
  input.selectionEnd = lineEnd;
}

function duplicateLine() {
  const input = document.getElementById('codeInput');
  const text = input.value;
  const lineStart = text.lastIndexOf('\n', input.selectionStart - 1) + 1;
  let lineEnd = text.indexOf('\n', input.selectionStart);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.substring(lineStart, lineEnd);
  input.value = text.substring(0, lineEnd) + '\n' + line + text.substring(lineEnd);
  input.selectionStart = lineEnd + 1;
  input.selectionEnd = lineEnd + 1 + line.length;
  updateContent();
}

function toggleComment() {
  const input = document.getElementById('codeInput');
  const text = input.value;
  const start = input.selectionStart;
  const end = input.selectionEnd;

  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = text.length;

  const selectedText = text.substring(lineStart, lineEnd);
  const lines = selectedText.split('\n');
  const allCommented = lines.every(l => l.trimStart().startsWith('//'));

  const newLines = lines.map(l => {
    if (allCommented) {
      return l.replace(/^(\s*)\/\/\s?/, '$1');
    } else {
      return l.replace(/^(\s*)/, '$1// ');
    }
  });

  const newText = text.substring(0, lineStart) + newLines.join('\n') + text.substring(lineEnd);
  input.value = newText;
  updateContent();
}

// ===== Editor Input Handling =====
const codeInput = document.getElementById('codeInput');

codeInput.addEventListener('input', () => {
  updateContent();
});

codeInput.addEventListener('scroll', syncScroll);

codeInput.addEventListener('click', () => {
  updateCursorPosition();
  updateLineNumbers();
});

codeInput.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
    updateCursorPosition();
    updateLineNumbers();
  }
});

codeInput.addEventListener('keydown', (e) => {
  // Tab handling
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = codeInput.selectionStart;
    const end = codeInput.selectionEnd;

    if (start === end) {
      // Single cursor - insert tab
      if (e.shiftKey) {
        // Outdent
        const lineStart = codeInput.value.lastIndexOf('\n', start - 1) + 1;
        const line = codeInput.value.substring(lineStart, start);
        if (line.startsWith('  ')) {
          codeInput.value = codeInput.value.substring(0, lineStart) + codeInput.value.substring(lineStart + 2);
          codeInput.selectionStart = codeInput.selectionEnd = start - 2;
        }
      } else {
        document.execCommand('insertText', false, '  ');
      }
    } else {
      // Multi-line indent/outdent
      const text = codeInput.value;
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      let lineEnd = text.indexOf('\n', end - 1);
      if (lineEnd === -1) lineEnd = text.length;

      const selectedText = text.substring(lineStart, lineEnd);
      const lines = selectedText.split('\n');

      const newLines = lines.map(l => {
        if (e.shiftKey) return l.startsWith('  ') ? l.substring(2) : l;
        return '  ' + l;
      });

      codeInput.value = text.substring(0, lineStart) + newLines.join('\n') + text.substring(lineEnd);
      codeInput.selectionStart = lineStart;
      codeInput.selectionEnd = lineStart + newLines.join('\n').length;
    }
    updateContent();
    return;
  }

  // Auto-close brackets
  const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  if (pairs[e.key]) {
    const start = codeInput.selectionStart;
    const end = codeInput.selectionEnd;
    if (start !== end) {
      // Wrap selection
      e.preventDefault();
      const selected = codeInput.value.substring(start, end);
      document.execCommand('insertText', false, e.key + selected + pairs[e.key]);
      codeInput.selectionStart = start + 1;
      codeInput.selectionEnd = end + 1;
      updateContent();
      return;
    }
  }

  // Auto-indent on Enter
  if (e.key === 'Enter') {
    const pos = codeInput.selectionStart;
    const text = codeInput.value;
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const line = text.substring(lineStart, pos);
    const indent = line.match(/^\s*/)[0];
    const lastChar = text[pos - 1];
    const nextChar = text[pos];

    let extra = '';
    if (lastChar === '{' || lastChar === '(' || lastChar === '[' || lastChar === ':') {
      extra = '  ';
    }

    if (extra && (nextChar === '}' || nextChar === ')' || nextChar === ']')) {
      e.preventDefault();
      document.execCommand('insertText', false, '\n' + indent + extra + '\n' + indent);
      codeInput.selectionStart = codeInput.selectionEnd = pos + 1 + indent.length + extra.length;
      updateContent();
      return;
    }

    if (indent || extra) {
      e.preventDefault();
      document.execCommand('insertText', false, '\n' + indent + extra);
      updateContent();
    }
  }
});

function updateContent() {
  const tab = state.tabs.find(t => t.id === state.activeTab);
  if (tab) {
    tab.content = codeInput.value;
    const wasModified = tab.modified;
    tab.modified = tab.content !== tab.originalContent;
    if (wasModified !== tab.modified) renderTabs();
  }
  updateHighlight();
  updateLineNumbers();
  updateCursorPosition();
  debounce(updateMinimap, 300)();
}

// ===== Debounce =====
const debounceTimers = {};
function debounce(fn, delay) {
  return function() {
    const key = fn.toString();
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(() => fn.apply(this, arguments), delay);
  };
}

// ===== Terminal (placeholder) =====
function toggleTerminal() {
  showToast('Terminal integration coming soon', 'info');
  closeAllMenus();
}

// ===== Modals =====
function showAbout() {
  document.getElementById('aboutModal').classList.add('show');
  closeAllMenus();
}

function showKeybindings() {
  document.getElementById('keybindingsModal').classList.add('show');
  closeAllMenus();
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

// Close overlays on backdrop click
document.querySelectorAll('.overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('show');
  });
});

// ===== Toast Notifications =====
function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 'p' && !e.shiftKey) {
    e.preventDefault();
    toggleFileFinder();
  } else if (ctrl && e.shiftKey && e.key === 'P') {
    e.preventDefault();
    toggleCommandPalette();
  } else if (ctrl && e.key === 's' && !e.shiftKey) {
    e.preventDefault();
    handleSave();
  } else if (ctrl && e.shiftKey && e.key === 'S') {
    e.preventDefault();
    handleSaveAll();
  } else if (ctrl && e.key === 'n') {
    e.preventDefault();
    handleNewFile();
  } else if (ctrl && e.key === 'w') {
    e.preventDefault();
    closeActiveTab();
  } else if (ctrl && e.key === 'b') {
    e.preventDefault();
    toggleSidebar();
  } else if (ctrl && e.key === 'f') {
    e.preventDefault();
    toggleFindPanel();
  } else if (ctrl && e.key === 'h') {
    e.preventDefault();
    toggleFindPanel(true);
  } else if (ctrl && e.key === 'g') {
    e.preventDefault();
    toggleGoToLine();
  } else if (ctrl && e.key === '`') {
    e.preventDefault();
    toggleTerminal();
  } else if (ctrl && e.key === 'l') {
    e.preventDefault();
    selectLine();
  } else if (ctrl && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    duplicateLine();
  } else if (ctrl && e.key === '/') {
    e.preventDefault();
    toggleComment();
  } else if (ctrl && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    increaseFontSize();
  } else if (ctrl && e.key === '-') {
    e.preventDefault();
    decreaseFontSize();
  } else if (ctrl && e.key === '0') {
    e.preventDefault();
    resetFontSize();
  } else if (e.key === 'Escape') {
    closeAllMenus();
    document.getElementById('commandPalette').classList.remove('show');
    document.getElementById('fileFinder').classList.remove('show');
    document.getElementById('goToLineOverlay').classList.remove('show');
    document.getElementById('aboutModal').classList.remove('show');
    document.getElementById('keybindingsModal').classList.remove('show');
  }
});

// ===== Tree Search Filter =====
document.getElementById('treeSearch').addEventListener('input', () => {
  renderTree();
});

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
  loadFileTree();
});

loadFileTree();
