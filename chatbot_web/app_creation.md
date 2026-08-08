# MCP App Creation Flow

## App Building

User types prompt in RouteWindow chat → **React frontend** (`RouteWindowContext.sendMessage`) POSTs to `/api/route-windows/{id}/chat` → **Python backend** (`route_windows_fastapi.py`) connects to the e2b sandbox and launches the **Claude agent** (`sandbox_agent1.py` via `sandbox_runner`) → **Claude (LLM)** reads the system prompt, decides this needs interactivity, and invokes the `create-mcp-app` skill → **Claude (LLM)** follows the skill instructions: uses Bash/Write tools to create files (`tools/*.ts`, `src/mcp-app.ts`, `mcp-app.html`, `package.json`, etc.), runs `npm install && npm run build` (executed by **Node.js/Vite** inside the sandbox), then runs `curl POST localhost:3000/register` → **shared MCP server** (`server.ts`, a Node.js Express app on port 3000) receives the register call, dynamically imports the tool handlers and reads the bundled HTML into memory.

## Native MCP Tool Calls

The agent's `ClaudeAgentOptions` includes `mcp_servers: { "app-server": { type: "http", url: "http://localhost:3000/mcp" } }` → the SDK exposes MCP tools as native `tool_use` blocks, prefixed as `mcp__app-server__<tool_name>` → **Claude (LLM)** calls these tools directly (no curl) → tool results stay on the **MCP server** → the app accesses state via `callServerTool()` (pull-based, per the MCP Apps standard).

## App Rendering

**Claude agent** finishes → control returns to **Python backend** which returns `mcp_server_url` in the HTTP response → **React frontend** (`RouteWindowContext`) queries the MCP server's `tools/list` directly via fetch → finds the first tool with `_meta.ui.resourceUri` → dispatches `SET_MCP_TOOL` with tool name, resource URI, and server URL → **React** (`RouteWindow.jsx`) renders `<AppRenderer>` from `@mcp-ui/client` → **AppRenderer** calls `onReadResource` callback (fetches HTML from MCP server via JSON-RPC `resources/read`) → renders HTML inside a sandboxed iframe via `sandbox_proxy.html` → sets up AppBridge and postMessage protocol automatically.

## User Interaction

When the user clicks a button → **the App** (running inside iframe via `@modelcontextprotocol/ext-apps`) calls `app.callServerTool()` → **AppRenderer** routes via `onCallTool` callback → direct fetch to **MCP server** (JSON-RPC `tools/call`, no backend proxy) → **MCP server** runs the tool handler in-process → result flows back to **AppRenderer** → **the App** updates its UI.
