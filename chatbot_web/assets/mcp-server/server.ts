/**
 * Shared MCP Server - runs on port 3000 inside the e2b sandbox.
 *
 * Meta-Tool Architecture:
 * - Two meta-tools (app, list-apps) are registered on every session at creation
 * - Meta-tools dispatch to global registries (toolRegistry, appRegistry) at runtime
 * - Apps registered via POST /register are added to global registries only
 * - No session propagation needed - meta-tools handle dynamic discovery!
 *
 * Apps don't run their own servers; instead they:
 *   1. Create files on disk (tool handlers + UI code)
 *   2. Build the UI with Vite (produces a single HTML file)
 *   3. Call POST /register to load into this server
 *   4. Agent calls: mcp__app-server__app({ name: "app-name" }) to render
 *
 * Endpoints:
 *   POST   /mcp             - MCP protocol: create or reuse session (by Mcp-Session-Id header)
 *   GET    /mcp             - SSE notification stream (forward-compatible)
 *   DELETE /mcp             - Terminate a session
 *   POST   /register        - Load an app: {name, appDir} -> add to global registries
 *   POST   /unregister      - Remove an app's tools and resources
 *   POST   /set-events-file - Set events file path for frontend streaming
 *   GET    /health          - Status check + list of registered apps
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

const PORT = parseInt(process.env.PORT || "3000", 10);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/home/user/workspace";
const SERVER_LOG_FILE = "/tmp/mcp-server.log";

// ---------------------------------------------------------------------------
// Server-level logging to /tmp/mcp-server.log (agent can read this)
// ---------------------------------------------------------------------------

// Store original console methods before overriding (needed for writeServerLog fallback)
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

async function writeServerLog(level: string, message: string, extra?: Record<string, unknown>): Promise<void> {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...extra,
  };
  try {
    await fs.appendFile(SERVER_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Use original console.error to avoid infinite recursion
    originalConsoleError("Failed to write server log:", entry);
  }
}

// Override console methods to also write to log file
console.log = (...args: any[]) => {
  originalConsoleLog(...args);
  writeServerLog("INFO", args.map(String).join(" "));
};

console.error = (...args: any[]) => {
  originalConsoleError(...args);
  writeServerLog("ERROR", args.map(String).join(" "));
};

console.warn = (...args: any[]) => {
  originalConsoleWarn(...args);
  writeServerLog("WARN", args.map(String).join(" "));
};

// Persistence file for app registrations (survives server restarts)
const REGISTRY_FILE = path.join(WORKSPACE_DIR, ".mcp-registry.json");

// ---------------------------------------------------------------------------
// Per-app logging utility
// ---------------------------------------------------------------------------

type LogLevel = "debug" | "info" | "warn" | "error";

async function writeAppLog(
  appName: string,
  level: LogLevel,
  data: unknown,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    // Use /tmp for app logs to avoid permission issues in workspace
    const appLogsDir = path.join("/tmp", "mcp-apps", appName, ".logs");
    const logFile = path.join(appLogsDir, "runtime.jsonl");

    // Ensure .logs directory exists
    await fs.mkdir(appLogsDir, { recursive: true });

    const entry = {
      ts: new Date().toISOString(),
      level,
      source: "mcp-server",
      data,
      ...extra,
    };

    await fs.appendFile(logFile, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Don't let logging errors break the app
    console.error(`Failed to write app log for ${appName}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Shared events file – the agent & this server both append to the same .jsonl
// ---------------------------------------------------------------------------

let eventsFilePath: string | null = null;
let eventSeqCounter = 100000; // High offset to avoid collisions with agent's seq

function writeEvent(type: string, data: Record<string, unknown>): void {
  if (!eventsFilePath) return;
  try {
    const event = {
      seq: eventSeqCounter++,
      ts: Date.now() / 1000,
      type,
      data,
      source: "mcp-server",
    };
    appendFileSync(eventsFilePath, JSON.stringify(event) + "\n");
  } catch (err) {
    console.error("Failed to write event:", err);
  }
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

interface ToolEntry {
  appName: string;
  schema: Record<string, any> & { zodSchema?: z.ZodType };
  handler: (args: any) => Promise<any>;     // wrapped: emits events + logging
  rawHandler: (args: any) => Promise<any>;  // unwrapped: no events (for meta-tool dispatch)
}

interface ResourceEntry {
  appName: string;
  uri: string;
  html: string;
}

interface AppEntry {
  name: string;
  appDir: string;
  registeredAt: string;
  tools: string[];
  resourceUri: string | null;
}

const toolRegistry = new Map<string, ToolEntry>();
const resourceRegistry = new Map<string, ResourceEntry>();
const appRegistry = new Map<string, AppEntry>();

// ---------------------------------------------------------------------------
// Protocol health tracking
// ---------------------------------------------------------------------------

let lastToolsListError: string | null = null;
let toolsListHealthy = true;
const serverStartTime = Date.now();

// ---------------------------------------------------------------------------
// Persistence: Save/load app registrations to survive server restarts
// ---------------------------------------------------------------------------

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
    console.log(`Loading ${apps.length} app(s) from registry file...`);

    for (const { name, appDir } of apps) {
      try {
        // Check if app directory still exists
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

// ---------------------------------------------------------------------------
// Session management for persistent MCP connections
// ---------------------------------------------------------------------------

interface SessionState {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

const sessions = new Map<string, SessionState>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Periodically clean up stale sessions to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      try {
        session.transport.close();
      } catch {
        // Ignore close errors on stale sessions
      }
      sessions.delete(id);
      console.log(`Session ${id} timed out after inactivity`);
    }
  }
}, 60_000);

/**
 * Resolve a Zod schema from a tool entry's schema definition.
 */
function resolveZodSchema(schema: Record<string, any>): z.ZodType {
  if (schema.zodSchema) {
    return schema.zodSchema;
  }
  if (schema.inputSchema) {
    return z.object({}).passthrough();
  }
  return z.object({});
}

/**
 * Sanitize tool schema to prevent MCP SDK crashes during serialization.
 * Ensures all required fields are present and properly typed.
 */
function sanitizeToolSchema(
  toolName: string,
  schema: Record<string, any>
): Record<string, any> {
  // Ensure _meta is always an object (prevents SDK crashes during tools/list serialization)
  const sanitized = {
    ...schema,
    _meta: schema._meta && typeof schema._meta === "object" ? schema._meta : {},
  };

  // Ensure title and description are strings
  if (typeof sanitized.title !== "string") {
    sanitized.title = toolName;
  }
  if (typeof sanitized.description !== "string") {
    sanitized.description = `Tool: ${toolName}`;
  }

  return sanitized;
}

/**
 * Create a McpServer populated with all current tools and resources.
 * Each session gets its own McpServer instance so registerTool() can
 * send list_changed notifications independently.
 */
function createSessionServer(): McpServer {
  const server = new McpServer(
    { name: "Shared MCP Server", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  // Register all current tools with defensive error handling
  for (const [toolName, entry] of toolRegistry) {
    const { schema, handler } = entry;
    try {
      const sanitizedSchema = sanitizeToolSchema(toolName, schema);
      registerAppTool(
        server,
        toolName,
        {
          title: sanitizedSchema.title,
          description: sanitizedSchema.description,
          inputSchema: resolveZodSchema(sanitizedSchema),
          _meta: sanitizedSchema._meta,
        },
        handler,
      );
    } catch (err) {
      // Log the error but do not crash the entire session
      console.error(`Failed to register tool "${toolName}" on session:`, err);
      toolsListHealthy = false;
      lastToolsListError = `Tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`;
    }
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

  // ── Meta-tools: always available, dispatch to dynamic registry ──

  registerAppTool(
    server,
    "app",
    {
      title: "Invoke App",
      description:
        "Call any registered MCP app tool by name. After registering an app, " +
        "use this to render it or call its tools. Call list-apps first to see what's available.",
      inputSchema: z.object({
        name: z.string().describe("The registered tool name to call (e.g. 'my-app' or 'add-todo')"),
        arguments: z.record(z.unknown()).optional().describe("Arguments to pass to the tool handler"),
      }),
      _meta: {}, // Prevent SDK crashes when listing tools
    },
    async (args: { name: string; arguments?: Record<string, unknown> }) => {
      const targetName = args.name;
      const targetArgs = args.arguments || {};

      // Add prefix to lookup dynamically registered app tools
      const prefixedName = `mcp__app-server__${targetName}`;

      // Look up the target tool in the global registry
      const toolEntry = toolRegistry.get(prefixedName);
      if (!toolEntry) {
        const available = Array.from(toolRegistry.keys())
          .filter((k) => k !== "app" && k !== "list-apps")
          .map((k) => k.replace(/^mcp__app-server__/, "")) // Show without prefix for clarity
          .join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool "${targetName}" not found. Available: ${available || "(none registered)"}`,
            },
          ],
          isError: true,
        };
      }

      // Resolve UI metadata from the target tool's schema
      const resourceUri = toolEntry.schema._meta?.ui?.resourceUri || null;

      // Emit start event (use prefixed name for backend detection)
      writeEvent("mcp_tool_start", {
        name: prefixedName,
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
          name: prefixedName,
          appName: toolEntry.appName,
          output: result?.content?.[0]?.text || "",
          ui: resourceUri ? { resourceUri } : null,
          duration,
        });

        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        writeEvent("mcp_tool_result", {
          name: prefixedName,
          appName: toolEntry.appName,
          error: err instanceof Error ? err.message : String(err),
          duration,
        });
        throw err;
      }
    },
  );

  registerAppTool(
    server,
    "list-apps",
    {
      title: "List Registered Apps",
      description: "List all registered MCP apps and their tools. Use to discover what apps are available.",
      inputSchema: z.object({}),
      _meta: {}, // Prevent SDK crashes when listing tools
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

  return server;
}

// ---------------------------------------------------------------------------
// App registration
// ---------------------------------------------------------------------------

async function registerApp(name: string, appDir: string): Promise<AppEntry> {
  // Unregister existing app with same name first
  if (appRegistry.has(name)) {
    unregisterApp(name);
  }

  const toolNames: string[] = [];
  let resourceUri: string | null = null;

  // 1. Read the bundled HTML from disk (if it exists)
  const htmlPath = path.join(appDir, "dist", "mcp-app.html");
  try {
    const html = await fs.readFile(htmlPath, "utf-8");
    resourceUri = `ui://${name}/mcp-app.html`;
    resourceRegistry.set(resourceUri, { appName: name, uri: resourceUri, html });
    console.log(`  Registered resource: ${resourceUri}`);
  } catch {
    console.log(`  No bundled HTML found at ${htmlPath}, skipping resource`);
  }

  // 2. ALWAYS register a view tool if app has UI (ensures UI-only apps can be invoked)
  if (resourceUri) {
    const viewToolName = `mcp__app-server__${name}`; // Prefix for namespacing (e.g., "mcp__app-server__hello-world")

    // Raw handler: just returns the result, no event emission
    const rawViewHandler = async () => ({
      content: [{ type: "text" as const, text: `Displaying ${name}` }],
    });

    toolRegistry.set(viewToolName, {
      appName: name,
      schema: {
        name: viewToolName,
        title: `View ${name}`,
        description: `Display the ${name} app`,
        // Use Zod schema instead of JSON Schema for MCP SDK compatibility
        zodSchema: z.object({}),
        inputSchema: { type: "object", properties: {} }, // Keep for reference/serialization
        _meta: { ui: { resourceUri } },
      },
      rawHandler: rawViewHandler,
      handler: async () => {
        writeEvent("mcp_tool_start", { name: viewToolName, appName: name, input: {}, resourceUri });
        const result = await rawViewHandler();
        writeEvent("mcp_tool_result", {
          name: viewToolName, appName: name,
          output: result.content[0].text,
          ui: { resourceUri },
        });
        return result;
      },
    });
    toolNames.push(viewToolName);
    console.log(`  Registered view tool: ${viewToolName}`);
  }

  // 3. Import tool handler modules from the tools/ directory
  const toolsDir = path.join(appDir, "tools");
  try {
    const files = await fs.readdir(toolsDir);
    const tsFiles = files.filter(
      (f) => f.endsWith(".ts") || f.endsWith(".js"),
    );

    for (const file of tsFiles) {
      const modulePath = path.join(toolsDir, file);
      try {
        // Dynamic import with cache-busting for hot reload
        const mod = await import(`${modulePath}?t=${Date.now()}`);

        if (!mod.tool || !mod.handler) {
          console.warn(`  Skipping ${file}: missing 'tool' or 'handler' export`);
          continue;
        }

        const toolSchema = { ...mod.tool };

        // Attach UI metadata if we have a resource
        if (resourceUri) {
          toolSchema._meta = {
            ...(toolSchema._meta || {}),
            ui: { resourceUri },
          };
        }

        // Wrap handler with logging + event emission
        const originalHandler = mod.handler;
        const wrappedHandler = async (args: any) => {
          const startTime = Date.now();
          const toolMeta = toolSchema._meta?.ui || {};

          writeEvent("mcp_tool_start", {
            name: mod.tool.name,
            appName: name,
            input: args,
            resourceUri: toolMeta.resourceUri || null,
          });

          try {
            writeAppLog(name, "info", `Tool call: ${mod.tool.name}`, { tool: mod.tool.name, args });
            const result = await originalHandler(args);
            const duration = Date.now() - startTime;
            writeAppLog(name, "info", `Tool result: ${mod.tool.name}`, { tool: mod.tool.name, duration, success: true });

            writeEvent("mcp_tool_result", {
              name: mod.tool.name,
              appName: name,
              output: result?.content?.[0]?.text || "",
              ui: toolMeta.resourceUri ? { resourceUri: toolMeta.resourceUri } : null,
              duration,
            });

            return result;
          } catch (err) {
            const duration = Date.now() - startTime;
            writeAppLog(name, "error", `Tool error: ${mod.tool.name}`, {
              tool: mod.tool.name,
              duration,
              error: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            });

            writeEvent("mcp_tool_result", {
              name: mod.tool.name,
              appName: name,
              error: err instanceof Error ? err.message : String(err),
              duration,
            });

            throw err;
          }
        };

        const prefixedToolName = `mcp__app-server__${mod.tool.name}`;
        toolRegistry.set(prefixedToolName, {
          appName: name,
          schema: toolSchema,
          handler: wrappedHandler,
          rawHandler: originalHandler,  // originalHandler is already defined above
        });

        toolNames.push(prefixedToolName);
        console.log(`  Registered tool: ${prefixedToolName}`);
      } catch (err) {
        console.error(`  Failed to import ${file}:`, err);
      }
    }
  } catch {
    console.log(`  No tools directory found at ${toolsDir}`);
  }

  const entry: AppEntry = {
    name,
    appDir,
    registeredAt: new Date().toISOString(),
    tools: toolNames,
    resourceUri,
  };

  appRegistry.set(name, entry);
  console.log(`Registered app "${name}" with ${toolNames.length} tool(s)`);

  // Log registration to app's log file
  writeAppLog(name, "info", `App registered with ${toolNames.length} tool(s)`, {
    tools: toolNames,
    resourceUri,
  });

  // Persist to disk so apps survive server restarts
  await saveRegistry();

  // No propagation needed! Meta-tools handle everything via global registry lookup.
  // Agents call: mcp__app-server__app({ name: "app-name" })
  // Meta-tool dispatches to toolRegistry at runtime → works immediately!

  // Emit discovery event so frontend can preload UI before tool calls arrive
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

function unregisterApp(name: string): boolean {
  const entry = appRegistry.get(name);
  if (!entry) return false;

  // Remove tools
  for (const toolName of entry.tools) {
    toolRegistry.delete(toolName);
  }

  // Remove resource
  if (entry.resourceUri) {
    resourceRegistry.delete(entry.resourceUri);
  }

  appRegistry.delete(name);
  console.log(`Unregistered app "${name}"`);

  // Persist to disk
  saveRegistry().catch(() => {});

  return true;
}

// ---------------------------------------------------------------------------
// Express HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// MCP protocol endpoint — persistent sessions
// POST /mcp: handle JSON-RPC messages (create or reuse session by Mcp-Session-Id)
app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Reuse existing session and refresh activity timestamp
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — create McpServer + transport
    const server = createSessionServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: false, // Must be false for SSE notifications
      onsessioninitialized: (id: string) => {
        sessions.set(id, { server, transport, lastActivity: Date.now() });
        console.log(`Session created: ${id}`);
      },
    });

    // Don't close transport on individual request end — it's persistent
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: String(err) },
      id: req.body?.id ?? null,
    });
  }
});

// GET /mcp — SSE notification stream (forward-compatible with list_changed)
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  try {
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res);
  } catch (err) {
    console.error("SSE stream error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: String(err) });
    }
  }
});

// DELETE /mcp — terminate a session
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  try {
    await session.transport.handleRequest(req, res);
  } catch (err) {
    console.error("Session termination error:", err);
  }
  sessions.delete(sessionId);
  console.log(`Session terminated: ${sessionId}`);
});

// Stateless MCP RPC endpoint — for frontend/backend one-shot calls (tools/call, resources/read, tools/list)
// Unlike POST /mcp (session-based for Claude Code), this creates a throwaway server per request
// so callers don't need to manage initialize handshakes or session IDs.
app.post("/mcp-rpc", async (req, res) => {
  try {
    const server = createSessionServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless — no session management
      enableJsonResponse: true,      // JSON response for simple request/response
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP-RPC request error:", err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: String(err) },
      id: req.body?.id ?? null,
    });
  }
});

// Register an app
app.post("/register", async (req, res) => {
  const { name, appDir } = req.body;

  if (!name || !appDir) {
    return res.status(400).json({ error: "name and appDir are required" });
  }

  try {
    const entry = await registerApp(name, appDir);
    res.json({ success: true, app: entry });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// Unregister an app
app.post("/unregister", (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const removed = unregisterApp(name);
  res.json({ success: removed, removed: name });
});

// Set events file path (called by backend before each agent run)
app.post("/set-events-file", (req, res) => {
  const { eventsFile } = req.body;
  if (!eventsFile) {
    return res.status(400).json({ error: "eventsFile is required" });
  }
  eventsFilePath = eventsFile;
  console.log(`Events file set to: ${eventsFile}`);
  res.json({ success: true, eventsFile });
});

// Health check
app.get("/health", (_req, res) => {
  const apps: Record<string, any> = {};
  for (const [name, entry] of appRegistry) {
    apps[name] = {
      tools: entry.tools,
      resourceUri: entry.resourceUri,
      registeredAt: entry.registeredAt,
    };
  }

  res.json({
    status: "ok",
    port: PORT,
    uptime_ms: Date.now() - serverStartTime,
    protocol: {
      tools_list_healthy: toolsListHealthy,
      session_count: sessions.size,
      last_tools_list_error: lastToolsListError,
    },
    registeredApps: Object.keys(apps).length,
    apps,
    tools: Array.from(toolRegistry.keys()),
    resources: Array.from(resourceRegistry.keys()),
  });
});

// ---------------------------------------------------------------------------
// Crash logging — capture all uncaught errors before the process exits
// ---------------------------------------------------------------------------

const CRASH_LOG_FILE = "/tmp/mcp-server-crash.log";

function writeCrashLog(reason: string, error: unknown): void {
  const entry = {
    ts: new Date().toISOString(),
    reason,
    error: error instanceof Error
      ? { message: error.message, stack: error.stack, name: error.name }
      : String(error),
    uptime_ms: Date.now() - serverStartTime,
    pid: process.pid,
    memory: process.memoryUsage(),
  };
  try {
    appendFileSync(CRASH_LOG_FILE, JSON.stringify(entry) + "\n");
    appendFileSync(SERVER_LOG_FILE, JSON.stringify({ ...entry, level: "FATAL" }) + "\n");
  } catch {
    // Last resort — stderr
    originalConsoleError("CRASH LOG WRITE FAILED:", entry);
  }
}

process.on("uncaughtException", (err, origin) => {
  writeCrashLog(`uncaughtException (${origin})`, err);
  originalConsoleError("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  writeCrashLog("unhandledRejection", reason);
  originalConsoleError("UNHANDLED REJECTION:", reason);
  process.exit(1);
});

process.on("SIGTERM", () => {
  writeCrashLog("SIGTERM", "Process terminated by signal");
  process.exit(0);
});

process.on("SIGINT", () => {
  writeCrashLog("SIGINT", "Process interrupted");
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Start server with registry restoration
// ---------------------------------------------------------------------------

async function startServer() {
  // Append to log file (don't clear — preserves history across auto-restarts)
  try {
    await writeServerLog("INFO", "MCP Server starting", {
      port: PORT,
      workspace: WORKSPACE_DIR,
      pid: process.pid,
      node_version: process.version,
    });
  } catch {
    // Ignore if we can't write to /tmp
  }

  // Load previously registered apps from disk
  await loadRegistry();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Shared MCP Server listening on port ${PORT}`);
    console.log(`Registry file: ${REGISTRY_FILE}`);
    console.log(`Server log file: ${SERVER_LOG_FILE}`);
    console.log(`Crash log file: ${CRASH_LOG_FILE}`);
  });
}

startServer().catch((err) => {
  writeCrashLog("startServer failed", err);
  originalConsoleError("Failed to start server:", err);
  process.exit(1);
});
