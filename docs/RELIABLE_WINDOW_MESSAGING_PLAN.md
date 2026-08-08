# Reliable Window Messaging System - Design Document

## Overview

This document describes the design for a reliable cross-window messaging system to replace the brittle `SelectionContext.jsx` implementation.

## Problem Statement

The current `SelectionContext.jsx` uses a simple postMessage relay pattern with several brittleness issues:

### Current Issues

1. **Race Conditions**
   - Iframes can send `SELECTION` messages before registration completes (line 46-51 in RouteWindow.jsx)
   - Early messages are dropped because iframe isn't in `iframeRefsRef.current` yet

2. **No Acknowledgment**
   - Fire-and-forget semantics - messages sent but never verified delivered
   - Failures silently swallowed with console warnings

3. **No Handshake Protocol**
   - Windows assumed ready immediately after iframe mounts
   - No explicit connection lifecycle

4. **AI-Generation Dependency**
   - Derived windows must be correctly coded by AI to communicate
   - No runtime validation that apps implement required messaging

5. **No Message Queuing**
   - Messages to unready windows are lost
   - No buffering or retry logic

---

## Solution: MessageBus Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     PARENT FRAME (Desktop)                      │
│                                                                 │
│   MessageBusContext (reliable relay)                            │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  WindowRegistry                                          │   │
│   │  - windowId -> {status: 'connecting'|'ready', iframe}   │   │
│   │  - pendingMessages: Map<windowId, Message[]>            │   │
│   │                                                          │   │
│   │  HandshakeManager                                        │   │
│   │  - Tracks connection state per window                   │   │
│   │  - Implements 3-way handshake (CONNECT/ACK/READY)       │   │
│   │                                                          │   │
│   │  MessageQueue                                            │   │
│   │  - Queues messages for unready windows                  │   │
│   │  - TTL-based expiration (default 30 seconds)            │   │
│   │                                                          │   │
│   │  SubscriptionManager                                     │   │
│   │  - topic -> Set<windowId> subscriptions                 │   │
│   │  - Supports targeted and broadcast delivery             │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│         ┌────────────────┼────────────────┐                     │
│         ▼                ▼                ▼                     │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐                 │
│   │ Window A │    │ Window B │    │ Window C │                 │
│   │ (iframe) │    │ (iframe) │    │ (iframe) │                 │
│   │          │    │          │    │          │    SDK in each  │
│   │ [SDK]    │    │ [SDK]    │    │ [SDK]    │    iframe       │
│   └──────────┘    └──────────┘    └──────────┘                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Handshake Protocol

### 3-Way Handshake Sequence

```
┌─────────────┐                    ┌─────────────────┐
│   Iframe    │                    │ Parent (Desktop)│
└──────┬──────┘                    └────────┬────────┘
       │                                     │
       │ (iframe loads)                      │
       │                                     │
       │ ──── MB_CONNECT ──────────────────► │
       │                                     │
       │      "I'm loaded, ready to init"    │
       │                                     │
       │ ◄──── MB_CONNECT_ACK ─────────────  │
       │                                     │
       │      "I see you, your ID is X"      │
       │                                     │
       │ ──── MB_READY ────────────────────► │
       │                                     │
       │      "I'm ready to receive"         │
       │                                     │
       │ ◄──── (flush queued messages) ────  │
       │                                     │
       │      Connection established ✓       │
       │                                     │
```

### Protocol Message Types

```javascript
const MSG_TYPES = {
  // Handshake
  CONNECT: 'MB_CONNECT',        // Iframe -> Parent: "I'm loaded"
  CONNECT_ACK: 'MB_CONNECT_ACK', // Parent -> Iframe: "I see you, here's your ID"
  READY: 'MB_READY',            // Iframe -> Parent: "Ready to receive"

  // Data
  MESSAGE: 'MB_MESSAGE',        // Wrapped message delivery
  ACK: 'MB_ACK',                // Acknowledgment

  // Subscriptions
  SUBSCRIBE: 'MB_SUBSCRIBE',    // Iframe subscribes to topic(s)
  UNSUBSCRIBE: 'MB_UNSUBSCRIBE',

  // Lifecycle
  DISCONNECT: 'MB_DISCONNECT',  // Graceful disconnect
}
```

---

## Data Structures

### Message Envelope

```typescript
interface MessageEnvelope {
  id: string;              // UUID for deduplication
  type: string;            // 'SELECTION', 'DATA_UPDATE', 'CUSTOM', etc.
  topic?: string;          // Optional topic for subscription-based routing
  payload: any;            // The actual message data
  sourceWindowId: string;  // Sender window ID
  targetWindowId?: string; // Specific target (null = broadcast to subscribers)
  timestamp: number;       // For ordering
  requiresAck: boolean;    // Whether to wait for acknowledgment
  ttl?: number;            // Time-to-live in ms (default 30000)
}
```

### Window Connection State

```typescript
interface WindowConnection {
  windowId: string;
  iframe: HTMLIFrameElement | null;
  status: 'connecting' | 'ready' | 'disconnected';
  connectedAt?: number;
  subscriptions: Set<string>;  // Topics this window subscribes to
  pendingMessages: MessageEnvelope[];
  ackPending: Map<string, {message: MessageEnvelope, retries: number, timeout: NodeJS.Timeout}>;
}
```

---

## Client SDK (For AI-Generated Apps)

The SDK must be **dead simple** - this is critical for AI-generated code to use correctly.

### Simple API

```javascript
/**
 * WindowMessaging SDK - Simple API for cross-window communication
 *
 * Usage:
 *   // Wait for connection (optional - SDK auto-connects)
 *   await window.messaging.ready()
 *
 *   // Subscribe to topics
 *   window.messaging.subscribe('selection', (data) => {
 *     console.log('Received selection:', data)
 *   })
 *
 *   // Publish data
 *   window.messaging.publish('selection', { ids: [1, 2, 3] })
 */

window.messaging = {
  // Wait for connection to be ready
  ready(): Promise<void>,

  // Check if connected
  get isConnected(): boolean,

  // Get this window's ID
  get windowId(): string | null,

  // Subscribe to a topic (returns unsubscribe function)
  subscribe(topic: string, callback: Function): () => void,

  // Publish data to a topic
  publish(topic: string, data: any, options?: { targetWindowId?: string }): void,

  // Alias for publish
  send(topic: string, data: any, options?: object): void,

  // Graceful disconnect
  disconnect(): void,
}
```

### SDK Implementation Highlights

```javascript
(function() {
  'use strict';

  // Don't run if not in iframe
  if (window.parent === window) return;

  let windowId = null;
  let isReady = false;
  let readyPromise = new Promise(resolve => { readyResolve = resolve; });
  const subscriptions = new Map(); // topic -> Set<callback>

  // Listen for parent messages
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data?.type?.startsWith('MB_')) return;

    switch (data.type) {
      case 'MB_CONNECT_ACK':
        windowId = data.windowId;
        window.parent.postMessage({ type: 'MB_READY' }, '*');
        isReady = true;
        readyResolve();
        break;

      case 'MB_MESSAGE':
        handleIncomingMessage(data.envelope);
        break;
    }
  });

  // Auto-connect on load
  window.parent.postMessage({ type: 'MB_CONNECT' }, '*');

  // Public API exposed on window.messaging
  window.messaging = { ready, subscribe, publish, send, disconnect, ... };
})();
```

---

## Message Flow Examples

### Example 1: Window A publishes selection, Window B receives

```
Window A: window.messaging.publish('selection', { ids: [1, 2, 3] })
    ↓
    postMessage({ type: 'MB_MESSAGE', envelope: {...} })
    ↓
MessageBusContext receives
    ↓
    Looks up subscribers to 'selection' topic
    ↓
    Finds Window B subscribed
    ↓
    Delivers to Window B
    ↓
Window B: callback receives { ids: [1, 2, 3] }
```

### Example 2: Message to unready window (queuing)

```
Window A: window.messaging.publish('selection', data)
    ↓
MessageBusContext receives
    ↓
    Window B status = 'connecting' (not ready yet)
    ↓
    Queue message in Window B's pendingMessages
    ↓
[Later] Window B sends MB_READY
    ↓
MessageBusContext flushes pending messages to Window B
    ↓
Window B receives queued message
```

---

## Files to Create/Modify

### New Files

| File | Description |
|------|-------------|
| `chatbot_web/frontend/src/context/MessageBusContext.jsx` | Core message bus React context |
| `chatbot_web/frontend/public/messaging-sdk.js` | Client SDK for iframes |

### Files to Modify

| File | Changes |
|------|---------|
| `chatbot_web/frontend/src/App.jsx` | Replace `SelectionProvider` with `MessageBusProvider` |
| `chatbot_web/frontend/src/components/RouteWindow/RouteWindow.jsx` | Use `useMessageBus` instead of `useSelection` |
| `chatbot_web/routes/route_windows_fastapi.py` | Update AI system prompt with SDK docs |
| `chatbot_web/frontend/src/components/DeriveWindowModal/DeriveWindowModal.jsx` | Update prompts to use new SDK |

### Files to Delete (After Migration)

| File | Reason |
|------|--------|
| `chatbot_web/frontend/src/context/SelectionContext.jsx` | Replaced by MessageBusContext |

---

## AI System Prompt Updates

Update `route_windows_fastapi.py` to include SDK documentation:

```python
WEB_SYSTEM_PROMPT_TEMPLATE = """...

## Cross-Window Communication (IMPORTANT)

Your app includes a messaging SDK. Use it to communicate with other windows:

INITIALIZATION (already done for you):
The SDK auto-connects when your app loads. Optionally wait for ready state:
```javascript
await window.messaging.ready()
```

TO RECEIVE data from other windows:
```javascript
window.messaging.subscribe('selection', (data) => {
  console.log('Received:', data)
  // data.ids - selected IDs
  // data.type - selection type
  // Update your UI here
})
```

TO BROADCAST data to other windows:
```javascript
window.messaging.publish('selection', {
  type: 'row',
  ids: [1, 2, 3],
  data: [...selectedItems]
})
```

The SDK handles all connection management, retries, and queuing automatically.
...
"""
```

---

## Migration Strategy

### Phase 1: Add New System (Non-Breaking)

1. Create `MessageBusContext.jsx`
2. Create `messaging-sdk.js`
3. Add `MessageBusProvider` alongside `SelectionProvider`
4. Update `RouteWindow.jsx` to register with both contexts

### Phase 2: Update AI Prompts

1. Update `route_windows_fastapi.py` system prompt
2. Update `DeriveWindowModal.jsx` prompts
3. New windows will use new SDK

### Phase 3: Backward Compatibility

1. MessageBusContext listens for legacy `SELECTION` messages
2. SDK translates `selection` topic to `SELECTION_BROADCAST` for old windows
3. Both patterns work simultaneously

### Phase 4: Deprecate Old System

1. Remove `SelectionContext.jsx`
2. Remove `SelectionProvider` from App.jsx
3. Remove legacy message handling

---

## Verification Plan

### Test Scenarios

1. **Basic communication**: Create two RouteWindows, publish from one, verify other receives
2. **Race condition**: Create window, immediately send message → should queue and deliver after ready
3. **Derive flow**: Use "Create related window", verify messaging works on first run
4. **Refresh resilience**: Refresh iframe, verify reconnects and receives messages
5. **Multiple subscribers**: Three windows subscribe to same topic, verify all receive

### Manual Testing Steps

1. Create a RouteWindow, build an app that publishes selections
2. Create a second RouteWindow, build an app that subscribes to selections
3. Interact with first app, verify second receives data
4. Refresh second window, verify it reconnects
5. Use "Derive" feature to create linked windows, verify communication works immediately

---

## Key Design Benefits

| Problem | Solution |
|---------|----------|
| Race conditions | 3-way handshake ensures window is truly ready |
| Lost messages | Queue messages for unready windows (30s TTL) |
| No ordering | Timestamps + ordered delivery per sender |
| Stale iframe refs | Registry with explicit lifecycle tracking |
| All-or-nothing broadcast | Topic-based subscriptions |
| AI coding errors | Dead-simple SDK: just `subscribe()` and `publish()` |
| Silent failures | Logging, connection state visibility |

---

## Future Enhancements

1. **Acknowledgment mode**: Optional `requiresAck: true` for guaranteed delivery with retry
2. **Persistent subscriptions**: Remember subscriptions across iframe refreshes
3. **Message history**: Allow new windows to request recent messages on connect
4. **Typed channels**: Schema validation for message payloads
5. **Debug panel**: Visual inspector for message flow and connection states
