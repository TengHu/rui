# MCP Apps: Design Document

## Table of Contents

1. [What We're Building](#what-were-building)
2. [Key Concepts](#key-concepts)
3. [System Overview](#system-overview)
4. [How It Works (Step by Step)](#how-it-works-step-by-step)
5. [The Three Participants](#the-three-participants)
6. [Data Flow Diagrams](#data-flow-diagrams)
7. [File-by-File Implementation Guide](#file-by-file-implementation-guide)
8. [Glossary](#glossary)

---

## What We're Building

We have a desktop app where users open "windows." Each window has a chat box. The user types a request like "Build me a hello world app" and an AI agent (Claude) builds and runs an interactive web app inside that window.

Today, those apps are simple static HTML pages. We want to upgrade them to **MCP Apps** — interactive apps that can:

- Call **tools** (functions on the server) when the user clicks buttons
- Receive **live updates** from the AI when it calls tools on their behalf
- **Share tools** across windows (Window B's app can use Window A's tools)

### What Can MCP Apps Do?

MCP Apps are **full web applications**, not static pages. The UI is HTML/CSS/JS bundled by Vite — it can use any client-side library or framework:

- **3D**: Three.js, Babylon.js, React Three Fiber
- **Visualization**: D3, Chart.js, Plotly, ECharts
- **Multi-tab / complex UI**: Tabs, panels, drag-and-drop — it's just DOM
- **Rich frameworks**: React, Vue, Svelte — all work inside the bundle
- **Canvas/WebGL**: Games, editors, drawing tools
- **State management**: useState, Redux, Zustand, or plain JS variables

On the server side, tool handlers are TypeScript functions with **full Node.js access** inside the e2b sandbox:

- **Read/write files** with `fs` (e.g., a file manager app)
- **Run shell commands** with `child_process`
- **Access the entire sandbox filesystem** (`/home/user/workspace/...`)
- **Install and use any npm package**
- **Persist data to disk**

The only packaging constraint is `vite-plugin-singlefile` — everything (JS, CSS, assets) gets inlined into one HTML file. This is a packaging constraint, not a capability constraint. A 5MB single-file app with Three.js and React works fine.

### The Problem Today

```
Today:  Agent builds HTML → starts a server → iframe loads the URL → done (static)
```

There's no communication between the app and the AI after the initial load. The app can't call tools, and the AI can't push updates to the app.

### What We Want

```
Goal:   Agent builds app → registers tools with shared server → iframe loads UI
        → App calls tools via postMessage → AI calls tools → results pushed to app
```

---

## Key Concepts

### What is MCP?

**MCP (Model Context Protocol)** is a standard for connecting AI models to tools and data. Think of it like a USB port — any AI can plug into any MCP server to access its tools.

An MCP server exposes:
- **Tools** — functions the AI or app can call (e.g., `hello(name)` returns a greeting)
- **Resources** — data the server can provide (e.g., HTML for the app's UI)

### What is an MCP App?

An **MCP App** has two parts:

1. **Tool handlers** — TypeScript functions that run on the server (the "backend logic")
2. **UI** — An HTML page that runs in an iframe (the "frontend")

The UI talks to the server through a **Host** (our `AppBridge` component), which relays messages via `postMessage`.

### The Three Roles

| Role | What it is | Where it runs |
|------|-----------|---------------|
| **MCP Server** | Holds tools + resources. Executes tool handlers. | Inside the e2b sandbox, port 3000 |
| **Host** (AppBridge) | Bridges the iframe UI and the MCP server. Handles the postMessage protocol. | In the browser (React component) |
| **App** (UI) | The interactive HTML/JS that the user sees. Calls tools, shows results. | Inside an iframe in the browser |

```
┌─────────────────────────────────────────────────────┐
│                     Browser                          │
│                                                      │
│  ┌──────────────┐    postMessage    ┌──────────────┐ │
│  │   App (UI)   │ ←──────────────→ │    Host      │ │
│  │  (iframe)    │                   │ (AppBridge)  │ │
│  └──────────────┘                   └──────┬───────┘ │
│                                            │ fetch   │
└────────────────────────────────────────────┼─────────┘
                                             │
                                             ▼
                                   ┌─────────────────┐
                                   │   MCP Server     │
                                   │  (port 3000)     │
                                   │  in e2b sandbox  │
                                   └─────────────────┘
```

---

## System Overview

### Architecture

There is **one shared MCP server** per user session. It runs on port 3000 inside the e2b sandbox. It starts automatically when the sandbox is created (before any user action).

Apps don't run their own servers. Instead, when an AI agent builds an app, it:
1. Creates files on disk (tool handlers + UI code)
2. Builds the UI with Vite (produces a single HTML file)
3. Calls `curl POST localhost:3000/register` to load the app into the shared MCP server

The MCP server then:
- Imports the tool handler TypeScript files
- Reads the bundled HTML file
- Makes them available via the MCP protocol (`tools/list`, `tools/call`, `resources/read`)

```
┌──────────────────────── e2b Sandbox ─────────────────────────────┐
│                                                                   │
│   MCP Server (port 3000)                                          │
│   ┌─────────────────────────────────────────────────────┐         │
│   │  toolRegistry:                                       │         │
│   │    "hello"        → handler from hello-world app     │         │
│   │    "render-chart" → handler from chart-viewer app    │         │
│   │                                                       │         │
│   │  resourceRegistry:                                    │         │
│   │    "ui://hello-world/mcp-app.html"  → "<html>..."    │         │
│   │    "ui://chart-viewer/mcp-app.html" → "<html>..."    │         │
│   └─────────────────────────────────────────────────────┘         │
│                                                                   │
│   App files (on disk, no running process):                        │
│   /workspace/hello-world/tools/hello.ts                           │
│   /workspace/hello-world/dist/mcp-app.html                        │
│   /workspace/chart-viewer/tools/chart.ts                          │
│   /workspace/chart-viewer/dist/mcp-app.html                       │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Port Allocation

| What | Port | Notes |
|------|------|-------|
| MCP Server | 3000 (fixed) | Always running, shared by all apps |
| Non-MCP apps (static HTML) | 3001, 3002, ... | Only for `create-window-app` skill |

**MCP apps need zero extra ports.** No per-app server processes, no per-app ports. Everything goes through port 3000:

- **Tool execution** — happens in-process inside the MCP server (dynamic `import()` of the app's `tools/*.ts` files)
- **UI HTML** — served as an MCP resource via `resources/read`, then loaded as a Blob URL in the browser (no HTTP server needed for the UI)
- **Tool calls from the UI** — go through AppBridge → backend → `POST https://3000-{sandboxId}.e2b.app/mcp`

```
MCP app:        files on disk → registered into port 3000 → no extra port
Non-MCP app:    files on disk → own Express server → port 3001, 3002, ...
```

---

## How It Works (Step by Step)

### Phase 1: Sandbox Starts Up

When a user opens the desktop app, a sandbox is created:

```
1. Python backend calls e2b to create a sandbox
2. Backend uploads MCP server files to /workspace/.mcp-server/
3. Backend runs: npm install && PORT=3000 npx tsx server.ts &
4. MCP server is now listening on port 3000 (no apps registered yet)
```

**File involved:** `chatbot_web/services/sandbox_service.py`

### Phase 2: User Asks to Build an App

User types "Build me a hello world app" in Window A:

```
1. Frontend sends POST /api/route-windows/{windowId}/chat
2. Backend allocates a port (3001) and starts the AI agent in the sandbox
3. Agent reads the create-mcp-app skill instructions
4. Agent creates files:
   - /workspace/hello-world/package.json
   - /workspace/hello-world/tools/hello.ts      ← tool handler
   - /workspace/hello-world/mcp-app.html         ← UI entry point
   - /workspace/hello-world/src/mcp-app.ts        ← UI logic
   - /workspace/hello-world/vite.config.ts
5. Agent runs: npm install && npm run build
6. Agent registers: curl POST localhost:3000/register {"name":"hello-world","appDir":"..."}
7. MCP server loads the tool handler and HTML into memory
```

**Files involved:** `route_windows_fastapi.py`, `.claude/skills/create-mcp-app/skill.md`

### Phase 3: Backend Discovers the App

After the agent finishes, the backend checks what got registered:

```
1. Backend calls MCP server: tools/list
   → Response: [{name: "hello", _meta: {ui: {resourceUri: "ui://hello-world/mcp-app.html"}}}]

2. Backend calls MCP server: resources/read {uri: "ui://hello-world/mcp-app.html"}
   → Response: {text: "<html>...bundled app HTML..."}

3. Backend calls MCP server: tools/call {name: "hello", arguments: {name: "World"}}
   → Response: {content: [{type: "text", text: "Hello, World!"}]}

4. Backend sends to frontend:
   {
     mcp_server_url: "https://3000-{sandboxId}.e2b.app",
     mcp_discovery: {
       tools: [...],
       resource_entries: [{
         tool_name: "hello",
         resource_uri: "ui://hello-world/mcp-app.html",
         resource_html: "<html>...",           ← the full HTML
         initial_result: {content: [{text: "Hello, World!"}]}
       }]
     }
   }
```

**File involved:** `route_windows_fastapi.py`

### Phase 4: Frontend Renders the App

The frontend receives the HTML and renders it:

```
1. Frontend creates a Blob URL from the HTML string:
   const blob = new Blob([html], { type: 'text/html' })
   const blobUrl = URL.createObjectURL(blob)

2. Sets iframe.src = blobUrl

3. Mounts AppBridge component (the Host)

4. App (inside iframe) sends: ui/initialize (via postMessage)
5. AppBridge responds: {protocolVersion, hostInfo, hostCapabilities, hostContext}
6. App sends: ui/notifications/initialized
7. AppBridge pushes the initial tool result: sendToolResult({content: [{text: "Hello, World!"}]})
8. App's ontoolresult handler fires → UI updates to show "Hello, World!"
```

**Files involved:** `RouteWindow.jsx`, `AppBridge.jsx`, `RouteWindowContext.jsx`

### Phase 5: User Interacts with the App

When the user clicks "Greet" button in the app UI:

```
1. App calls: app.callServerTool({name: "hello", arguments: {name: "John"}})
2. This sends a postMessage to AppBridge: {method: "tools/call", params: {...}}
3. AppBridge forwards to Python backend: POST /api/route-windows/{id}/mcp-tool-call
4. Backend forwards to MCP server: POST https://3000-{sandboxId}.e2b.app/mcp
5. MCP server runs the hello handler → returns {content: [{text: "Hello, John!"}]}
6. Response flows back: MCP server → Backend → AppBridge → App
7. App's callServerTool promise resolves with the result
```

### Phase 6: AI Calls a Tool (Follow-up Chat)

User types "Greet Alice" in the chat:

```
1. Frontend sends chat message to backend
2. Backend resumes the AI agent session
3. Agent sees MCP tools in system prompt, decides to call "hello" tool
4. Agent runs: curl POST localhost:3000/mcp -d '{"method":"tools/call",...}'
5. MCP server runs handler → returns result
6. FilePoller (in backend) detects the tool call in the agent's events
7. Backend emits SSE events: mcp_tool_input + mcp_tool_result
8. Frontend receives SSE → dispatches PUSH_MCP_TOOL_RESULT
9. AppBridge sees new pendingToolResult → calls sendToolResult(...)
10. App's ontoolresult fires → UI shows "Hello, Alice!"
```

**Files involved:** `app_fastapi.py` (FilePoller), `sandbox_agent1.py`, `RouteWindowContext.jsx`, `AppBridge.jsx`

---

## The Three Participants

### 1. MCP Server (`chatbot_web/assets/mcp-server/server.ts`)

**What it does:** Holds all tools and resources in memory. Executes tool handlers directly.

**Endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/mcp` | POST | MCP protocol (JSON-RPC 2.0) — tools/list, tools/call, resources/read, etc. |
| `/register` | POST | Load an app: `{name, appDir}` → imports tools, reads HTML |
| `/unregister` | POST | Remove an app's tools and resources |
| `/health` | GET | Status check + list of registered apps |

**How `/register` works:**

```typescript
// 1. Read the bundled HTML from disk
const html = await fs.readFile(path.join(appDir, 'dist', 'mcp-app.html'), 'utf-8');
const resourceUri = `ui://${name}/mcp-app.html`;
resourceRegistry.set(resourceUri, html);

// 2. Import tool handler modules from the tools/ directory
const toolFiles = await fs.readdir(path.join(appDir, 'tools'));
for (const file of toolFiles) {
  const mod = await import(path.join(appDir, 'tools', file));
  // mod.tool = { name, title, description, inputSchema }
  // mod.handler = async function(args) { return {content: [...]} }
  toolRegistry.set(mod.tool.name, {
    schema: { ...mod.tool, _meta: { ui: { resourceUri } } },
    handler: mod.handler,
  });
}
```

**How `/mcp` works (per-request stateless):**

```typescript
app.post('/mcp', async (req, res) => {
  // Create a fresh McpServer with ALL currently-registered tools/resources
  const server = createServer(); // reads from toolRegistry + resourceRegistry
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

Each request gets a fresh `McpServer` instance populated with whatever tools are currently registered. This is how hot-loading works — register a new app, and the next request sees the new tools.

### 2. Host / AppBridge (`AppBridge.jsx`)

**What it does:** Sits between the iframe (App) and the MCP server. Translates postMessage ↔ HTTP.

**Messages it handles (from App → Host):**

| Method | What happens |
|--------|-------------|
| `ui/initialize` | Returns protocol version, capabilities, theme info |
| `tools/call` | Forwards to backend → MCP server → returns result |
| `ui/open-link` | Opens URL in new tab |
| `resources/list` | Forwards to MCP server |
| `resources/read` | Forwards to MCP server |

**Messages it sends (Host → App):**

| Notification | When |
|-------------|------|
| `sendToolResult(result)` | After initial load, or when AI calls a tool |
| `sendToolInput(args)` | When AI starts calling a tool (shows the arguments) |
| `sendToolInputPartial(args)` | During streaming — partial arguments as AI generates them |

**Key lifecycle:**

```
1. iframe loads
2. App sends "ui/initialize"
3. AppBridge responds with capabilities
4. App sends "ui/notifications/initialized"
5. AppBridge pushes initial tool result (if available)
6. Bidirectional communication is now active
```

### 3. App / UI (`src/mcp-app.ts`)

**What it does:** The interactive HTML page the user sees. Uses `@modelcontextprotocol/ext-apps` SDK.

**Key pattern:**

```typescript
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "Hello World", version: "1.0.0" });

// Register handlers BEFORE connect()
app.ontoolresult = (result) => {
  // Called when AI pushes a tool result
  const text = result.content?.find(c => c.type === "text")?.text;
  document.getElementById("output").textContent = text;
};

app.ontoolinputpartial = (params) => {
  // Called during streaming (optional)
  showPreview(params.arguments);
};

// Connect to host (starts postMessage communication)
app.connect();

// User-triggered tool calls
button.addEventListener("click", async () => {
  const result = await app.callServerTool({
    name: "hello",
    arguments: { name: input.value }
  });
  showResult(result);
});
```

**Important:** Register ALL handlers BEFORE calling `app.connect()`.

### Two Execution Environments

Every MCP App runs code in two places. Understanding this split is critical:

| What | Where | Can do |
|------|-------|--------|
| UI rendering, state, user interaction | **Browser** (iframe) | Anything a web app can do — React, Three.js, D3, Canvas, state management |
| File I/O, shell commands, data processing | **Sandbox** (tool handlers) | Full Node.js — `fs`, `child_process`, any npm package, full filesystem access |
| Communication between them | postMessage via AppBridge | `callServerTool()` (UI → server) / `ontoolresult` (server → UI) |

**Example — File Manager App:**

Tool handler (runs in sandbox, has filesystem access):
```typescript
// tools/list-files.ts
import fs from "node:fs/promises";
import { z } from "zod";

export const tool = {
  name: "list-files",
  description: "List files in a directory",
  inputSchema: { path: z.string().describe("Directory path") },
};

export async function handler({ path }: { path: string }) {
  const entries = await fs.readdir(path, { withFileTypes: true });
  const files = entries.map(e => ({ name: e.name, isDir: e.isDirectory() }));
  return { content: [{ type: "text" as const, text: JSON.stringify(files) }] };
}
```

UI (runs in browser, calls tools on user interaction):
```typescript
// src/mcp-app.ts — the UI calls tools to interact with the sandbox filesystem
browseBtn.addEventListener("click", async () => {
  const result = await app.callServerTool({
    name: "list-files",
    arguments: { path: currentPath }
  });
  // Tool ran inside the sandbox, read the real filesystem, returned results
  const files = JSON.parse(result.content[0].text);
  renderFileList(files);
});
```

The UI never touches the filesystem directly. It calls tools, and the tool handlers (which run server-side in the sandbox) do the actual work.

---

## Data Flow Diagrams

### Flow 1: App Calls a Tool (User Clicks Button)

```
App (iframe)          AppBridge (Host)         Python Backend         MCP Server
     │                      │                       │                     │
     │  postMessage          │                       │                     │
     │  tools/call           │                       │                     │
     │  {name:"hello",      │                       │                     │
     │   args:{name:"Jo"}}  │                       │                     │
     │─────────────────────>│                       │                     │
     │                      │  POST /mcp-tool-call   │                     │
     │                      │─────────────────────>│                     │
     │                      │                       │  POST /mcp           │
     │                      │                       │  tools/call          │
     │                      │                       │─────────────────────>│
     │                      │                       │                     │
     │                      │                       │  runs handler()      │
     │                      │                       │  in-process          │
     │                      │                       │                     │
     │                      │                       │  ← {content:[...]}   │
     │                      │                       │<─────────────────────│
     │                      │  ← {result: ...}      │                     │
     │                      │<─────────────────────│                     │
     │  postMessage          │                       │                     │
     │  response             │                       │                     │
     │<─────────────────────│                       │                     │
```

### Flow 2: AI Calls a Tool (Follow-up Chat)

```
User types          Python Backend        Sandbox Agent        MCP Server
"Greet Alice"            │                     │                    │
     │                   │                     │                    │
     │  POST /chat       │                     │                    │
     │──────────────────>│                     │                    │
     │                   │  run agent           │                    │
     │                   │────────────────────>│                    │
     │                   │                     │  curl POST /mcp    │
     │                   │                     │  tools/call "hello" │
     │                   │                     │───────────────────>│
     │                   │                     │                    │
     │                   │                     │  ← result          │
     │                   │                     │<───────────────────│
     │                   │                     │                    │
     │                   │  (FilePoller detects │                    │
     │                   │   MCP tool call in   │                    │
     │                   │   agent events)      │                    │
     │                   │                     │                    │
     │  SSE: mcp_tool_result                   │                    │
     │<──────────────────│                     │                    │
     │                   │                     │                    │

Frontend               AppBridge              App (iframe)
     │                      │                       │
     │  dispatch             │                       │
     │  PUSH_MCP_TOOL_RESULT│                       │
     │─────────────────────>│                       │
     │                      │  postMessage           │
     │                      │  sendToolResult(...)   │
     │                      │─────────────────────>│
     │                      │                       │
     │                      │               ontoolresult fires
     │                      │               UI updates
```

---

## File-by-File Implementation Guide

### File 1: `chatbot_web/assets/mcp-server/server.ts` (NEW)

**Purpose:** The shared MCP server that all apps load into.

**What to build:**
- Express server listening on `PORT` (default 3000)
- Three in-memory registries: `toolRegistry`, `resourceRegistry`, `appRegistry`
- `POST /register` — reads app files, imports tool handlers, stores HTML
- `POST /mcp` — creates fresh `McpServer` per request with all registered tools/resources
- `GET /health` — returns list of registered apps
- `POST /unregister` — removes an app's tools and resources

**Dependencies:** `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`, `express`, `cors`, `zod`

**Run with:** `npx tsx server.ts`

**Key detail:** The server uses `StreamableHTTPServerTransport` in stateless mode (no sessions). Each `POST /mcp` request creates a new `McpServer` instance populated from the registries. This means newly registered tools are immediately available.

---

### File 2: `chatbot_web/services/sandbox_service.py` (MODIFY)

**Purpose:** Start the MCP server when the sandbox is created.

**What to add:**
- New function `_start_mcp_server(sandbox, workdir)`:
  1. Upload `server.ts` and `package.json` to `/workspace/.mcp-server/`
  2. Run `npm install` in that directory
  3. Run `PORT=3000 npx tsx server.ts &` in background
- Call this function from `get_or_create_shared_sandbox()` right after `_ensure_workdir()`

**Where:** After line where `_ensure_workdir()` is called.

---

### File 3: `chatbot_web/routes/route_windows_fastapi.py` (MODIFY)

**Purpose:** Backend API that talks to the MCP server and serves the frontend.

**What to change/add:**

1. **Port allocation:** Change `_next_port = 3000` to `_next_port = 3001`, add `MCP_SERVER_PORT = 3000`

2. **Helper function** `_mcp_server_url(sandbox_id)` → returns `https://3000-{sandbox_id}.e2b.app`

3. **Helper function** `_mcp_rpc(base_url, method, params)` — sends JSON-RPC 2.0 to the MCP server:
   ```python
   async def _mcp_rpc(base_url, method, params=None):
       response = await httpx.post(f"{base_url}/mcp", json={
           "jsonrpc": "2.0",
           "method": method,
           "params": params or {},
           "id": 1
       })
       data = response.json()
       return data.get("result")
   ```

4. **MCP discovery** — after the agent finishes building an app:
   - Call `tools/list` to find tools with `_meta.ui.resourceUri`
   - For each UI tool: call `resources/read` to get HTML, call `tools/call` for initial result
   - Return this data as `mcp_discovery` in the chat response

5. **New endpoint** `POST /{window_id}/mcp-tool-call` — proxies tool calls from the frontend to the MCP server

6. **System prompt update** — for follow-up messages, include MCP tools in the agent's system prompt so it knows what tools are available

---

### File 4: `chatbot_web/frontend/src/context/RouteWindowContext.jsx` (MODIFY)

**Purpose:** React state management for windows.

**What to add:**

1. **New reducer cases:**
   - `SET_MCP_DISCOVERY` — stores `mcpDiscovery` on a window record
   - `SET_MCP_SERVER_URL` — stores `mcpServerUrl` on a window record
   - `PUSH_MCP_TOOL_RESULT` — stores a tool result to be pushed to the app

2. **In `sendMessage` response handler:** When the backend returns `mcp_discovery` or `mcp_server_url`, dispatch the appropriate actions

3. **New SSE event handling:** When FilePoller emits `mcp_tool_result` events via SSE, dispatch `PUSH_MCP_TOOL_RESULT`

---

### File 5: `chatbot_web/frontend/src/components/RouteWindow/RouteWindow.jsx` (MODIFY)

**Purpose:** The window component that renders the iframe and chat.

**What to change:**

1. **Blob URL rendering:** When `mcpDiscovery` has `resource_html`, create a Blob URL and set it as the iframe src instead of the sandbox URL

2. **MCP detection shortcut:** When `mcpDiscovery` is present, immediately set `isMcpApp = true` (no need to poll the `/mcp` endpoint)

3. **AppBridge props:** Pass `mcpServerUrl`, `initialToolResult`, `pendingToolResult`, and `streamingEvents` to AppBridge

---

### File 6: `chatbot_web/frontend/src/components/AppBridge/AppBridge.jsx` (MODIFY)

**Purpose:** The Host that bridges iframe ↔ MCP server.

**What to change:**

1. **Rename prop:** `sandboxUrl` → `mcpServerUrl`

2. **Add new props:** `initialToolResult`, `pendingToolResult`, `streamingEvents`

3. **Add push methods:**
   - `sendToolResult(result)` — sends `ui/notifications/tool-result` via postMessage
   - `sendToolInput(args)` — sends `ui/notifications/tool-input`
   - `sendToolInputPartial(args)` — sends `ui/notifications/tool-input-partial`

4. **Push initial result after init:** When app sends `ui/notifications/initialized`, push `initialToolResult` if available

5. **React to pending results:** `useEffect` on `pendingToolResult` → call `sendToolResult()`

6. **React to streaming:** `useEffect` on `streamingEvents` → call `sendToolInputPartial()` for partial events

7. **Route tool calls through backend:** When app calls `tools/call`, don't call the MCP server directly — call `POST /api/route-windows/{windowId}/mcp-tool-call` on the backend instead

---

### File 7: `chatbot_web/app_fastapi.py` (MODIFY)

**Purpose:** FilePoller that streams agent events to the frontend via SSE.

**What to add:** Detect when the agent calls an MCP tool (via curl to localhost:3000/mcp):

1. When a `tool_start` event for `Bash` contains a curl command targeting `/mcp` with `tools/call`, emit a synthetic `mcp_tool_input` SSE event with the tool name and arguments

2. When the corresponding `tool_end` event arrives with the JSON-RPC result, emit a synthetic `mcp_tool_result` SSE event with the result content

---

### File 8: `sandbox_agent1.py` (MODIFY)

**Purpose:** The agent runner inside the sandbox.

**What to add:** Emit `input_json_delta` events for streaming tool input:

```python
elif delta.get("type") == "input_json_delta":
    emitter.emit("input_json_delta", {"partial_json": delta.get("partial_json", "")})
```

This enables the frontend to show partial tool arguments as the AI generates them (e.g., showing code as it's being written).

---

### File 9: `.claude/skills/create-mcp-app/skill.md` (MODIFY)

**Purpose:** Instructions the AI agent follows when building MCP apps.

**What to change:**

1. **Remove** `server.ts` and `main.ts` templates — apps no longer run their own server
2. **Remove** express, cors, `@modelcontextprotocol/sdk` from package.json template
3. **Add** `tools/` directory pattern with tool handler exports
4. **Change** build step from "start server" to "register with MCP server":

   Old: `PORT={port} npm run serve &`
   New: `curl POST localhost:3000/register {"name":"...", "appDir":"..."}`

5. **New app file structure:**
   ```
   /workspace/my-app/
   ├── package.json         (simpler: only ext-apps + zod + vite)
   ├── tsconfig.json
   ├── vite.config.ts
   ├── mcp-app.html         → UI entry point
   ├── src/mcp-app.ts       → UI logic
   └── tools/
       └── my-tool.ts       → exports { tool, handler }
   ```

---

### File 10: `chatbot_web/models/route_window.py` (MODIFY)

**Purpose:** Data model for window records.

**What to add:**
```python
mcp_tools: Optional[list] = None          # List of MCP tools discovered
mcp_resource_uri: Optional[str] = None    # URI of the UI resource
mcp_server_url: Optional[str] = None      # URL of the shared MCP server
```

---

## Glossary

| Term | Definition |
|------|-----------|
| **e2b Sandbox** | A remote Linux VM where code runs. One per user session. Accessible via `https://{port}-{sandboxId}.e2b.app` |
| **MCP** | Model Context Protocol — standard for connecting AI to tools |
| **MCP Server** | A process that exposes tools and resources via JSON-RPC 2.0 |
| **MCP App** | An interactive UI (HTML) + tool handlers (TypeScript) that register with the MCP server |
| **Host / AppBridge** | The bridge between an iframe (App) and the MCP server, using postMessage |
| **Tool** | A function the AI or app can call. Has a name, description, input schema, and handler |
| **Resource** | Data served by the MCP server. For apps, this is the bundled HTML |
| **Blob URL** | A browser-generated URL (`blob:...`) pointing to in-memory data. Used to load HTML into an iframe without a real server URL |
| **JSON-RPC 2.0** | The message format used by MCP: `{jsonrpc: "2.0", method: "...", params: {...}, id: 1}` |
| **postMessage** | Browser API for cross-origin iframe communication |
| **SSE** | Server-Sent Events — one-way stream from backend to frontend |
| **FilePoller** | Backend component that watches a file in the sandbox for new agent events and streams them via SSE |
| **registerAppTool** | Function from `@modelcontextprotocol/ext-apps/server` that registers a tool with UI metadata |
| **registerAppResource** | Function from `@modelcontextprotocol/ext-apps/server` that registers a UI resource |
| **StreamableHTTPServerTransport** | MCP SDK class that handles HTTP-based MCP communication |
| **tsx** | TypeScript runner for Node.js (like `node` but handles `.ts` files) |
| **Vite** | Build tool that bundles the app's HTML/CSS/JS into a single file |
| **vite-plugin-singlefile** | Vite plugin that inlines all JS/CSS into one HTML file |
