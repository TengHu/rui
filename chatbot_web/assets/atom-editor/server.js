const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = parseInt(process.env.PORT) || 3001;
const WORKSPACE = '/home/user/workspace';

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.js': 'javascript', '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx',
    '.py': 'python', '.rb': 'ruby', '.java': 'java', '.c': 'c', '.cpp': 'cpp',
    '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp', '.go': 'go', '.rs': 'rust',
    '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.json': 'json', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
    '.sql': 'sql', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin',
    '.r': 'r', '.lua': 'lua', '.toml': 'toml', '.ini': 'ini',
    '.dockerfile': 'dockerfile', '.tf': 'hcl', '.vue': 'html',
    '.svelte': 'html', '.graphql': 'graphql', '.proto': 'protobuf',
  };
  return map[ext] || 'plaintext';
}

function readDirTree(dirPath, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];

    // Sort: directories first, then files, alphabetical
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted) {
      // Skip hidden/system dirs
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(WORKSPACE, fullPath);

      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          path: relativePath,
          type: 'directory',
          children: readDirTree(fullPath, depth + 1, maxDepth),
        });
      } else {
        const stats = fs.statSync(fullPath);
        result.push({
          name: entry.name,
          path: relativePath,
          type: 'file',
          size: stats.size,
          language: getLanguage(entry.name),
        });
      }
    }
    return result;
  } catch (e) {
    return [];
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API Routes
  if (url.pathname === '/api/tree') {
    const dir = url.searchParams.get('dir') || '';
    const fullPath = path.join(WORKSPACE, dir);
    if (!fullPath.startsWith(WORKSPACE)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }
    const tree = readDirTree(fullPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tree));
    return;
  }

  if (url.pathname === '/api/file' && req.method === 'GET') {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Path required' }));
      return;
    }
    const fullPath = path.join(WORKSPACE, filePath);
    if (!fullPath.startsWith(WORKSPACE)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }
    try {
      const stats = fs.statSync(fullPath);
      if (stats.size > 2 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large (>2MB)' }));
        return;
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      const language = getLanguage(fullPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content, language, path: filePath }));
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }
    return;
  }

  if (url.pathname === '/api/file' && req.method === 'PUT') {
    try {
      const body = await parseBody(req);
      const fullPath = path.join(WORKSPACE, body.path);
      if (!fullPath.startsWith(WORKSPACE)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied' }));
        return;
      }
      fs.writeFileSync(fullPath, body.content, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/file' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const fullPath = path.join(WORKSPACE, body.path);
      if (!fullPath.startsWith(WORKSPACE)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied' }));
        return;
      }
      if (body.type === 'directory') {
        fs.mkdirSync(fullPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, body.content || '', 'utf-8');
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/file' && req.method === 'DELETE') {
    const filePath = url.searchParams.get('path');
    const fullPath = path.join(WORKSPACE, filePath);
    if (!fullPath.startsWith(WORKSPACE) || fullPath === WORKSPACE) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }
    try {
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true });
      } else {
        fs.unlinkSync(fullPath);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/search') {
    const query = url.searchParams.get('q');
    const searchDir = url.searchParams.get('dir') || '';
    const fullDir = path.join(WORKSPACE, searchDir);

    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query required' }));
      return;
    }

    exec(`grep -rn --include="*.{js,ts,py,html,css,json,md,txt,jsx,tsx,go,rs,java,c,cpp,h,rb,sh,yaml,yml,toml,sql}" -l "${query.replace(/"/g, '\\"')}" "${fullDir}" 2>/dev/null | head -50`,
      { timeout: 5000 }, (err, stdout) => {
        const files = stdout ? stdout.trim().split('\n').filter(Boolean).map(f => path.relative(WORKSPACE, f)) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files, query }));
    });
    return;
  }

  // Static file serving
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Atom Editor running on http://0.0.0.0:${PORT}`);
});
