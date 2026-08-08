const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 3002;

const WORKSPACE = '/home/user/workspace';
const DESKTOP = path.join(WORKSPACE, 'desktop');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.pdf': 'application/pdf',
};

// Ensure desktop directory exists
if (!fs.existsSync(DESKTOP)) {
  fs.mkdirSync(DESKTOP, { recursive: true });
}

function safePath(requestedPath) {
  const resolved = path.resolve(WORKSPACE, requestedPath || '');
  if (!resolved.startsWith(WORKSPACE)) return null;
  return resolved;
}

function getFileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return {
      name: path.basename(filePath),
      path: filePath.replace(WORKSPACE, ''),
      fullPath: filePath,
      isDir: stat.isDirectory(),
      size: stat.size,
      modified: stat.mtime.toISOString(),
      ext: ext,
    };
  } catch (e) {
    return null;
  }
}

function listDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath);
    const items = [];
    for (const entry of entries) {
      if (entry.startsWith('.')) continue; // skip hidden files
      const fullPath = path.join(dirPath, entry);
      const info = getFileInfo(fullPath);
      if (info) items.push(info);
    }
    // Sort: dirs first, then alphabetical
    items.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return items;
  } catch (e) {
    return [];
  }
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const boundary = req.headers['content-type'].split('boundary=')[1];
    if (!boundary) return reject(new Error('No boundary'));

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const str = buf.toString('binary');
      const parts = str.split('--' + boundary);
      const files = [];

      for (const part of parts) {
        if (part === '--\r\n' || part === '--' || !part.trim()) continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headers = part.substring(0, headerEnd);
        const body = part.substring(headerEnd + 4);

        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const nameMatch = headers.match(/name="([^"]+)"/);

        if (filenameMatch && filenameMatch[1]) {
          // Remove trailing \r\n
          let content = body;
          if (content.endsWith('\r\n')) content = content.slice(0, -2);
          files.push({
            fieldName: nameMatch ? nameMatch[1] : 'file',
            filename: filenameMatch[1],
            data: Buffer.from(content, 'binary'),
          });
        }
      }
      resolve(files);
    });
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API Routes
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    // List directory
    if (pathname === '/api/list' && req.method === 'GET') {
      const dirParam = url.searchParams.get('path') || '';
      const fullPath = safePath(dirParam);
      if (!fullPath) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Access denied' }));
        return;
      }
      try {
        const items = listDir(fullPath);
        const parentPath = fullPath === WORKSPACE ? null : path.dirname(fullPath).replace(WORKSPACE, '') || '/';
        res.writeHead(200);
        res.end(JSON.stringify({
          path: fullPath.replace(WORKSPACE, '') || '/',
          parent: parentPath === '/' || parentPath === '' ? null : parentPath,
          items,
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Read file content (for CSV/TSV/text)
    if (pathname === '/api/read' && req.method === 'GET') {
      const filePath = url.searchParams.get('path') || '';
      const fullPath = safePath(filePath);
      if (!fullPath) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Access denied' }));
        return;
      }
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Cannot read directory' }));
          return;
        }
        // Limit to 50MB
        if (stat.size > 50 * 1024 * 1024) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: 'File too large (max 50 MB)' }));
          return;
        }
        const content = fs.readFileSync(fullPath, 'utf-8');
        res.writeHead(200);
        res.end(JSON.stringify({ content, size: stat.size, name: path.basename(fullPath) }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Upload file to desktop
    if (pathname === '/api/upload' && req.method === 'POST') {
      try {
        const targetDir = url.searchParams.get('path') || 'desktop';
        const targetFullPath = safePath(targetDir);
        if (!targetFullPath) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Access denied' }));
          return;
        }
        if (!fs.existsSync(targetFullPath)) {
          fs.mkdirSync(targetFullPath, { recursive: true });
        }

        const files = await parseMultipart(req);
        const uploaded = [];
        for (const file of files) {
          const dest = path.join(targetFullPath, file.filename);
          fs.writeFileSync(dest, file.data);
          uploaded.push({ name: file.filename, path: dest.replace(WORKSPACE, ''), size: file.data.length });
        }
        res.writeHead(200);
        res.end(JSON.stringify({ uploaded }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Delete file
    if (pathname === '/api/delete' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const fullPath = safePath(body.path);
        if (!fullPath || fullPath === WORKSPACE) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Access denied' }));
          return;
        }
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true });
        } else {
          fs.unlinkSync(fullPath);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ deleted: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Create directory
    if (pathname === '/api/mkdir' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const fullPath = safePath(body.path);
        if (!fullPath) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Access denied' }));
          return;
        }
        fs.mkdirSync(fullPath, { recursive: true });
        res.writeHead(200);
        res.end(JSON.stringify({ created: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Download file (raw)
    if (pathname === '/api/download' && req.method === 'GET') {
      const filePath = url.searchParams.get('path') || '';
      const fullPath = safePath(filePath);
      if (!fullPath) {
        res.writeHead(403);
        res.end('Access denied');
        return;
      }
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          res.writeHead(400);
          res.end('Cannot download directory');
          return;
        }
        const ext = path.extname(fullPath).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        const data = fs.readFileSync(fullPath);
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': `attachment; filename="${path.basename(fullPath)}"`,
          'Content-Length': data.length,
        });
        res.end(data);
      } catch (e) {
        res.writeHead(404);
        res.end('File not found');
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Static file serving
  let filePath = pathname === '/' ? '/index.html' : pathname.split('?')[0];
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
  console.log(`CSV Explorer running on http://0.0.0.0:${PORT}`);
});
