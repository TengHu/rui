# Window Messaging & Event System

This document explains how windows communicate with each other in the spatial software system.

## Overview

Windows are isolated iframes that communicate via the browser's `postMessage` API. A parent-level relay (SelectionContext) broadcasts messages from one window to all other windows.

```
┌─────────────────────────────────────────────────────────────────┐
│                     PARENT FRAME (Desktop)                       │
│                                                                  │
│   SelectionContext                                               │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  - Listens for postMessage from all iframes             │   │
│   │  - Relays SELECTION → SELECTION_BROADCAST to others     │   │
│   │  - Maintains registry of all iframe refs                │   │
│   └─────────────────────────────────────────────────────────┘   │
│                          │                                       │
│         ┌────────────────┼────────────────┐                     │
│         ▼                ▼                ▼                     │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐                 │
│   │ Window A │    │ Window B │    │ Window C │                 │
│   │ (iframe) │    │ (iframe) │    │ (iframe) │                 │
│   │          │    │          │    │          │                 │
│   │ Table    │    │ Chart    │    │ Details  │                 │
│   └──────────┘    └──────────┘    └──────────┘                 │
└─────────────────────────────────────────────────────────────────┘
```

## Message Types

### SELECTION (Outbound)

Sent by a window when the user selects data (clicks a row, selects points, etc.).

```javascript
window.parent.postMessage({
  type: 'SELECTION',
  selection: {
    type: 'row',           // What kind of selection: 'row', 'item', 'point', 'region', etc.
    ids: ['id1', 'id2'],   // Selected IDs
    data: [{...}, {...}],  // Optional: Full data objects
    indices: [0, 2],       // Optional: For tables, row indices
  }
}, '*')
```

### SELECTION_BROADCAST (Inbound)

Received by windows when another window broadcasts a selection. The parent relay adds a timestamp and changes the type.

```javascript
window.addEventListener('message', (e) => {
  if (e.data.type === 'SELECTION_BROADCAST') {
    const selection = e.data.selection
    // selection.type - what kind of data
    // selection.ids - selected IDs
    // selection.data - full data (if provided)
    // selection.timestamp - when selection occurred
  }
})
```

## Selection Schema

```typescript
interface Selection {
  type: string          // Category of selection (required)
  ids?: string[]        // Array of selected IDs
  indices?: number[]    // For tables: row indices
  data?: any[]          // Full data objects
  timestamp?: number    // Added by relay (Date.now())
}
```

### Common Selection Types

| Type | Use Case | Example |
|------|----------|---------|
| `row` | Table row selection | `{ type: 'row', ids: ['row-1'], data: [{name: 'Item', price: 100}] }` |
| `item` | Generic item selection | `{ type: 'item', ids: ['abc123'] }` |
| `point` | Chart/scatter point | `{ type: 'point', ids: ['p1', 'p2'], data: [{x: 10, y: 20}] }` |
| `region` | Spatial/map region | `{ type: 'region', ids: ['zone-a'], data: {bounds: {...}} }` |
| `node` | Graph/network node | `{ type: 'node', ids: ['node-1'], data: [{label: 'A'}] }` |
| `slot` | Warehouse slot | `{ type: 'slot', ids: ['A1', 'B2'] }` |

## Implementation Details

### SelectionContext (Parent Relay)

Location: `frontend/src/context/SelectionContext.jsx`

```jsx
export function SelectionProvider({ children }) {
  const iframeRefsRef = useRef(new Map()) // windowId -> iframe element

  useEffect(() => {
    const handleMessage = (event) => {
      // Only handle SELECTION messages
      if (event.data?.type !== 'SELECTION') return

      const selection = event.data.selection
      if (!selection) return

      // Broadcast to all OTHER iframes (not the sender)
      iframeRefsRef.current.forEach((iframe, windowId) => {
        if (iframe?.contentWindow && event.source !== iframe.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'SELECTION_BROADCAST',
            selection: { ...selection, timestamp: Date.now() }
          }, '*')
        }
      })
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Register iframe for receiving broadcasts
  const registerIframe = useCallback((windowId, iframeElement) => {
    if (iframeElement) {
      iframeRefsRef.current.set(windowId, iframeElement)
    }
    return () => iframeRefsRef.current.delete(windowId)
  }, [])

  return (
    <SelectionContext.Provider value={{ registerIframe }}>
      {children}
    </SelectionContext.Provider>
  )
}
```

### RouteWindow Registration

Each RouteWindow registers its iframe with the SelectionContext:

```jsx
// In RouteWindow.jsx
const { registerIframe } = useSelection()

useEffect(() => {
  if (iframeRef.current) {
    const unregister = registerIframe(windowRecord.id, iframeRef.current)
    return unregister
  }
}, [windowRecord.id, registerIframe])
```

## Example: Broadcasting Selection

```javascript
// In a table app - broadcast when user clicks a row
document.querySelectorAll('tr').forEach(row => {
  row.addEventListener('click', () => {
    const rowData = JSON.parse(row.dataset.item)

    window.parent.postMessage({
      type: 'SELECTION',
      selection: {
        type: 'row',
        ids: [rowData.id],
        data: [rowData]
      }
    }, '*')
  })
})
```

## Example: Receiving Selection

```javascript
// In a chart app - highlight when selection received
window.addEventListener('message', (e) => {
  if (e.data.type === 'SELECTION_BROADCAST') {
    const { type, ids, data } = e.data.selection

    if (type === 'row' && ids) {
      // Highlight corresponding points in the chart
      highlightPointsByIds(ids)
    }
  }
})
```

## Derive Window Flow

When a user clicks the "derive" button on a window:

1. **Source window** receives a message to add postMessage broadcasting
2. **New window** receives a message to add postMessage listener

```
User clicks [derive] on Window A
        │
        ▼
┌───────────────────────────────────────┐
│ DeriveWindowModal opens               │
│ User enters: "Show chart of selected" │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ STEP 1: Update Source Window          │
│ sendMessage(sourceWindow.id,          │
│   "Add postMessage broadcasting...")  │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ STEP 2: Create New Window             │
│ createWindow("Related: Show chart...") │
│ sendMessage(newWindow.id,             │
│   "Listen to SELECTION_BROADCAST...")  │
└───────────────────────────────────────┘
```

## AI System Prompt

The AI agent receives instructions about postMessage in its system prompt (`route_windows_fastapi.py`):

```
## Cross-Window Communication (IMPORTANT)

Your app runs in an iframe alongside other windows. Use postMessage to communicate:

TO BROADCAST a selection:
window.parent.postMessage({
  type: 'SELECTION',
  selection: { type: 'row', ids: [...], data: [...] }
}, '*')

TO RECEIVE selections:
window.addEventListener('message', (e) => {
  if (e.data.type === 'SELECTION_BROADCAST') {
    const sel = e.data.selection
    // React to selection
  }
})
```

## Key Design Decisions

### Why postMessage?

- **Browser-native**: No library dependencies, works everywhere
- **Iframe-safe**: Works across same-origin iframes
- **Simple**: JSON serialization, no setup required
- **Decoupled**: Windows don't need to know about each other

### Why broadcast model?

- **Simple**: No subscription management
- **Flexible**: New windows automatically receive events
- **Robust**: No broken connections when windows close
- **Type-based filtering**: Receivers filter by `selection.type`

### Why parent relay?

- **Centralized**: Single point of message routing
- **Secure**: Parent controls which iframes can communicate
- **Observable**: Easy to add logging/debugging
- **Extensible**: Can add features like persistence, history

## Debugging

### Console Logging

The SelectionContext logs all selection events:
```
[SelectionContext] Received selection from iframe: {type: 'row', ids: [...]}
[SelectionContext] Registered iframe for window abc123
[SelectionContext] Unregistered iframe for window abc123
```

### Testing Manually

Open browser console and send a test message:
```javascript
// From parent frame
window.postMessage({ type: 'SELECTION', selection: { type: 'test', ids: ['1'] } }, '*')
```

### Common Issues

1. **Message not received**: Check if iframe is registered in SelectionContext
2. **Wrong type**: Ensure `type: 'SELECTION'` (not `SELECTION_BROADCAST`)
3. **No data**: Verify `selection` object is included in the message
4. **Sender receives own message**: The relay filters out the sender

## Conversation Continuity

Each RouteWindow maintains a continuous conversation with its AI agent via `session_id`.

### How It Works

1. **First message**: No session_id, agent starts fresh conversation
2. **Agent responds**: Emits `session_init` event with new session_id
3. **FilePoller captures**: Stores session_id in `conversation_sessions` dict
4. **After completion**: Route handler saves session_id to window model
5. **Next message**: Passes session_id to agent, which resumes conversation

```
Message 1: "Build a todo app"
  → Agent creates todo app (new session)
  → session_id = "abc123" captured

Message 2: "Add a delete button"
  → Agent resumes session "abc123"
  → Knows context: "the todo app I just built"
  → Adds delete button to existing app
```

### Key Files for Session Management

| Component | Location |
|-----------|----------|
| Session storage | `window_session_ids` dict in `route_windows_fastapi.py` |
| Session capture | FilePoller → `conversation_sessions` → window update |
| Session resume | `run_agent(..., session_id=window.session_id)` |

## File Locations

| File | Purpose |
|------|---------|
| `frontend/src/context/SelectionContext.jsx` | Parent relay for postMessage |
| `frontend/src/components/RouteWindow/RouteWindow.jsx` | Iframe registration |
| `frontend/src/components/DeriveWindowModal/DeriveWindowModal.jsx` | Derive flow with messaging |
| `chatbot_web/routes/route_windows_fastapi.py` | AI system prompt with messaging instructions |
| `chatbot_web/models/route_window.py` | RouteWindowRecord model with session_id field |
