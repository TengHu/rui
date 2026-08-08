# MCP Server Architecture Patterns

## Overview

This document captures the core architectural patterns of the shared MCP server system, including server/session lifecycle management, meta-tool architecture for dynamic tool discovery, registry patterns, and event flow across the full stack.

---

## 1. MCP Server vs Session Lifecycle

### Server Lifecycle (Global, Single Node.js Process)

The MCP server runs as a single Node.js process that lives for the entire lifetime of the sandbox (potentially days/weeks). It's started once and provides a stable entry point for all agent connections.

**Key Points:**
- One process per sandbox
- Listens on port 3000 inside the e2b sandbox
- Survives individual agent connections
- Provides app registry persistence across runs

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:1-50`

```typescript
const PORT = parseInt(process.env.PORT || "3000", 10);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/home/user/workspace";

// Server starts once and runs indefinitely
async function startServer() {
  await loadRegistry();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Shared MCP Server listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
```

### Session Lifecycle (Ephemeral, Created Per Agent)

Each agent connection creates a lightweight session object that manages MCP protocol state for that specific connection. Sessions are short-lived (30-minute timeout) and are stored in a Map for quick lookup.

**Key Points:**
- Created fresh with every agent connection
- 30-minute inactivity timeout
- Lightweight wrapper around McpServer + transport
- Multiple sessions can coexist in the same process
- Sessions do NOT replicate the registry; they reference global maps

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:223-249`

```typescript
interface SessionState {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

const sessions = new Map<string, SessionState>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Clean up stale sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      try {
        session.transport.close();
      } catch {
        // Ignore close errors
      }
      sessions.delete(id);
      console.log(`Session ${id} timed out after inactivity`);
    }
  }
}, 60_000);
```

### Global Registries (Created on Module Load)

Three global registries are created when the server module loads. They persist for the lifetime of the process and are shared across all sessions.

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:171-173`

```typescript
const toolRegistry = new Map<string, ToolEntry>();
const resourceRegistry = new Map<string, ResourceEntry>();
const appRegistry = new Map<string, AppEntry>();
```

**Why this matters:**
- Every session created by the same process accesses the SAME registry objects
- No propagation needed when apps are registered: meta-tools automatically see new tools
- In-memory Maps provide O(1) lookup performance
- Disk persistence (.mcp-registry.json) allows crash recovery

---

## 2. Meta-Tool Architecture

### The Problem: Same-Turn Tool Access

**Challenge:** When an agent calls `mcp__app-server__app()`, it must immediately see all registered tools in the list returned by tools/list. If the tool list was built at session creation time (static), newly registered apps would be invisible until the next session.

**Solution:** Meta-tools that dispatch to runtime registries instead of static lists.

### Meta-Tools: app and list-apps

Two meta-tools are registered on every session at creation:
1. **app** - Dispatch to any registered tool by name
2. **list-apps** - Discover all registered apps and their tools

These meta-tools are always available and always reflect the current state of the global registries.

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:304-402`

#### The app Meta-Tool

```typescript
registerAppTool(
  server,
  "app",
  {
    title: "Invoke App",
    description:
      "Call any registered MCP app tool by name. After registering an app, " +
      "use this to render it or call its tools.",
    inputSchema: z.object({
      name: z.string().describe("The registered tool name to call"),
      arguments: z.record(z.unknown()).optional(),
    }),
  },
  async (args: { name: string; arguments?: Record<string, unknown> }) => {
    const targetName = args.name;
    const targetArgs = args.arguments || {};

    // Look up the target tool in the GLOBAL registry (runtime, not static)
    const toolEntry = toolRegistry.get(targetName);
    if (!toolEntry) {
      const available = Array.from(toolRegistry.keys())
        .filter((k) => k !== "app" && k !== "list-apps")
        .join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `Tool "${targetName}" not found. Available: ${available}`,
          },
        ],
        isError: true,
      };
    }

    // Emit start event
    writeEvent("mcp_tool_start", {
      name: targetName,
      appName: toolEntry.appName,
      input: targetArgs,
    });

    try {
      // Call rawHandler (no double event emission)
      const result = await toolEntry.rawHandler(targetArgs);

      // Emit result event
      writeEvent("mcp_tool_result", {
        name: targetName,
        appName: toolEntry.appName,
        output: result?.content?.[0]?.text || "",
        duration: Date.now() - startTime,
      });

      return result;
    } catch (err) {
      writeEvent("mcp_tool_result", {
        name: targetName,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
);
```

#### The list-apps Meta-Tool

```typescript
registerAppTool(
  server,
  "list-apps",
  {
    title: "List Registered Apps",
    description: "List all registered MCP apps and their tools.",
    inputSchema: z.object({}),
  },
  async () => {
    const apps: Record<string, unknown> = {};
    for (const [appName, entry] of appRegistry) {
      apps[appName] = {
        tools: entry.tools,
        resourceUri: entry.resourceUri,
        registeredAt: entry.registeredAt,
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(apps, null, 2) }],
    };
  },
);
```

### Handler Wrapping: rawHandler vs Wrapped Handler

Each tool entry stores TWO handler functions:

1. **rawHandler** - The original, unwrapped handler (no logging/events)
2. **handler** - Wrapped version (emits events + logging)

This separation prevents double event emission when meta-tools dispatch.

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:150-155`

```typescript
interface ToolEntry {
  appName: string;
  schema: Record<string, any>;
  handler: (args: any) => Promise<any>;     // wrapped: emits events + logging
  rawHandler: (args: any) => Promise<any>;  // unwrapped: no events
}
```

**Example from app registration:**

```typescript
// Wrap handler with logging + event emission
const originalHandler = mod.handler;
const wrappedHandler = async (args: any) => {
  const startTime = Date.now();

  writeEvent("mcp_tool_start", { /* ... */ });

  try {
    writeAppLog(name, "info", `Tool call: ${mod.tool.name}`, { /* ... */ });
    const result = await originalHandler(args);  // Call ORIGINAL here

    writeEvent("mcp_tool_result", { /* ... */ });
    return result;
  } catch (err) {
    // ...
  }
};

toolRegistry.set(mod.tool.name, {
  appName: name,
  schema: toolSchema,
  handler: wrappedHandler,      // Register wrapped
  rawHandler: originalHandler,   // Store raw for meta-tool dispatch
});
```

When the meta-tool dispatches, it calls `rawHandler`:

```typescript
// In meta-tool dispatch
const toolEntry = toolRegistry.get(targetName);
const result = await toolEntry.rawHandler(targetArgs);  // Call RAW handler
```

This ensures events are only emitted once (by the meta-tool itself), not by the inner handler.

### Why Propagation Was Removed

**Old Approach (Removed):** After registering an app, iterate all sessions and call `registerTool()` to add the tool to each session's McpServer.

**Problems:**
- O(n) complexity (n = number of sessions)
- Requires session list iteration
- Complex synchronization logic
- Brittle across process boundaries

**New Approach (Current):** Meta-tools dispatch to global registries at runtime.

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:579-584`

```typescript
// No propagation needed! Meta-tools handle everything via global registry lookup.
// Agents call: mcp__app-server__app({ name: "app-name" })
// Meta-tool dispatches to toolRegistry at runtime → works immediately!
```

**Benefits:**
- O(1) lookup complexity
- No session iteration needed
- Automatic discovery for all active sessions
- Simpler code, fewer edge cases

---

## 3. Registry Architecture

### In-Memory Maps for O(1) Lookup

All registries use JavaScript Map objects for fast runtime lookup.

```typescript
const toolRegistry = new Map<string, ToolEntry>();
const resourceRegistry = new Map<string, ResourceEntry>();
const appRegistry = new Map<string, AppEntry>();
```

**Access Pattern:**
```typescript
// Fast O(1) lookup when dispatching meta-tools
const toolEntry = toolRegistry.get(targetName);
const apps = appRegistry.entries(); // Iterate when needed
```

### Disk Persistence for Crash Recovery

Apps are persisted to `.mcp-registry.json` to survive server restarts.

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:184-220`

```typescript
const REGISTRY_FILE = path.join(WORKSPACE_DIR, ".mcp-registry.json");

interface PersistedApp {
  name: string;
  appDir: string;
}

async function saveRegistry(): Promise<void> {
  const apps: PersistedApp[] = [];
  for (const [name, entry] of appRegistry) {
    apps.push({ name, appDir: entry.appDir });
  }
  try {
    await fs.writeFile(REGISTRY_FILE, JSON.stringify(apps, null, 2));
    console.log(`Saved ${apps.length} app(s) to registry file`);
  } catch (err) {
    console.error("Failed to save registry:", err);
  }
}

async function loadRegistry(): Promise<void> {
  try {
    const data = await fs.readFile(REGISTRY_FILE, "utf-8");
    const apps: PersistedApp[] = JSON.parse(data);

    for (const { name, appDir } of apps) {
      try {
        await fs.access(appDir);
        await registerApp(name, appDir);
        console.log(`  Restored app: ${name}`);
      } catch {
        console.log(`  Skipping ${name}: directory ${appDir} not found`);
      }
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log("No registry file found, starting fresh");
    } else {
      console.error("Failed to load registry:", err);
    }
  }
}
```

### All Sessions Share the Same Memory

Because registries are global (not per-session), all sessions in the same process automatically access the same tools and resources. No synchronization needed.

```typescript
// Session A looks up tool X
const toolEntry1 = toolRegistry.get("tool-x");

// Session B looks up the same tool
const toolEntry2 = toolRegistry.get("tool-x");

// These are IDENTICAL because they reference the same Map
console.assert(toolEntry1 === toolEntry2);
```

---

## 4. Event Flow: Frontend to Backend to MCP

### Frontend: Meta-Tool Wrapper Extraction

When the frontend streams tool input during the agent's work, it extracts the actual tool name from the meta-tool wrapper.

**Code Location:** `chatbot_web/frontend/src/components/RouteWindow/RouteWindow.jsx:51-79`

```jsx
// Streaming tool input: derive partial state from events
const latestToolInputPartial = useMemo(() => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'tool_input_partial' && event.partialJson) {
      try {
        const parsed = JSON.parse(event.partialJson);
        // Meta-tool wrapper: extract inner arguments
        if (parsed && typeof parsed === 'object' && 'name' in parsed && 'arguments' in parsed) {
          return { arguments: parsed.arguments };
        }
        // Direct tool call (not through meta-tool)
        return { arguments: parsed };
      } catch {
        // Partial JSON not yet complete — try extracting inner arguments
        try {
          const argMatch = event.partialJson.match(/"arguments"\s*:\s*(\{[\s\S]*)/);
          if (argMatch) {
            const innerParsed = JSON.parse(argMatch[1]);
            return { arguments: innerParsed };
          }
        } catch {
          // Inner JSON also incomplete — that's fine during streaming
        }
        return undefined;
      }
    }
  }
  return undefined;
}, [events]);
```

**Why this matters:**
- The agent calls `mcp__app-server__app({ name: "target-tool", arguments: {...} })`
- Frontend needs to show the INPUT for "target-tool", not for the meta-tool
- Extraction logic handles both complete and partial JSON during streaming

### Backend: FilePoller Tool Name Extraction

The Python FilePoller extracts the actual tool name from meta-tool wrappers for event enrichment and frontend routing.

**Code Location:** `chatbot_web/services/file_poller.py:200-227`

```python
if event_type == "input_json_delta":
    tool_name = data.get("tool_name", "")
    if tool_name.startswith(MCP_TOOL_PREFIX):
        short_name = tool_name[len(MCP_TOOL_PREFIX):]
        partial_json = data.get("partial_json", "")

        # If this is the meta-tool ("app"), try to extract the actual
        # target tool name from the partial JSON for frontend routing
        actual_tool_name = short_name
        is_proxy = short_name == "app"
        if is_proxy:
            try:
                parsed = json.loads(partial_json)
                if isinstance(parsed, dict) and "name" in parsed:
                    actual_tool_name = parsed["name"]
            except (json.JSONDecodeError, TypeError):
                pass  # Partial JSON not yet complete — use "app" as fallback

        return {
            **event,
            "type": "tool_input_partial",
            "data": {
                "tool_name": actual_tool_name,
                "tool_use_id": data.get("tool_use_id"),
                "partial_json": partial_json,
                "is_proxy": is_proxy,
            },
        }
```

**Key insights:**
- `MCP_TOOL_PREFIX = "mcp__app-server__"`
- Short name extraction: `short_name = "app"` if calling meta-tool
- Actual tool name extracted from partial JSON: `parsed["name"]`
- `is_proxy` flag helps frontend understand the dispatch chain

### MCP Server: Event Emission

The MCP server emits events at three key points:

1. **Tool Start** - When meta-tool dispatch begins
2. **Tool Result** - After handler completes successfully
3. **Tool Error** - If handler throws

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:344-377`

```typescript
// Emit start event
writeEvent("mcp_tool_start", {
  name: targetName,
  appName: toolEntry.appName,
  input: targetArgs,
  resourceUri,
});

const startTime = Date.now();

try {
  // Call rawHandler to avoid double event emission
  const result = await toolEntry.rawHandler(targetArgs);
  const duration = Date.now() - startTime;

  // Emit result event with UI metadata for frontend rendering
  writeEvent("mcp_tool_result", {
    name: targetName,
    appName: toolEntry.appName,
    output: result?.content?.[0]?.text || "",
    ui: resourceUri ? { resourceUri } : null,
    duration,
  });

  return result;
} catch (err) {
  const duration = Date.now() - startTime;
  writeEvent("mcp_tool_result", {
    name: targetName,
    appName: toolEntry.appName,
    error: err instanceof Error ? err.message : String(err),
    duration,
  });
  throw err;
}
```

### Full Event Flow Diagram

```
Agent writes to events file in sandbox:
  event: { type: "input_json_delta", data: { tool_name: "mcp__app-server__app", partial_json: "{\"name\": \"my-tool\", ..." } }
          ↓
FilePoller (file_poller.py) reads and enriches:
  event: { type: "tool_input_partial", data: { tool_name: "my-tool", is_proxy: true, ... } }
          ↓
Frontend (RouteWindow.jsx) receives enriched event:
  Extracts arguments from partial JSON
  Shows input UI for "my-tool" (not "app")
          ↓
MCP Server (server.ts) dispatches:
  meta-tool handler looks up toolRegistry.get("my-tool")
  Calls rawHandler (no double events)
          ↓
MCP Server emits completion:
  event: { type: "mcp_tool_result", data: { name: "my-tool", output: "...", ui: { resourceUri: "..." } } }
          ↓
FilePoller forwards to frontend
Frontend renders AppRenderer with preloaded HTML
```

---

## 5. Session Creation: Building the McpServer

Every session gets a fresh McpServer with all current tools and resources from the registries.

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:269-405`

```typescript
function createSessionServer(): McpServer {
  const server = new McpServer(
    { name: "Shared MCP Server", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  // Register all current tools (snapshot at session creation time)
  for (const [toolName, entry] of toolRegistry) {
    const { schema, handler } = entry;
    registerAppTool(
      server,
      toolName,
      { /* schema */ },
      handler,  // Use wrapped handler (with events)
    );
  }

  // Register all current resources
  for (const [uri, entry] of resourceRegistry) {
    registerAppResource(
      server,
      uri,
      uri,
      { mimeType: RESOURCE_MIME_TYPE },
      async () => ({
        contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: entry.html }],
      }),
    );
  }

  // Register meta-tools (always dynamically dispatch)
  registerAppTool(server, "app", { /* ... */ }, async (args) => {
    const toolEntry = toolRegistry.get(args.name);  // Runtime lookup!
    // ...
  });

  registerAppTool(server, "list-apps", { /* ... */ }, async () => {
    const apps = {}; // Iterate appRegistry at runtime
    // ...
  });

  return server;
}
```

**Key insight:** The session server is a snapshot of tools at creation time (for MCP protocol), but meta-tools always dispatch to the current global registries (for dynamic discovery).

---

## 6. App Registration: Adding Tools to Global Registries

When an app is registered via POST /register, it's added to all three global registries.

**Code Location:** `chatbot_web/assets/mcp-server/server.ts:411-598`

```typescript
async function registerApp(name: string, appDir: string): Promise<AppEntry> {
  // Unregister existing app with same name first
  if (appRegistry.has(name)) {
    unregisterApp(name);
  }

  const toolNames: string[] = [];
  let resourceUri: string | null = null;

  // 1. Read the bundled HTML from disk
  const htmlPath = path.join(appDir, "dist", "mcp-app.html");
  try {
    const html = await fs.readFile(htmlPath, "utf-8");
    resourceUri = `ui://${name}/mcp-app.html`;
    resourceRegistry.set(resourceUri, { appName: name, uri: resourceUri, html });
  } catch {
    // No HTML found (tool-only app)
  }

  // 2. Register a view tool if app has UI
  if (resourceUri) {
    const rawViewHandler = async () => ({
      content: [{ type: "text" as const, text: `Displaying ${name}` }],
    });

    toolRegistry.set(name, {
      appName: name,
      schema: { /* ... */, _meta: { ui: { resourceUri } } },
      rawHandler: rawViewHandler,
      handler: async () => {
        writeEvent("mcp_tool_start", { /* ... */ });
        const result = await rawViewHandler();
        writeEvent("mcp_tool_result", { /* ... */ });
        return result;
      },
    });
    toolNames.push(name);
  }

  // 3. Import tool handler modules from tools/ directory
  const toolsDir = path.join(appDir, "tools");
  const files = await fs.readdir(toolsDir);

  for (const file of files) {
    const mod = await import(`${modulePath}?t=${Date.now()}`);

    const originalHandler = mod.handler;
    const wrappedHandler = async (args: any) => {
      writeEvent("mcp_tool_start", { /* ... */ });
      try {
        const result = await originalHandler(args);
        writeEvent("mcp_tool_result", { /* ... */ });
        return result;
      } catch (err) {
        writeEvent("mcp_tool_result", { error: /* ... */ });
        throw err;
      }
    };

    toolRegistry.set(mod.tool.name, {
      appName: name,
      schema: toolSchema,
      handler: wrappedHandler,
      rawHandler: originalHandler,
    });
    toolNames.push(mod.tool.name);
  }

  const entry: AppEntry = {
    name,
    appDir,
    registeredAt: new Date().toISOString(),
    tools: toolNames,
    resourceUri,
  };

  appRegistry.set(name, entry);

  // Persist to disk so apps survive server restarts
  await saveRegistry();

  // No propagation needed! Meta-tools handle everything via global registry lookup.
  // Agents call: mcp__app-server__app({ name: "app-name" })
  // Meta-tool dispatches to toolRegistry at runtime → works immediately!

  // Emit discovery event for frontend preloading
  writeEvent("mcp_tools_discovered", {
    tools: Object.fromEntries(
      [...toolRegistry.entries()]
        .filter(([, t]) => t.schema._meta?.ui?.resourceUri)
        .map(([tName, t]) => [tName, {
          resourceUri: t.schema._meta.ui.resourceUri,
          inputSchema: t.schema.inputSchema,
        }])
    ),
  });

  return entry;
}
```

---

## 7. Stateless vs Stateful Endpoints

### Stateful: POST /mcp (Session-Based)

Used by Claude Code agents that maintain persistent connections and MCP state.

```typescript
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    // Reuse existing session
    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — create McpServer + transport
  const server = createSessionServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: false,
    onsessioninitialized: (id: string) => {
      sessions.set(id, { server, transport, lastActivity: Date.now() });
    },
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

### Stateless: POST /mcp-rpc (Request/Response)

Used by the frontend for one-shot tool calls without session overhead.

```typescript
app.post("/mcp-rpc", async (req, res) => {
  // Create throwaway server per request
  const server = createSessionServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,  // Stateless
    enableJsonResponse: true,       // JSON response
  });

  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

---

## 8. Code Location Reference

### Core Patterns

| Pattern | File | Lines |
|---------|------|-------|
| Global Registries (toolRegistry, appRegistry, resourceRegistry) | server.ts | 171-173 |
| Session Lifecycle & Timeout | server.ts | 223-249 |
| Meta-Tool "app" Registration | server.ts | 306-379 |
| Meta-Tool "list-apps" Registration | server.ts | 381-402 |
| Handler Wrapping (rawHandler vs handler) | server.ts | 150-155 |
| Removed Propagation Code | server.ts | 579-584 |
| Frontend Meta-Tool Wrapper Extraction | RouteWindow.jsx | 51-76 |
| Backend Tool Name Extraction | file_poller.py | 200-227 |
| App Registration Flow | server.ts | 411-598 |
| Registry Persistence (Save/Load) | server.ts | 184-220 |

---

## 9. Key Design Decisions

### 1. Global Registries Over Session-Local State
**Why:** Eliminates O(n) propagation complexity. All sessions automatically see new tools without explicit synchronization.

### 2. Meta-Tools Over Static Tool Lists
**Why:** Enables same-turn tool discovery. Newly registered apps appear in list-apps immediately without waiting for new sessions.

### 3. Handler Wrapping (rawHandler/handler Separation)
**Why:** Prevents double event emission. Wrapped handlers are called directly; raw handlers are called by meta-tools.

### 4. Disk Persistence for Registries
**Why:** Allows graceful server restarts. Apps survive crashes and are automatically restored on startup.

### 5. Stateless /mcp-rpc Endpoint
**Why:** Simplifies frontend direct calls. No session overhead for one-shot resource reads and tool calls from iframes.

### 6. No Propagation After Registration
**Why:** Meta-tool dispatch is O(1) and requires no session list iteration. Simpler code, faster performance, fewer edge cases.

---

## 10. Future Considerations

### Scaling Patterns
- **Session Clustering:** Multiple server processes behind a load balancer would require distributed registries (Redis, shared filesystem)
- **Registry Sharding:** Large numbers of apps could use content-addressed registry splits
- **Session Persistence:** Could serialize session state to disk for recovery across process restarts

### Security Patterns
- **Tool Isolation:** Sandboxed execution contexts per tool to prevent malicious tool code from accessing other tools
- **Registry ACLs:** Permission model for which agents can register/unregister apps
- **Event Filtering:** Fine-grained event access control based on agent credentials

### Performance Optimizations
- **Lazy Tool Loading:** Don't load all tools into memory on session creation
- **Registry Caching:** Use ETags/versioning to cache tool definitions in sessions
- **Batch Registration:** Support registering multiple apps in a single request

---

## Summary

This architecture solves the dynamic tool discovery problem elegantly:

1. **Global registries** provide shared state across all sessions in a process
2. **Meta-tools** dispatch to registries at runtime, enabling same-turn discovery
3. **Handler wrapping** prevents event duplication while maintaining observability
4. **Disk persistence** ensures crash recovery without manual intervention
5. **No propagation** means O(1) registration complexity instead of O(n)

The result is a scalable, maintainable system for dynamically managing MCP apps within a shared server.
