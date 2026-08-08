# Debug MCP App

Use this skill when:
- The user asks "why isn't this working?"
- An MCP app fails to load or behaves unexpectedly
- Tool calls return errors or unexpected results
- You need to troubleshoot app issues
- Agent seems unresponsive or messages get no reply
- Something silently fails

## Debug Files Overview

| File | Purpose | Check When |
|------|---------|------------|
| `/tmp/agent_debug.log` | Agent execution log - SDK import, API key, query processing, exceptions with tracebacks | Agent not responding, silent failures |
| `/tmp/events_{window_id}.jsonl` | Shared event stream - **two writers**: the agent (tool_start, tool_end, text_delta) and the MCP server (mcp_tools_discovered, mcp_tool_start, mcp_tool_result). Events from the MCP server have `"source": "mcp-server"`. | Missing events, partial responses, app not rendering |
| `/tmp/mcp-server.log` | MCP server process logs - startup, registration, errors (not event stream) | MCP server won't start, crashes |
| `/tmp/mcp-apps/{app-name}/.logs/runtime.jsonl` | Per-app runtime logs - tool call durations, handler errors, app.sendLog() output | App-specific issues, tool handler bugs |

## Quick Diagnostic Commands

```bash
# 1. Check agent execution issues (most common)
cat /tmp/agent_debug.log

# 2. Check MCP server process logs
cat /tmp/mcp-server.log

# 3. Check event stream for errors (replace {window_id})
grep -i error /tmp/events_{window_id}.jsonl

# 4. View events from MCP server only (app registration, tool calls)
grep '"source":"mcp-server"' /tmp/events_{window_id}.jsonl

# 5. View events from agent only (text, non-MCP tools)
grep -v '"source":"mcp-server"' /tmp/events_{window_id}.jsonl

# 6. Check MCP server health + registered apps
curl -s http://localhost:3000/health | jq .

# 7. Check app-specific logs (replace {app-name})
cat /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
```

## Event Stream: Two Writers, One File

The events file (`events_{window_id}.jsonl`) is written to by **both** the agent and the MCP server:

| Source | Event Types | Purpose |
|--------|------------|---------|
| Agent | `agent_start`, `text_delta`, `text_done`, `tool_start`, `tool_end`, `input_json_delta`, `agent_end` | Agent lifecycle, text streaming, non-MCP tool calls |
| MCP Server | `mcp_tools_discovered`, `mcp_tool_start`, `mcp_tool_result` | App registration discovery, MCP tool execution (has `"source": "mcp-server"`) |

The MCP server writes events with `source: "mcp-server"` and uses sequence numbers starting at 100000 to avoid collisions with the agent's sequence.

## App-Specific Log File Location

Each MCP app writes runtime logs to:

```
/tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
```

For example, if your app is named `counter-app`:
```
/tmp/mcp-apps/counter-app/.logs/runtime.jsonl
```

## Debugging Commands

### View recent logs (last 50 lines)
```bash
tail -50 /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
```

### Filter errors only
```bash
grep '"level":"error"' /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
```

### View MCP server events (tool calls, registrations)
```bash
grep '"source":"mcp-server"' /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
```

### View app-side logs (from app.sendLog())
```bash
grep -v '"source":"mcp-server"' /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
```

### View logs since a specific time
```bash
grep '"ts":"2024-' /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl | tail -20
```

## Log Format

Each line is a JSON object:

```json
{"ts":"2024-02-04T12:00:00.000Z","level":"info","source":"mcp-server","data":"App registered with 3 tool(s)","tools":["increment","decrement","reset"],"resourceUri":"ui://counter-app/mcp-app.html"}
{"ts":"2024-02-04T12:00:01.000Z","level":"info","source":"mcp-server","data":"Tool call: increment","tool":"increment","args":{}}
{"ts":"2024-02-04T12:00:01.050Z","level":"info","source":"mcp-server","data":"Tool result: increment","tool":"increment","duration":50,"success":true}
{"ts":"2024-02-04T12:00:02.000Z","level":"error","source":"counter-app","data":"Failed to parse response","stack":"Error: ..."}
```

### Fields

| Field | Description |
|-------|-------------|
| `ts` | ISO 8601 timestamp |
| `level` | Log level: `debug`, `info`, `warn`, `error` |
| `source` | Either `mcp-server` (server-side) or app name (client-side via `app.sendLog()`) |
| `data` | The log message or structured data |
| `tool` | (Optional) Tool name for tool-related logs |
| `duration` | (Optional) Execution time in milliseconds |
| `error` | (Optional) Error message |
| `stack` | (Optional) Stack trace for errors |

## Common Issues & Solutions

### App won't load / shows blank
1. Check if mcp_tools_discovered event was emitted (proves registration reached event stream):
   ```bash
   grep "mcp_tools_discovered" /tmp/events_{window_id}.jsonl
   ```
2. Check if mcp_tool_result event was emitted (proves tool call completed):
   ```bash
   grep "mcp_tool_result" /tmp/events_{window_id}.jsonl
   ```
3. Check for JavaScript errors in app logs:
   ```bash
   grep '"level":"error"' /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
   ```
4. Verify app was registered with MCP server:
   ```bash
   grep "App registered" /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
   ```
5. Check if dist/mcp-app.html exists:
   ```bash
   ls -la /home/user/workspace/{app-name}/dist/
   ```

### Tool calls fail
1. Check for tool errors:
   ```bash
   grep '"tool":' /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl | grep '"level":"error"'
   ```
2. Look at the error message and stack trace
3. Verify the tool handler in `tools/*.ts` is correct

### UI not updating after tool call
1. Check if `ontoolresult` handler has errors:
   ```bash
   grep -i "ontoolresult\|tool.*result" /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
   ```
2. Verify the tool returns valid JSON in the expected format
3. Check that `app.connect()` was called before tool calls

### App hangs / "Loading..." forever
1. Check if any logs exist at all:
   ```bash
   cat /tmp/mcp-apps/{app-name}/.logs/runtime.jsonl
   ```
2. If no logs: `app.connect()` may not have been called
3. If tool call logged but no result: tool handler may be hanging

### MCP server not responding
1. Check if server is running:
   ```bash
   curl -s http://localhost:3000/health | jq .
   ```
2. Check server logs:
   ```bash
   cat /tmp/mcp-server.log
   ```
3. Check server process:
   ```bash
   tmux capture-pane -p -t mcp -S -50
   ```

### Agent not responding / Silent failure
1. Check agent debug log:
   ```bash
   cat /tmp/agent_debug.log
   ```
2. Look for API key issues:
   ```bash
   grep -i "api_key\|anthropic" /tmp/agent_debug.log
   ```
3. Check for SDK import errors:
   ```bash
   grep -i "import\|sdk" /tmp/agent_debug.log
   ```
4. Check events for agent_end with errors:
   ```bash
   grep "agent_end" /tmp/events.jsonl
   ```

## Adding Logging to Your App

In your app's TypeScript (`src/mcp-app.ts`), use `app.sendLog()`:

```typescript
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "My App", version: "1.0.0" });

// Log info
app.sendLog({ level: "info", data: "Button clicked", logger: "my-app" });

// Log with structured data
app.sendLog({
  level: "info",
  data: { action: "submit", formData: { name: "test" } },
  logger: "my-app"
});

// Log errors
try {
  await riskyOperation();
} catch (err) {
  app.sendLog({
    level: "error",
    data: { message: "Operation failed", error: err.message },
    logger: "my-app"
  });
}
```

These logs will appear in the app's `.logs/runtime.jsonl` file with `source` set to the logger name.

## Window Event Archives

For long-running sessions, event logs are automatically archived to prevent disk overflow.

**Location:**
```
/tmp/.window-events/{window_id}/
├── current.jsonl        # Symlink to active events
├── archives/            # Compressed old events
│   └── events.{ts}.jsonl.gz
└── full_log.sh          # Helper to view ALL events
```

**Quick Commands:**
```bash
# View ALL events for a window (archives + current)
cd /tmp/.window-events/{window_id}
./full_log.sh | jq .

# Filter by event type
./full_log.sh | jq 'select(.type == "tool_end")'

# View only recent events
cat current.jsonl | jq .

# View specific archive
zcat archives/events.*.jsonl.gz | jq .

# Count total events
./full_log.sh | wc -l
```

**When to use:**
- Event stream seems incomplete
- Need to trace tool calls across multiple messages
- Debugging intermittent issues

**Configuration:**
| Env Variable | Default | Description |
|--------------|---------|-------------|
| `EVENTS_FILE_MAX_LINES` | 2000 | Lines before rotation |
| `EVENTS_MAX_ARCHIVES` | 10 | Number of archives to retain |
