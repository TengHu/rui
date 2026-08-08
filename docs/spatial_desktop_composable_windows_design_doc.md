# Spatial Desktop Composable Windows — Design Doc (Simple, In‑Memory)

## 1) Summary

We are building a **desktop-like spatial environment** where users create **user-generated software** by composing **living windows**. Each window is a small, persistent software fragment (UI + behavior + state) that can:
- collect / transform / visualize data
- spawn derived windows
- connect to other windows

We intentionally avoid a linear chat product. **Chat (or prompt) is only a builder/compiler layer** used to create or modify windows, while **direct manipulation** is used to operate them.

This doc proposes a **simple tech stack**:
- **React + TypeScript** frontend (single SPA)
- **Node.js + TypeScript** backend
- **In-memory runtime** (no database)
- **WindowSpec** (declarative window definition) + **WindowState** persisted in memory
- **Action registry** + WebSocket events for realtime UI updates

---

## 2) Goals

### Product goals
- **Additive iteration**: users add/compose windows rather than regenerate and overwrite.
- **Persistence during session**: windows keep state while the app is open.
- **Composition**: a window can derive from another window without copy/paste.
- **Re-entry within session**: closing/hiding windows does not lose work.
- **Rich UI**: React-based components (lists, tables, charts, forms).

### Engineering goals
- **Keep it simple**: no database; single process; minimal moving parts.
- **Stability**: once a window exists, it keeps rendering even if new windows are generated.
- **Safety**: avoid executing arbitrary generated code in the browser.

---

## 3) Non-Goals (for this phase)
- Multi-user collaboration
- Cross-device persistence
- Offline-first
- Arbitrary user code execution
- Plugin marketplace / third-party window embedding

---

## 4) Key Principles

### P1 — Chat is a compiler, not the workspace
- Use text prompts only to **create** or **modify** a window.
- Using a window (adding items, clicking buttons) is done **directly in UI**.

### P2 — Windows answer questions; new questions create new windows
- If the user requests a different view/abstraction, spawn a **new window**.
- Only rerender/update an existing window for small config/layout changes.

### P3 — Window = Spec + State
- **WindowSpec** defines structure & behavior.
- **WindowState** holds user data and runtime state.
- React renders windows through a **stable interpreter**.

---

## 5) Architecture Overview

```
React Desktop UI
  ├─ Window Manager (drag/resize/z-order)
  ├─ Window Renderer (Spec → React components)
  ├─ Local UI state (selection, focus)
  └─ Transport (REST + WebSocket)

Node Runtime
  ├─ Window Store (in-memory Map)
  ├─ Action Registry (stable action IDs)
  ├─ Spec Generator (AI agent output → specs)
  ├─ Derivation engine (new windows from existing)
  └─ Event Bus (push updates to clients)
```

---

## 6) Data Model

### 6.1 WindowRecord
A window in the system at runtime.

- `id`: unique window id
- `title`: string
- `spec`: WindowSpec (declarative UI + actions)
- `specVersion`: string (hash/semver)
- `state`: WindowState (data)
- `bindings`: references to other windows or resources
- `createdAt`, `updatedAt`

### 6.2 WindowSpec (declarative)
WindowSpec is a **JSON-serializable recipe** for rendering and behavior.

Minimum fields:
- `title`
- `ui`: a tree/list of UI elements (input, list, table, chart, text, button, etc.)
- `actions`: named actions triggered by UI events (click, submit, select)

> Important: WindowSpec is **not React code**. It is interpreted by React.

### 6.3 WindowState
- Key/value JSON object storing:
  - user-entered data (lists, rows)
  - current filters/sort
  - selection
  - derived results (optional)

---

## 7) Frontend (React) Design

### 7.1 App structure
- **DesktopCanvas**: full-screen surface (optional zoom/pan later)
- **WindowManager**:
  - drag/resize
  - z-index + focus
  - minimize/close
  - layout persistence in memory (client-side)
- **WindowShell**: chrome + title bar + controls
- **WindowRenderer**: interprets `WindowSpec.ui` and renders React components

### 7.2 UI component approach
Implement a small set of primitive blocks and grow later:
- `Text`
- `Input`
- `Button`
- `List`
- `Table`
- `Chart` (optional; can be stubbed)
- `Panel/Stack`

The renderer maps spec nodes → components.

### 7.3 State management (client)
- Keep only **presentation** state client-side:
  - window position/size
  - focus, selection
- Source-of-truth window content lives in server memory.

Recommended minimal:
- React state + context for window layout
- WebSocket subscription to window updates

### 7.4 Window creation UX
Provide two creation modes:
1) **+** → blank window with prompt: “What should this window do?”
2) **Create from this** (on an existing window) → derived window prompt: “What should the new window do with this?”

### 7.5 How users add data (important)
Once a window exists, users operate it **directly**:
- type into inputs
- press Enter
- click buttons

No “prompting” for routine operations.

---

## 8) Backend (Node/TS) Design

### 8.1 In-memory stores
- `windows: Map<WindowId, WindowRecord>`
- `actions: Map<ActionId, ActionHandler>`

### 8.2 API surface (minimal)
- `GET /snapshot` → returns all WindowRecords (or a list + details)
- `POST /windows` → create new window from prompt
- `POST /windows/:id/derive` → create new window derived from a source window
- `POST /windows/:id/action` → run action (button click, submit)
- `WS /events` → push events: window created/updated/removed

### 8.3 Action registry (stability)
UI spec references actions by stable IDs (e.g., `open_details`).

- WindowSpec contains `actionId`
- Backend resolves `actionId` → handler

This ensures existing windows keep working even if internal code changes.

---

## 9) AI Agent Integration (Simple)

### 9.1 What the agent is allowed to produce
For simplicity and safety, the agent outputs:
- WindowSpecs (JSON)
- Optional action configs (which tool to call)

Avoid letting the agent write arbitrary server code during early demos.

### 9.2 Spec generation flow
- User prompt → backend calls agent → returns a WindowSpec
- Backend creates `WindowRecord` with initial state
- Backend emits WebSocket event: `window_created`

### 9.3 Deriving windows
Derivation should pass structured context to the agent:
- source window spec
- source window state summary (bounded)
- user intent: “Show repeated issues”

Agent returns a new WindowSpec that binds to the source window.

---

## 10) Composition Model (Bindings)

A derived window should not copy data.
It should reference it.

Binding examples:
- `sourceWindowId: win_123`
- `inputKey: "items"`
- `transform: "countDuplicates"` (implemented as a backend tool)

The derived window can:
- show computed output
- open details by spawning another window with a filtered view

---

## 11) Versioning and “Maintain Previous UI”

Even in-memory, we should treat specs as versioned.

### Policy
- New intent/view → **new window**
- Small safe edits → update `specVersion` and keep state
- If an update is risky → create a new window and keep the old one intact

### Why this matters
- Protects spatial memory
- Prevents destructive iteration
- Makes demos feel stable

---

## 12) Demo Flow (Simple)

**Goal:** show composition and persistence without a chat thread.

1) User clicks **+** → prompt: “Collect customer feedback”
2) Window renders input + list; user adds three items directly
3) Click **Create from this** → prompt: “Show repeated issues”
4) New window shows counts; click **View details**
5) Third window opens filtered details

Stop here.

---

## 13) Implementation Plan (1–2 week demo)

### Phase 1 — Desktop & Windowing
- React desktop canvas
- Drag/resize windows
- Window chrome + focus

### Phase 2 — WindowSpec renderer
- Implement spec primitives: text/input/list/button
- Render from JSON spec

### Phase 3 — Backend runtime
- In-memory window store
- Minimal endpoints + WS events

### Phase 4 — Agent hooks
- Prompt → spec generation
- Derive → spec generation from source window

### Phase 5 — Demo polish
- “Create from this”
- “View details” spawns window
- Smooth transitions, minimal UI copy

---

## 14) Risks & Mitigations

### Risk: windows feel like “chat with rectangles”
Mitigation:
- direct manipulation inside windows
- no regenerate button
- prefer new windows over mutation

### Risk: iframe/page-per-window complexity
Mitigation:
- single SPA runtime
- spec interpreter
- reserve iframes only for later isolation needs

### Risk: agent produces inconsistent specs
Mitigation:
- validate spec schema
- keep a small set of allowed components
- fallback to safe templates

---

## 15) Appendix — Minimal Spec Shape (Example)

A “Collect customer feedback” window could be represented as:
- input field
- list
- add action

A “Repeated issues” window binds to the first window’s list and displays counts.

(Exact JSON schema can be defined after the first renderer is implemented.)

