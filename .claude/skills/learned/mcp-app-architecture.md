# MCP App Architecture - RouteWindow

**Extracted:** 2025-02-04
**Updated:** 2025-02-04
**Context:** Understanding how MCP Apps work in the RouteWindow/sandbox architecture

## Overview

This documents how interactive MCP apps communicate between the browser iframe, backend, and MCP server running in an e2b sandbox.

## Unified Event Stream Architecture

All agent output (text, tool calls, UI rendering) flows through a **single event stream**. The frontend decides what to render based on event type.

```
┌──────────────────────────────────────────────────────────────────┐
│  Agent produces events                                            │
│  ─────────────────────                                            │
│  { type: "text", content: "Building..." }                        │
│  { type: "tool_use", name: "write_file", ... }                   │
│  { type: "tool_result", name: "increment", ui: {...}, ... }      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  FilePoller enriches MCP tool results with UI metadata           │
│  ────────────────────────────────────────────────────            │
│  tool_end for mcp__app-server__X  →  lookup UI  →  add ui: {...} │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼ SSE
┌──────────────────────────────────────────────────────────────────┐
│  Frontend receives events, dispatches ADD_EVENT                  │
│  ──────────────────────────────────────────────                  │
│  state.windows[id].events = [..., newEvent]                      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Renderer decides what to show                                    │
│  ─────────────────────────────                                    │
│  event.type === 'text'        → <TextBubble />                   │
│  event.type === 'tool_use'    → <ToolUseIndicator />             │
│  event.type === 'tool_result' && event.ui → <AppRenderer />      │
│  event.type === 'tool_result' → <ToolResultDisplay />            │
└──────────────────────────────────────────────────────────────────┘
```

## Two Flows

| Flow | Path | Agent Involved? | Use Case |
|------|------|-----------------|----------|
| **Chat** | User → Agent → unified event stream → Frontend renders | Yes | Building apps, AI decisions |
| **UI Click** | User → iframe → FastAPI → MCP → iframe | No | Direct tool execution (fast) |

## Key Files

| File | Role |
|------|------|
| `RouteWindowContext.jsx` | Single `events[]` array per window, `ADD_EVENT` action |
| `RouteWindow.jsx` | Unified renderer: text, tool_use, tool_result (+UI) |
| `app_fastapi.py` (FilePoller) | Enriches MCP tool_end with UI metadata |
| `route_windows_fastapi.py` | Passes mcpServerUrl to FilePoller |

## State Shape

```javascript
windowState = {
  events: [
    { type: 'user_message', content: 'Build a counter' },
    { type: 'text', content: 'Building...', streaming: true },
    { type: 'tool_use', name: 'write_file', input: {...} },
    { type: 'tool_result', name: 'increment', output: {...}, ui: { resourceUri: '...' }, mcpServerUrl: '...' },
    { type: 'text', content: 'Done!', streaming: false },
  ],
  mcpServerUrl: '...',  // For direct tool calls from iframe
}
```

## How UI Rendering Works

1. Agent calls MCP tool (e.g., `mcp__app-server__increment`)
2. FilePoller sees `tool_end` event for MCP tool
3. FilePoller looks up UI metadata from `/health` endpoint
4. FilePoller enriches event: `{ ..., ui: { resourceUri: '...' }, mcpServerUrl: '...' }`
5. SSE streams enriched event to frontend
6. Frontend dispatches `ADD_EVENT`
7. Renderer finds `latestUiEvent` (tool_result with ui metadata)
8. AppRenderer shown with resourceUri

## Design Decisions

**Why unified event stream?**
- Single source of truth (one `events[]` array)
- Ordering preserved (events render in exact order)
- Simpler reducer (one action: `ADD_EVENT`)
- UI is just another event (tool_result with ui metadata)

**Why keep direct path for iframe clicks?**
- Fast (no LLM latency)
- User already knows what they want
- No AI decision needed

## When to Use This Pattern

- Building interactive MCP apps in RouteWindow
- Debugging tool call flows
- Understanding why a tool call succeeded/failed
- Adding new event types to the stream
