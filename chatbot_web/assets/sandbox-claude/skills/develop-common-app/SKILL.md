---
name: develop-common-app
description: Use this skill when building standard web applications for common RouteWindow iframes. Each app runs on its own dedicated port (3001+) and is rendered via a plain iframe. When users send messages through a common window chat, you MUST use this skill to build the application.
---

# Develop Common App

Build standard web applications that serve on a dedicated port and render in a plain iframe. Unlike MCP apps (port 3000, AppRenderer), common apps are standalone web servers on their own port.

## CRITICAL Requirements

1. **Dedicated Port**: Your app MUST listen on the port specified in the system prompt (e.g., 3001, 3002, etc.)
2. **Bind to 0.0.0.0**: Always bind to `0.0.0.0:{PORT}`, never `localhost` or `127.0.0.1` (required for E2B port forwarding)
3. **Background the server**: Use `run_in_background: true` or `&` when starting the server
4. **Self-contained**: Each app lives in its own folder under `/home/user/workspace/`
5. **No MCP**: Do NOT use create-mcp-app, do NOT register with port 3000, do NOT import @modelcontextprotocol packages
6. **UI Design & Aesthetics**: **MUST follow `style.md`** for all app aesthetic and UI design decisions. The `style.md` file in this skill directory defines the enterprise industrial analytics UI look and feel. Always reference it when designing interfaces, choosing colors, typography, layouts, and visual elements.

## Framework Options

| Framework | Best For | Start Command |
|-----------|----------|---------------|
| Static HTML + Node HTTP | Simple apps, no build step | `node server.js &` |
| Express | APIs, dynamic content | `node app.js &` |
| Vite (React/Vue/Svelte) | Modern SPAs | `npx vite --host 0.0.0.0 --port {PORT} &` |
| Python Flask | Python-based apps | `python app.py &` |
| Python http.server | Quick static serving | `python -m http.server {PORT} --bind 0.0.0.0 &` |

## Files to Maintain

**CRITICAL**: Before performing ANY action (starting servers, stopping processes, creating apps), you MUST check and potentially update these files. After completing actions, you MUST update them accordingly.

### Process Registry — `/home/user/workspace/.window-agents/processes.json`

- **Purpose**: Tracks all running window app servers to prevent conflicts and accidental kills
- **When to check**: Before starting any server, before stopping any process, before checking port availability
- **When to update**: After starting a server (add entry), after stopping a server (remove entry), when cleaning up stale entries
- **Format**: JSON file containing array of process objects with `pid`, `port`, `app_name`, `cwd`, `command`, `started_by`, `started_at`

### Maintenance Workflow

**Before ANY action:**
1. Read `/home/user/workspace/.window-agents/processes.json` to understand current state
2. Check if registry exists, create if missing: `mkdir -p /home/user/workspace/.window-agents && [ -f /home/user/workspace/.window-agents/processes.json ] || echo '{"processes":[]}' > /home/user/workspace/.window-agents/processes.json`
3. Verify port availability by checking registry
4. Check for stale entries and clean them up if needed

**After ANY action:**
1. If you started a server: Add entry to registry with PID, port, app name, working directory, command, agent ID, and timestamp
2. If you stopped a server: Remove entry from registry using PID
3. Verify registry integrity: Ensure JSON is valid and entries are accurate

**Never skip these checks** — they prevent conflicts and protect other agents' running applications.

## Implementation Steps

### 1. Create App Folder

```bash
mkdir -p /home/user/workspace/my-app-name
cd /home/user/workspace/my-app-name
```

### 2. Build Your App

Create all necessary files (HTML, CSS, JS, server code) in the app folder. **Follow `style.md`** for all visual design decisions.

### 3. Static Server Template (Node.js)

For static HTML apps, create a `server.js`:

```javascript
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = {PORT};

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
};

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
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
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
```

### 4. Start the Server

```bash
cd /home/user/workspace/my-app-name
node server.js &
```

Use `run_in_background: true` for the Bash tool call.

### 5. Register the Process

After starting the server, register it in the process registry:

```bash
mkdir -p /home/user/workspace/.window-agents
[ -f /home/user/workspace/.window-agents/processes.json ] || echo '{"processes":[]}' > /home/user/workspace/.window-agents/processes.json

APP_PID=$!

jq --arg pid "$APP_PID" \
   --arg port "{PORT}" \
   --arg app_name "my-app-name" \
   --arg cwd "/home/user/workspace/my-app-name" \
   --arg started_by "{agent_id}" \
   '.processes += [{
       pid: ($pid|tonumber),
       port: ($port|tonumber),
       app_name: $app_name,
       cwd: $cwd,
       command: "node server.js",
       started_by: $started_by,
       started_at: (now | todate)
   }]' /home/user/workspace/.window-agents/processes.json > /tmp/reg.json && mv /tmp/reg.json /home/user/workspace/.window-agents/processes.json
```

### 6. Verify It's Running

```bash
curl -sf http://localhost:{PORT} || echo __DOWN__
```

### 7. Register the App (MANDATORY)

After verifying the app is running, you **MUST** write a JSON registry file to `/home/user/workspace/.common_app_registry/`. The filename should be `{app-name}.json` (matching your app folder name).

```bash
mkdir -p /home/user/workspace/.common_app_registry
TIMESTAMP=$(date -Iseconds)
cat > /home/user/workspace/.common_app_registry/my-app-name.json << REGISTRY_EOF
{
  "name": "my-app-name",
  "title": "My App Name",
  "port": {PORT},
  "command": "node server.js",
  "app_dir": "/home/user/workspace/my-app-name",
  "logo": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none'><rect width='48' height='48' rx='10' fill='#2563eb'/><text x='24' y='32' text-anchor='middle' fill='white' font-size='24' font-family='sans-serif'>A</text></svg>",
  "created_at": "$TIMESTAMP"
}
REGISTRY_EOF
```

**Registry JSON fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | App folder name (e.g., `todo-app`) |
| `title` | Yes | Human-readable display name (e.g., `Todo App`) |
| `port` | Yes | The port the app is running on |
| `command` | Yes | Command to start the app (e.g., `node server.js`) |
| `app_dir` | Yes | Absolute path to the app folder |
| `logo` | Yes | Inline SVG string for the desktop icon. Design a **unique, relevant** icon for the app (use appropriate colors, shapes, or symbols). Keep it simple — single-color icon with a recognizable symbol. |
| `created_at` | Yes | ISO 8601 timestamp |

**Logo guidelines:**
- Must be a valid inline SVG string (single line, use single quotes for attributes)
- ViewBox should be `0 0 48 48`
- Use a colored rounded rectangle background (`rx='10'`)
- Add a meaningful symbol or letter that represents the app
- Keep it simple — the SVG renders at ~32x32px on the desktop
- Examples: calculator icon for math apps, chart icon for dashboards, checkmark for todo apps

## Process Registry (Protecting Running Apps)

The sandbox may have **multiple window apps running simultaneously**, each with its own server. To prevent accidentally killing another app's server (or being killed by another agent), **always use the process registry**.

### The Problem

Without coordination:
- Agent A starts a spreadsheet editor on port 3000
- Agent B needs to restart their todo app, runs `pkill -f "node server.js"`
- Agent A's spreadsheet editor dies unexpectedly
- User loses their work

### Registry File

```
/home/user/workspace/.window-agents/processes.json
```

```json
{
  "processes": [
    {
      "pid": 1234,
      "port": 3000,
      "app_name": "spreadsheet-editor",
      "cwd": "/home/user/workspace/spreadsheet-editor",
      "command": "node server.js",
      "started_by": "agent-abc123",
      "started_at": "2025-01-20T10:30:00Z"
    }
  ]
}
```

### Before Stopping Any Server

**NEVER use these commands:**
```bash
# DANGEROUS — kills ALL node servers including other apps
pkill -f "node"
pkill -f "server.js"
killall node
kill $(pgrep -f node)
```

**ALWAYS check the registry first:**
```bash
# List all running apps
jq -r '.processes[] | "\(.pid)\t\(.port)\t\(.app_name)\t\(.started_by)"' /home/user/workspace/.window-agents/processes.json | column -t

# Find YOUR app specifically
jq -r '.processes[] | select(.app_name == "my-app-name") | .pid' /home/user/workspace/.window-agents/processes.json
```

**Only kill YOUR app's process:**
```bash
MY_PID=$(jq -r '.processes[] | select(.app_name == "my-app-name" and .started_by == "{agent_id}") | .pid' /home/user/workspace/.window-agents/processes.json)

if [ -n "$MY_PID" ]; then
    kill $MY_PID
    jq 'del(.processes[] | select(.pid == '$MY_PID'))' /home/user/workspace/.window-agents/processes.json > /tmp/reg.json && mv /tmp/reg.json /home/user/workspace/.window-agents/processes.json
fi
```

### Cleanup Stale Entries

If a process died without being unregistered:
```bash
for pid in $(jq -r '.processes[].pid' /home/user/workspace/.window-agents/processes.json); do
    if ! kill -0 $pid 2>/dev/null; then
        jq "del(.processes[] | select(.pid == $pid))" /home/user/workspace/.window-agents/processes.json > /tmp/reg.json && mv /tmp/reg.json /home/user/workspace/.window-agents/processes.json
    fi
done
```

## Updating an Existing App

When modifying an app that's already running:

1. **Check the process registry** to find the running process:
```bash
jq -r '.processes[] | select(.app_name == "my-app-name") | .pid' /home/user/workspace/.window-agents/processes.json
```

2. **Kill only your app's process** (fallback to lsof if not in registry):
```bash
PID=$(lsof -t -i:{PORT})
if [ -n "$PID" ]; then kill $PID; fi
```

3. **Remove from process registry:**
```bash
jq 'del(.processes[] | select(.app_name == "my-app-name"))' /home/user/workspace/.window-agents/processes.json > /tmp/reg.json && mv /tmp/reg.json /home/user/workspace/.window-agents/processes.json
```

4. Make your changes to the app files

5. Restart the server and re-register the process (see Steps 4-5 above)

6. Verify:
```bash
curl -sf http://localhost:{PORT} || echo __DOWN__
```

## App Organization

### Folder Structure

```
/home/user/workspace/
├── desktop/              # User-uploaded files go here
└── my-app-name/          # Your app folder
    ├── index.html
    ├── style.css         # Optional: separate CSS file
    ├── app.js            # Optional: separate JS file
    └── server.js         # Node.js server (for static files)
```

### Self-Contained Principle

- **One app = One folder**: Each application gets its own directory
- **No shared dependencies**: Don't rely on files outside the app folder
- **Portable**: The entire app folder should be movable without breaking
- **Clear naming**: Use descriptive folder names (e.g., `todo-app`, `chart-viewer`, `data-table`)

## Best Practices

1. **Always create a folder**: Never put app files directly in `/home/user/workspace/`
2. **Use descriptive names**: `todo-app` is better than `app1`
3. **Keep it self-contained**: All assets (CSS, JS, images) should be in the app folder
4. **Follow style.md for UI design**: Always reference `style.md` for aesthetic decisions, color schemes, typography, and visual design patterns
5. **Use the correct port**: Always use the port specified in the system prompt (`{PORT}`)
6. **Bind to 0.0.0.0**: Required for E2B port forwarding
7. **Register your process**: Always add to `/home/user/workspace/.window-agents/processes.json`
8. **Check before killing**: Only kill PIDs you own, never use broad `pkill`
9. **Always register the app**: Write a JSON file to `.common_app_registry/` so the app appears on the desktop
10. **Verify after starting**: Always curl to confirm the server is up

## Common Mistakes

- Using `localhost` instead of `0.0.0.0` (app won't be reachable from outside sandbox)
- Using port 3000 (reserved for MCP server)
- Using `create-mcp-app` skill (wrong skill for common windows)
- Forgetting to background the server process
- Using `pkill node` (kills ALL node processes including other windows' apps)
- Forgetting to write the registry JSON file (app won't appear on the desktop)
- Forgetting to update the process registry when starting/stopping servers
- Creating files directly in `/home/user/workspace/` without a folder
