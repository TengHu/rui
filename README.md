# E2B Sandbox Agent

Run Claude agents in isolated E2B sandboxes with a desktop OS-style interface featuring real-time streaming.

## Demo

Ask for an app in plain language and it is built inside a sandbox, then opens as a
window on the desktop. Below: a CSV of warehouse inventory turned into an interactive
3D visualization, side by side with a spreadsheet editor.

https://github.com/user-attachments/assets/86dc0b11-81a0-4389-9541-abbd1dfffd13

## Architecture Overview

This project combines a **FastAPI backend** with a **React frontend** to create a desktop operating system experience where users interact with AI-generated applications through draggable windows.

### Frontend: React + Vite
- **Desktop Environment**: Users see a desktop with background, taskbar, and draggable windows
- **Window System**: Each agent output (files, images, web apps) opens in a separate draggable/resizable window
- **Transparent Chat Panel**: Right-side panel shows agent reasoning and tool execution in real-time
- **Chat Input**: Fixed at bottom center for user interaction
- **Sticky Notes**: Draggable notes that persist on the desktop

### Backend: FastAPI + E2B Sandboxes
- **SSE Streaming**: Server-Sent Events for real-time communication from sandbox to UI
- **Agent Execution**: Claude agents run inside isolated E2B sandboxes
- **Event System**: Events from sandbox are streamed through FastAPI to React frontend

### How They Connect

```
┌─────────────────────────────────────────────────────────────────────┐
│ React Frontend (Port 5173 in dev)                                   │
│  ├─ Desktop Component (windows, chat panel, taskbar)                │
│  ├─ SSEClient connects to /api/events/{conversationId}              │
│  └─ Event handlers create windows based on event types              │
└────────────────────────┬────────────────────────────────────────────┘
                         │ SSE Stream
                         ↓
┌─────────────────────────────────────────────────────────────────────┐
│ FastAPI Backend (Port 8000)                                         │
│  ├─ /api/chat - receives messages, starts agent                     │
│  ├─ /api/events/{id} - SSE endpoint, streams events                 │
│  └─ In-memory event queues (shared across threads)                  │
└────────────────────────┬────────────────────────────────────────────┘
                         │ File Polling
                         ↓
┌─────────────────────────────────────────────────────────────────────┐
│ E2B Sandbox                                                         │
│  ├─ Agent writes to events.jsonl                                    │
│  ├─ FilePoller monitors events.jsonl                                │
│  └─ Events: text_delta, tool_start, tool_end, file, image          │
└─────────────────────────────────────────────────────────────────────┘
```

### Event → Window Mapping

| Event Type | Frontend Action |
|------------|----------------|
| `text_delta`, `text_done` | Update chat panel with streaming text |
| `tool_start` | Show tool indicator in chat panel |
| `tool_end` (Write, Edit, Read) | Open FILE_VIEWER window with file content |
| `file` (HTML) | Open WEB_APP window with iframe |
| `image` | Open IMAGE_VIEWER window with image |
| E2B URL detected | Open WEB_APP window with URL |

## React Frontend Architecture

### Key Components

| Component | Purpose | Location |
|-----------|---------|----------|
| **Desktop** | Main container with background, manages layout layers | `frontend/src/components/Desktop/` |
| **Window** | Draggable/resizable window using react-rnd | `frontend/src/components/Window/` |
| **ChatPanel** | Transparent right-side panel showing conversation | `frontend/src/components/ChatPanel/` |
| **ChatInput** | Fixed bottom input with suggestion chips | `frontend/src/components/ChatInput/` |
| **Taskbar** | Bottom bar showing open windows and time | `frontend/src/components/Taskbar/` |
| **Terminal** | Interactive bash shell via E2B sandbox PTY | `frontend/src/components/Terminal/` |
| **FileManager** | File browser for E2B sandbox filesystem | `frontend/src/components/FileManager/` |
| **StickyNote** | Draggable sticky notes with persistence | `frontend/src/components/StickyNote/` |
| **WindowContents/** | Viewers for different content types (files, images, webapps) | `frontend/src/components/WindowContents/` |
| **ContextMenu** | Right-click desktop menu with actions | `frontend/src/components/ContextMenu/` |

### Desktop Features (Phase 4)

#### Window Snapping
Drag windows to screen edges to snap them into position:

| Edge | Snap Behavior |
|------|---------------|
| Left edge | Window fills left 50% of screen |
| Right edge | Window fills right 50% of screen |
| Top edge | Window maximizes |
| Top-left corner | Window fills top-left quarter |
| Top-right corner | Window fills top-right quarter |
| Bottom-left corner | Window fills bottom-left quarter |
| Bottom-right corner | Window fills bottom-right quarter |

A blue translucent preview shows the snap zone while dragging.

#### Keyboard Shortcuts

| Shortcut (Mac) | Shortcut (Windows) | Action |
|----------------|-------------------|--------|
| ⌘+W | Ctrl+W | Close active window |
| ⌘+M | Ctrl+M | Minimize active window |
| ⌘+Tab | Ctrl+Tab | Cycle through windows |
| ⌘+⇧+W | Ctrl+Shift+W | Close all windows |

#### Context Menu
Right-click on the desktop background to access:
- **New Window** - Create a new route window
- **New Sticky Note** - Create a sticky note at cursor position
- **Upload File** - Upload files to sandbox
- **Refresh** - Reload the page
- **View** - Zoom controls (Reset, Zoom In, Zoom Out)
- **Close All Windows** - Close all open windows

### State Management (React Context)

| Context | State | Actions |
|---------|-------|---------|
| **WindowContext** | `windows`, `focusedWindowId`, `minimizedWindows` | `openWindow()`, `closeWindow()`, `minimizeWindow()`, `restoreWindow()`, `focusWindow()` |
| **ChatContext** | `messages`, `conversationId`, `sandboxReady`, `isLoading` | `sendMessage()`, `createSandbox()`, `addMessage()`, `updateStreamingMessage()` |
| **StickyNotesContext** | `notes` | `addNote()`, `updateNote()`, `deleteNote()` |

### SSE Integration Flow

1. **User sends message** → `ChatInput` calls `sendMessage()` from `ChatContext`
2. **ChatContext** → POST to `/api/chat` with message and conversationId
3. **useEventStream hook** → Creates EventSource connection to `/api/events/{conversationId}`
4. **SSEClient** → Listens for events and calls `handleStreamingEvent()`
5. **Event handlers**:
   - `text_delta` → Updates `streamingMessage` in ChatContext
   - `tool_end` → Calls `openWindow()` from WindowContext with appropriate window type
   - `file` → Opens FILE_VIEWER or WEB_APP window
   - `image` → Opens IMAGE_VIEWER window
6. **Window renders** → Desktop component maps over windows array and renders Window components

### File Structure

```
chatbot_web/frontend/
├── src/
│   ├── App.jsx                      # Root component with context providers
│   ├── main.jsx                     # Entry point
│   ├── components/
│   │   ├── Desktop/                 # Desktop environment
│   │   ├── Window/                  # Draggable window
│   │   ├── ChatPanel/               # Chat conversation display
│   │   ├── ChatInput/               # Message input
│   │   ├── Taskbar/                 # Window taskbar
│   │   ├── StickyNote/              # Sticky notes
│   │   ├── ContextMenu/             # Right-click context menu
│   │   └── WindowContents/          # Content viewers (File, Image, WebApp, etc.)
│   ├── context/
│   │   ├── WindowContext.jsx        # Window state management
│   │   ├── ChatContext.jsx          # Chat state management
│   │   └── StickyNotesContext.jsx   # Sticky notes state
│   ├── hooks/
│   │   ├── useEventStream.js        # SSE connection hook
│   │   └── useKeyboardShortcuts.js  # Global keyboard shortcuts (⌘+W, ⌘+M, ⌘+Tab)
│   └── utils/
│       ├── sseClient.js             # EventSource wrapper
│       ├── windowTypes.js           # Window type constants
│       └── constants.js             # App configuration
├── vite.config.js                   # Vite configuration with proxy
├── package.json                     # Dependencies
└── index.html                       # HTML entry point
```

### Key Technologies

- **React 18.3.1** - Component library with hooks
- **Vite 5.2.0** - Build tool and dev server
- **react-rnd 10.4.1** - Draggable and resizable windows
- **framer-motion 11.0.0** - Animations
- **prism-react-renderer 2.3.1** - Syntax highlighting for code

## Setup

### Prerequisites

- Python 3.11+
- Node.js 18+
- An [E2B](https://e2b.dev) API key
- An [Anthropic](https://console.anthropic.com) API key

### Environment Variables

```bash
cp .env.example .env
# Then fill in E2B_API_KEY, ANTHROPIC_API_KEY, and SESSION_SECRET_KEY
```

`.env` is gitignored — never commit it. See [`.env.example`](.env.example) for every
supported variable and where to obtain each credential.

### Backend Setup

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install Python dependencies
pip install -r requirements.txt
pip install -r chatbot_web/requirements.txt
```

### Frontend Setup

```bash
# Navigate to frontend directory
cd chatbot_web/frontend

# Install Node.js dependencies
npm install
```

> **Note:** For frontend-specific documentation, see [chatbot_web/README.md](chatbot_web/README.md)

## Quick Start

```bash
# Terminal 1: Start Backend (FastAPI)
cd chatbot_web
set -a; source ../.env; set +a
python -m uvicorn app_fastapi:app --reload --port 8000

# Terminal 2: Start Frontend (Vite)
cd chatbot_web/frontend
npm run dev

# Open browser to http://localhost:5173
```

## Local Development

For local development, you need to run both the backend and Vite frontend in separate terminals.

### Terminal 1: Backend (FastAPI - Recommended)

```bash
# Navigate to chatbot_web directory
cd chatbot_web

# Load environment variables
source ../.env  # Or: set -a; source ../.env; set +a

# Start FastAPI backend (serves API at port 8000)
python -m uvicorn app_fastapi:app --reload --port 8000
```

**Required environment variables in `.env`** (see [`.env.example`](.env.example) for the full list):
```
E2B_API_KEY=your-e2b-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
SESSION_SECRET_KEY=your-random-secret
```

### Terminal 2: Frontend (Vite)

```bash
# Navigate to frontend directory
cd chatbot_web/frontend

# Install dependencies (first time only)
npm install

# Start Vite dev server (serves UI at port 5173)
npm run dev
```

### Access the Application

Open your browser to **http://localhost:5173**

The Vite dev server will proxy API requests (`/api/*`) to the backend automatically (configured in `vite.config.js`).

### Testing Desktop Features

Once the app loads:

1. **Window Snapping** - Drag any window to screen edges to snap
2. **Keyboard Shortcuts** - Try ⌘+M (minimize), ⌘+W (close), ⌘+Tab (cycle windows)
3. **Context Menu** - Right-click on desktop background
4. **Terminal** - Click the Terminal icon (⬛) in the taskbar
5. **File Manager** - Click the Files icon (📁) in the taskbar

**Note:** Terminal and File Manager require an active E2B sandbox. The sandbox initializes automatically when the app loads.

### How Local Development Works

1. **Vite Dev Server** (port 5173): Serves the React app with hot module reloading
2. **Proxy Configuration**: Vite proxies `/api/*` requests to the backend (see `frontend/vite.config.js`)
3. **FastAPI Backend** (port 8000): Handles API requests and SSE streaming
4. **E2B Sandbox**: Executes agent code and writes events to `events.jsonl`
5. **Real-time Updates**: SSE connection streams events from FastAPI → React, creating windows dynamically

## Production Deployment (Render)

In production, FastAPI serves the built React application from `chatbot_web/frontend/dist/`.

### Initial Setup

1. **Connect GitHub to Render** at https://dashboard.render.com
2. **Configure the Web Service** with these settings:

**Build Settings:**
```
Build Command: pip install -r requirements.txt && pip install -r chatbot_web/requirements.txt && cd chatbot_web/frontend && npm install && npm run build && cd ../..
Start Command: cd chatbot_web && python -m uvicorn app_fastapi:app --host 0.0.0.0 --port $PORT
```

**Environment Variables:** see [`.env.example`](.env.example) for the full list. At minimum:
```
E2B_API_KEY=<your-e2b-api-key>
ANTHROPIC_API_KEY=<your-anthropic-api-key>
SESSION_SECRET_KEY=<random secret, see .env.example>
```

**Important:** Run a **single process**. The backend keeps event queues in memory, so multiple workers cannot share SSE state (see [Why Single Worker?](#why-single-worker)).

### Running Production Build Locally

To test production setup locally:

```bash
# Build the React frontend
cd chatbot_web/frontend
npm install
npm run build
cd ../..

# Start the backend in production mode
cd chatbot_web
set -a; source ../.env; set +a
python -m uvicorn app_fastapi:app --host 0.0.0.0 --port 8000

# Open http://localhost:8000
# FastAPI serves the built React app from frontend/dist/
```

### How Production Works

1. **Build Step**: `npm run build` creates optimized production files in `frontend/dist/`
2. **Static Mounting**: `app_fastapi.py` mounts the build output and serves `index.html` at `/`:
   ```python
   static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "dist")
   app.mount("/assets", StaticFiles(directory=os.path.join(static_dir, "assets")), name="assets")
   ```
3. **Single Process**: FastAPI serves both the React app (static files) and API endpoints (`/api/*`)
4. **SSE Streaming**: Events flow from E2B sandbox → FastAPI → Browser via SSE, same as development

## API Endpoints

### GET `/`
Serves the React application (from `frontend/dist/` in production, proxied from Vite in dev).

### POST `/api/chat`
Handle chat messages and run them through the sandbox agent.

**Request:**
```json
{
  "message": "Your message here",
  "conversation_id": "optional-uuid"
}
```

**Response (Success):**
```json
{
  "response": "Agent's response",
  "success": true,
  "conversation_id": "uuid",
  "message_id": "msg_id"
}
```

**Response (Error):**
```json
{
  "error": "Error message",
  "success": false
}
```

### POST `/api/sandbox/new`
Create a new sandbox for a conversation.

**Request:**
```json
{
  "conversation_id": "required-uuid"
}
```

**Response:**
```json
{
  "success": true,
  "sandbox_id": "sandbox-id",
  "reused": false
}
```

### GET `/api/sandbox/file`
Read a file from the sandbox.

**Query Parameters:**
- `path` - File path in sandbox
- `sandbox_id` - Sandbox ID
- `binary` - Set to `"true"` for binary files (returns base64)

**Response:**
```json
{
  "success": true,
  "path": "/path/to/file",
  "content": "file content or base64",
  "is_binary": false,
  "exists": true
}
```

### GET `/api/events/<conversation_id>`
Server-Sent Events (SSE) endpoint for real-time event streaming.

**Response:** Streaming SSE with events:
```
data: {"type": "connected"}

data: {"type": "text_delta", "data": {"text": "Hello"}, "message_id": "msg_123"}

data: {"type": "agent_end", "data": {"success": true}, "message_id": "msg_123"}

data: {"type": "stream_end"}
```

### GET `/api/health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "sandbox_id": "sandbox-id",
  "sandbox_configured": true
}
```

### WebSocket `/api/terminal/ws`
Interactive terminal session via E2B sandbox PTY.

**Query Parameters:**
- `sandbox_id` (optional) - Sandbox ID to connect to. Uses shared sandbox if not provided.

**Protocol (JSON messages):**

Client → Server:
```json
{"type": "input", "data": "ls -la\n"}     // Send keystrokes
{"type": "resize", "cols": 80, "rows": 24} // Resize terminal
{"type": "ping"}                           // Keepalive
```

Server → Client:
```json
{"type": "ready"}                          // Terminal ready
{"type": "output", "data": "user@sandbox:~$ "} // Shell output
{"type": "error", "message": "..."}        // Error occurred
{"type": "pong"}                           // Keepalive response
```

### GET `/api/terminal/status`
Get active terminal sessions.

**Response:**
```json
{
  "active_sessions": 1,
  "sessions": [{"session_id": "123", "sandbox_id": "abc"}]
}
```

## Backend File Structure

```
chatbot_web/
├── app_fastapi.py            # FastAPI server with SSE streaming
├── config.py                 # Configuration loading
├── requirements.txt          # Python dependencies
├── routes/                   # API route modules
│   ├── auth_fastapi.py       # Google OAuth + session handling
│   ├── filesystem_fastapi.py # Sandbox file browsing
│   ├── mcp_fastapi.py        # MCP app registration/proxying
│   ├── route_windows_fastapi.py # Per-window agent chat
│   ├── terminal_fastapi.py   # Terminal WebSocket (PTY)
│   └── windows_fastapi.py    # Window state
├── services/                 # Sandbox and agent orchestration
├── models/                   # Pydantic models
├── stores/                   # In-memory + SQLite state
├── middleware/               # Request middleware
├── assets/                   # Prebuilt MCP apps uploaded to sandboxes
└── frontend/                 # React application (see frontend/README.md)
    ├── dist/                 # Production build (generated)
    ├── src/                  # React source code
    ├── package.json          # Frontend dependencies
    └── vite.config.js        # Vite configuration
```

## Streaming Architecture

Real-time token-by-token streaming from sandbox agent to browser UI using Server-Sent Events (SSE).

### Flow

```
┌─────────────────────────────────────────────────────────────┐
│ E2B Sandbox                                                 │
│  ┌──────────────┐      ┌─────────────────────────────────┐  │
│  │ Agent Process│      │ Tail Process (dedicated channel)│  │
│  │              │      │ tail -f events.jsonl            │  │
│  │ writes to ───┼─────►│                                 │  │
│  │ events.jsonl │      │ on_stdout ──────────────────────┼──┼──► Backend → SSE → Frontend
│  └──────────────┘      └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Agent** (`sandbox_agent1.py`) runs inside E2B sandbox with `include_partial_messages=True`
2. **EventEmitter** writes JSON events to `events.jsonl` with immediate flush
3. **FilePoller** monitors the file via `sandbox.files.read()` (~150ms polling interval)
4. **Backend** (`app_fastapi.py`) stores events in memory and forwards to SSE endpoint (`/api/events`)
5. **Frontend** (`useEventStream.js` / `sseClient.js`) receives SSE stream and renders token-by-token

### Why Single Worker?

The backend stores events in **in-memory dictionaries** (`event_queues`, `conversation_sessions`). With multiple worker processes, each worker has separate memory space, causing SSE streaming to fail:

- Request to `/api/chat` handled by Worker A → stores events in Worker A's memory
- SSE connection to `/api/events` handled by Worker B → can't access Worker A's events

**Solution:** Run a single uvicorn process. Because the app is async, one process handles many concurrent SSE connections without needing extra workers.

### Event Types

| Type | Data | Description |
|------|------|-------------|
| `text_delta` | `{"text": "..."}` | Streaming token (1-5 chars) |
| `text_done` | `{"full_text": "..."}` | Complete message block |
| `tool_start` | `{"id", "tool", "input"}` | Tool invocation started |
| `tool_end` | `{"id", "output", "error?"}` | Tool invocation completed |
| `file` | `{"path", "content"}` | Text file written |
| `image` | `{"path", "base64", "mime"}` | Image file written |
| `agent_start` | `{"query", "session_id?"}` | Agent started |
| `agent_end` | `{"success", "session_id?"}` | Agent completed |

### Key Files

| File | Role |
|------|------|
| `sandbox_agent1.py` | Agent code running inside sandbox, emits events to file |
| `chatbot_web/app_fastapi.py` | FastAPI backend with `tail -f` streaming channel |
| `chatbot_web/frontend/src/utils/sseClient.js` | Frontend SSE handler and UI rendering |

## Troubleshooting

### Text Input Not Editable / Sandbox Not Starting

**Symptom:** When the app loads, the text input is disabled and shows "Setting up your virtual computer..."

**Cause:** The React frontend dev server isn't running, or you're accessing the backend directly instead of Vite.

**Fix:**
1. Make sure both servers are running (backend on port 8000, Vite on port 5173/5174)
2. Access the app at **http://localhost:5173** (or 5174), NOT http://localhost:8000
3. The Vite dev server proxies API calls to the backend automatically
4. Check browser console (F12) for any CORS or network errors

### SSE Streaming Not Working on Render

**Symptom:** Tool calls and message streaming don't appear in the UI after deploying to Render.

**Cause:** Multiple worker processes don't share in-memory event queues.

**Fix:** Update your Render service start command to run a single process:

1. Go to your service's **Settings** page in the Render dashboard
2. Update **Start Command** to:
   ```bash
   cd chatbot_web && python -m uvicorn app_fastapi:app --host 0.0.0.0 --port $PORT
   ```
3. Save and redeploy

### Testing SSE Locally

```bash
# Open browser console on http://localhost:5173
# Check for EventSource connection:
eventSource = new EventSource('/api/events/YOUR-CONVERSATION-ID');
eventSource.onmessage = (e) => console.log(JSON.parse(e.data));
```

## CLI Usage

### Sandbox Management

```bash
# Always load .env first
set -a; source .env; set +a

# Create a sandbox
python sandbox_manager.py create

# Run agent on sandbox
python sandbox_runner.py "$SANDBOX_ID" \
  --query-file input_query.txt

# With session resume and event watching
python sandbox_runner.py "$SANDBOX_ID" \
  --query-file input_query.txt \
  --system-prompt-file system_prompt.txt \
  --watch-events \
  --session-id "sess_abc123"
```

## Build Custom Template (Optional)

```bash
# Build and upload template to E2B
set -a; source .env; set +a; python e2b.template.py

# Set template ID in .env
# E2B_TEMPLATE_ID=general-ai-agent
```

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.

## References

- [E2B Documentation](https://e2b.dev/docs)
- [E2B Code Interpreter](https://github.com/e2b-dev/code-interpreter)
- [E2B cookbook](https://github.com/e2b-dev/e2b-cookbook)
- [Claude Agent SDK](https://github.com/anthropics/claude-code)
- [Email Agent Example](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/email-agent)
- [Research Agent Example](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/research-agent)

