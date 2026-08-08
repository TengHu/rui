# SSE Event Flow: Sandbox → UI

A guide to understanding how events flow from the agent to the browser.

---

## 1. Event Generation (Sandbox)

| File | Purpose |
|------|---------|
| [sandbox_agent1.py:27-71](../sandbox_agent1.py) | `EventEmitter` class - writes events to `events.jsonl` |
| [sandbox_agent1.py:236-254](../sandbox_agent1.py) | Emits `text_delta`, `text_done`, `agent_end` during agent execution |
| [sandbox_agent1.py:103-164](../sandbox_agent1.py) | Hooks emit `tool_start`, `tool_end`, `image` events |

**Output**: `/tmp/events.jsonl` or `/tmp/events_{window_id}.jsonl` (JSONL format, one event per line)

---

## 2. Event Polling (Backend)

| File | Purpose |
|------|---------|
| [app.py:305-479](../chatbot_web/app.py) | `FilePoller` class - polls `events.jsonl` every 100ms |
| [app.py:42](../chatbot_web/app.py) | `event_queues` dict - shared storage for events per conversation |
| [app.py:546-553](../chatbot_web/app.py) | Creates event queue when `/api/chat` is called |
| [app.py:626-643](../chatbot_web/app.py) | Starts `FilePoller` to watch sandbox events file |

**Flow**: FilePoller reads file → parses JSONL → appends to `event_queues[conversation_id]["events"]`

---

## 3. SSE Streaming (Backend → Frontend)

| File | Purpose |
|------|---------|
| [app.py:145-219](../chatbot_web/app.py) | `/api/events/<conversation_id>` SSE endpoint |
| [app.py:151-209](../chatbot_web/app.py) | `generate()` - yields events as `data: {JSON}\n\n` |
| [app.py:195-196](../chatbot_web/app.py) | Heartbeat every 5 seconds |

**Format**: Server-Sent Events (`text/event-stream`)

---

## 4. SSE Client (Frontend)

| File | Purpose |
|------|---------|
| [useEventStream.js](../chatbot_web/frontend/src/hooks/useEventStream.js) | Hook that establishes `EventSource` connection |
| [sseClient.js:2-68](../chatbot_web/frontend/src/utils/sseClient.js) | `SSEClient` class - manages EventSource lifecycle |
| [sseClient.js:71-198](../chatbot_web/frontend/src/utils/sseClient.js) | `handleStreamingEvent()` - routes events by type |

**Event Types Handled**:
- `text_delta` → update streaming message
- `text_done` → finalize message
- `tool_start` → show tool indicator
- `file` / `image` → open window
- `agent_end` → mark complete

---

## 5. State Management (Frontend)

| File | Purpose |
|------|---------|
| [ChatContext.jsx:15-22](../chatbot_web/frontend/src/context/ChatContext.jsx) | State: `messages`, `streamingMessage`, `isLoading` |
| [ChatContext.jsx:115-122](../chatbot_web/frontend/src/context/ChatContext.jsx) | `updateStreamingMessage()` - appends text tokens |
| [ChatContext.jsx:124-138](../chatbot_web/frontend/src/context/ChatContext.jsx) | `finalizeStreamingMessage()` - moves to messages array |
| [ChatContext.jsx:24-26](../chatbot_web/frontend/src/context/ChatContext.jsx) | `addMessage()` - adds completed message |

---

## 6. UI Rendering (Frontend)

| File | Purpose |
|------|---------|
| [EventPanel.jsx](../chatbot_web/frontend/src/components/EventPanel/EventPanel.jsx) | Main chat display panel |
| [EventPanel.jsx:9-19](../chatbot_web/frontend/src/components/EventPanel/EventPanel.jsx) | Filters & sorts messages by timestamp |
| [EventPanel.jsx:72-76](../chatbot_web/frontend/src/components/EventPanel/EventPanel.jsx) | Renders streaming message |
| [EventPanel.css](../chatbot_web/frontend/src/components/EventPanel/EventPanel.css) | Styling for messages |

---

## Visual Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  SANDBOX                                                        │
│  sandbox_agent1.py → EventEmitter → events.jsonl                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  BACKEND (app.py)                                               │
│  FilePoller → event_queues dict → /api/events SSE endpoint      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (EventSource)
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND                                                       │
│  useEventStream → sseClient → ChatContext → EventPanel          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Event Types Reference

| Event | Source | Handler | UI Effect |
|-------|--------|---------|-----------|
| `text_delta` | StreamEvent | `updateStreamingMessage()` | Append text |
| `text_done` | AssistantMessage | `finalizeStreamingMessage()` | Complete message |
| `tool_start` | pre_tool_use_hook | `addMessage()` | Show tool indicator |
| `tool_end` | post_tool_use_hook | - | (logged) |
| `file` | post_tool_use_hook | `openWindow()` | Open file viewer |
| `image` | post_tool_use_hook | `openWindow()` | Open image viewer |
| `agent_end` | run_agent() | - | Mark complete |
