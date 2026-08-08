# Spatial Desktop Composable Windows — Implementation Plan

## Overview

This plan transforms the existing React + Flask desktop environment into a **spatial composable windows system** where users create software through natural language prompts and operate windows via direct manipulation.

**Current State**: Working React + Flask desktop with drag/resize windows, SSE events, E2B sandbox integration
**Target State**: WindowSpec-driven composable windows with AI-powered creation and derivation

---

## Decision: Backend Stack

**Recommendation: Extend Flask (Python) rather than migrate to Node.js**

Rationale:
- Existing Flask backend is functional and well-structured
- Agent integration (Claude) already works in Python
- Faster path to demo (no migration overhead)
- Can migrate to Node.js later if needed

For TypeScript benefits, we'll add **Pydantic** for strict schema validation.

---

## Phase 1: Core Data Models & Schema (Days 1-2)

### 1.1 Define WindowSpec Schema

Create `/chatbot_web/models/window_spec.py`:

```python
from pydantic import BaseModel
from typing import List, Dict, Optional, Any, Literal
from datetime import datetime
import uuid

# UI Element Types
class UIElement(BaseModel):
    type: Literal["text", "input", "button", "list", "table", "panel", "stack"]
    id: str
    props: Dict[str, Any] = {}
    children: Optional[List["UIElement"]] = None
    actionId: Optional[str] = None  # Reference to action registry

UIElement.model_rebuild()

# Action Definition
class ActionDef(BaseModel):
    id: str
    type: Literal["add_item", "remove_item", "update_state", "spawn_window", "open_details"]
    config: Dict[str, Any] = {}

# WindowSpec (declarative UI definition)
class WindowSpec(BaseModel):
    title: str
    ui: List[UIElement]
    actions: Dict[str, ActionDef] = {}

# WindowState (runtime data)
class WindowState(BaseModel):
    data: Dict[str, Any] = {}  # User data (items, rows, etc.)
    selection: Optional[str] = None
    filters: Dict[str, Any] = {}

# Binding to source window
class WindowBinding(BaseModel):
    sourceWindowId: str
    inputKey: str
    transform: Optional[str] = None  # e.g., "countDuplicates"

# Full WindowRecord
class WindowRecord(BaseModel):
    id: str
    title: str
    spec: WindowSpec
    specVersion: str = "1.0.0"
    state: WindowState = WindowState()
    bindings: Optional[WindowBinding] = None
    createdAt: datetime
    updatedAt: datetime

    @classmethod
    def create(cls, spec: WindowSpec) -> "WindowRecord":
        now = datetime.utcnow()
        return cls(
            id=f"win_{uuid.uuid4().hex[:8]}",
            title=spec.title,
            spec=spec,
            state=WindowState(),
            createdAt=now,
            updatedAt=now
        )
```

### 1.2 Create In-Memory Window Store

Create `/chatbot_web/stores/window_store.py`:

```python
from typing import Dict, Optional, List
from models.window_spec import WindowRecord
import threading

class WindowStore:
    def __init__(self):
        self._windows: Dict[str, WindowRecord] = {}
        self._lock = threading.Lock()

    def get(self, window_id: str) -> Optional[WindowRecord]:
        return self._windows.get(window_id)

    def get_all(self) -> List[WindowRecord]:
        return list(self._windows.values())

    def create(self, record: WindowRecord) -> WindowRecord:
        with self._lock:
            self._windows[record.id] = record
        return record

    def update(self, window_id: str, **updates) -> Optional[WindowRecord]:
        with self._lock:
            if window_id not in self._windows:
                return None
            record = self._windows[window_id]
            for key, value in updates.items():
                setattr(record, key, value)
            record.updatedAt = datetime.utcnow()
        return record

    def delete(self, window_id: str) -> bool:
        with self._lock:
            if window_id in self._windows:
                del self._windows[window_id]
                return True
        return False

# Singleton instance
window_store = WindowStore()
```

### 1.3 Create Action Registry

Create `/chatbot_web/stores/action_registry.py`:

```python
from typing import Dict, Callable, Any
from models.window_spec import WindowRecord, WindowState

ActionHandler = Callable[[WindowRecord, Dict[str, Any]], WindowState]

class ActionRegistry:
    def __init__(self):
        self._handlers: Dict[str, ActionHandler] = {}
        self._register_defaults()

    def _register_defaults(self):
        """Register built-in action handlers"""
        self.register("add_item", self._add_item)
        self.register("remove_item", self._remove_item)
        self.register("update_field", self._update_field)
        self.register("clear_list", self._clear_list)

    def register(self, action_type: str, handler: ActionHandler):
        self._handlers[action_type] = handler

    def execute(self, action_type: str, window: WindowRecord, payload: Dict) -> WindowState:
        handler = self._handlers.get(action_type)
        if not handler:
            raise ValueError(f"Unknown action type: {action_type}")
        return handler(window, payload)

    # Default handlers
    def _add_item(self, window: WindowRecord, payload: Dict) -> WindowState:
        key = payload.get("key", "items")
        value = payload.get("value")
        items = window.state.data.get(key, [])
        items.append(value)
        window.state.data[key] = items
        return window.state

    def _remove_item(self, window: WindowRecord, payload: Dict) -> WindowState:
        key = payload.get("key", "items")
        index = payload.get("index")
        items = window.state.data.get(key, [])
        if 0 <= index < len(items):
            items.pop(index)
        return window.state

    def _update_field(self, window: WindowRecord, payload: Dict) -> WindowState:
        key = payload.get("key")
        value = payload.get("value")
        window.state.data[key] = value
        return window.state

    def _clear_list(self, window: WindowRecord, payload: Dict) -> WindowState:
        key = payload.get("key", "items")
        window.state.data[key] = []
        return window.state

action_registry = ActionRegistry()
```

### Deliverables Phase 1:
- [ ] `models/window_spec.py` - Pydantic schemas
- [ ] `stores/window_store.py` - In-memory window storage
- [ ] `stores/action_registry.py` - Action handlers
- [ ] Unit tests for models and stores

---

## Phase 2: Backend API Endpoints (Days 2-3)

### 2.1 Window CRUD Endpoints

Add to `/chatbot_web/app.py` (or create `/chatbot_web/routes/windows.py`):

```python
from flask import Blueprint, request, jsonify
from stores.window_store import window_store
from stores.action_registry import action_registry
from models.window_spec import WindowRecord, WindowSpec
from services.spec_generator import generate_spec

windows_bp = Blueprint('windows', __name__, url_prefix='/api/windows')

@windows_bp.route('', methods=['GET'])
def get_all_windows():
    """Get all windows (snapshot)"""
    windows = window_store.get_all()
    return jsonify([w.model_dump() for w in windows])

@windows_bp.route('', methods=['POST'])
def create_window():
    """Create window from prompt"""
    data = request.json
    prompt = data.get('prompt')

    # Generate spec from prompt using AI
    spec = generate_spec(prompt)

    # Create window record
    record = WindowRecord.create(spec)
    window_store.create(record)

    # Emit WebSocket event
    emit_window_event('window_created', record)

    return jsonify(record.model_dump()), 201

@windows_bp.route('/<window_id>', methods=['GET'])
def get_window(window_id: str):
    """Get single window"""
    window = window_store.get(window_id)
    if not window:
        return jsonify({'error': 'Window not found'}), 404
    return jsonify(window.model_dump())

@windows_bp.route('/<window_id>/action', methods=['POST'])
def execute_action(window_id: str):
    """Execute action on window"""
    window = window_store.get(window_id)
    if not window:
        return jsonify({'error': 'Window not found'}), 404

    data = request.json
    action_id = data.get('actionId')
    payload = data.get('payload', {})

    # Get action definition from spec
    action_def = window.spec.actions.get(action_id)
    if not action_def:
        return jsonify({'error': 'Action not found'}), 404

    # Execute action
    new_state = action_registry.execute(action_def.type, window, payload)
    window_store.update(window_id, state=new_state)

    # Emit update event
    emit_window_event('window_updated', window)

    return jsonify(window.model_dump())

@windows_bp.route('/<window_id>/derive', methods=['POST'])
def derive_window(window_id: str):
    """Create derived window from source"""
    source = window_store.get(window_id)
    if not source:
        return jsonify({'error': 'Source window not found'}), 404

    data = request.json
    prompt = data.get('prompt')

    # Generate derived spec
    spec = generate_derived_spec(source, prompt)

    # Create with binding
    record = WindowRecord.create(spec)
    record.bindings = WindowBinding(
        sourceWindowId=source.id,
        inputKey=data.get('inputKey', 'items')
    )
    window_store.create(record)

    emit_window_event('window_created', record)

    return jsonify(record.model_dump()), 201
```

### 2.2 WebSocket Events

Add `/chatbot_web/services/event_bus.py`:

```python
from flask_socketio import SocketIO, emit
from models.window_spec import WindowRecord

socketio = SocketIO(cors_allowed_origins="*")

def emit_window_event(event_type: str, window: WindowRecord):
    """Broadcast window event to all clients"""
    socketio.emit(event_type, window.model_dump())

def init_socketio(app):
    socketio.init_app(app)

    @socketio.on('connect')
    def handle_connect():
        # Send current state on connect
        from stores.window_store import window_store
        windows = window_store.get_all()
        emit('snapshot', [w.model_dump() for w in windows])
```

### Deliverables Phase 2:
- [ ] `routes/windows.py` - REST endpoints
- [ ] `services/event_bus.py` - WebSocket integration
- [ ] Update `app.py` to register blueprint and socketio
- [ ] API documentation

---

## Phase 3: AI Spec Generator (Days 3-4)

### 3.1 Spec Generator Service

Create `/chatbot_web/services/spec_generator.py`:

```python
import anthropic
import json
from models.window_spec import WindowSpec, UIElement, ActionDef

client = anthropic.Anthropic()

SPEC_SYSTEM_PROMPT = """You are a WindowSpec generator. Given a user request, output a valid WindowSpec JSON.

Available UI element types:
- text: Display text. Props: content (string)
- input: Text input. Props: placeholder, key (state key to bind)
- button: Clickable button. Props: label, actionId
- list: Display list of items. Props: itemsKey (state key), renderTemplate
- table: Display tabular data. Props: columns, dataKey
- panel: Container. Props: direction (row|column)
- stack: Vertical stack of elements

Available action types:
- add_item: Add item to list. Config: key
- remove_item: Remove item from list. Config: key
- update_field: Update state field. Config: key
- spawn_window: Create new window. Config: prompt
- open_details: Open detail view. Config: template

Output ONLY valid JSON matching WindowSpec schema. No markdown, no explanation."""

def generate_spec(prompt: str) -> WindowSpec:
    """Generate WindowSpec from natural language prompt"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2000,
        system=SPEC_SYSTEM_PROMPT,
        messages=[
            {"role": "user", "content": f"Create a window for: {prompt}"}
        ]
    )

    spec_json = json.loads(response.content[0].text)
    return WindowSpec.model_validate(spec_json)

def generate_derived_spec(source: "WindowRecord", prompt: str) -> WindowSpec:
    """Generate spec that derives from source window"""

    context = f"""Source window: {source.spec.title}
Source state keys: {list(source.state.data.keys())}
Source UI elements: {[e.type for e in source.spec.ui]}

User wants: {prompt}"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2000,
        system=SPEC_SYSTEM_PROMPT + "\n\nThis is a DERIVED window. It should reference the source window's data.",
        messages=[
            {"role": "user", "content": context}
        ]
    )

    spec_json = json.loads(response.content[0].text)
    return WindowSpec.model_validate(spec_json)
```

### 3.2 Fallback Templates

Create `/chatbot_web/services/spec_templates.py`:

```python
from models.window_spec import WindowSpec, UIElement, ActionDef

TEMPLATES = {
    "feedback_collector": WindowSpec(
        title="Feedback Collector",
        ui=[
            UIElement(type="panel", id="main", props={"direction": "column"}, children=[
                UIElement(type="input", id="input", props={"placeholder": "Enter feedback...", "key": "currentInput"}),
                UIElement(type="button", id="add", props={"label": "Add", "actionId": "add_feedback"}),
                UIElement(type="list", id="list", props={"itemsKey": "items"})
            ])
        ],
        actions={
            "add_feedback": ActionDef(id="add_feedback", type="add_item", config={"key": "items"})
        }
    ),

    "counter": WindowSpec(
        title="Counter",
        ui=[
            UIElement(type="panel", id="main", props={"direction": "column"}, children=[
                UIElement(type="text", id="count", props={"content": "{{count}}"}),
                UIElement(type="button", id="inc", props={"label": "+", "actionId": "increment"})
            ])
        ],
        actions={
            "increment": ActionDef(id="increment", type="update_field", config={"key": "count", "increment": 1})
        }
    )
}

def get_fallback_template(prompt: str) -> WindowSpec:
    """Return best matching template based on prompt keywords"""
    prompt_lower = prompt.lower()

    if any(w in prompt_lower for w in ["feedback", "collect", "list", "items"]):
        return TEMPLATES["feedback_collector"]
    if any(w in prompt_lower for w in ["count", "counter", "increment"]):
        return TEMPLATES["counter"]

    # Default template
    return TEMPLATES["feedback_collector"]
```

### Deliverables Phase 3:
- [ ] `services/spec_generator.py` - AI-powered spec generation
- [ ] `services/spec_templates.py` - Fallback templates
- [ ] Spec validation with error handling
- [ ] Tests for spec generation

---

## Phase 4: Frontend WindowSpec Renderer (Days 4-6)

### 4.1 UI Primitive Components

Create `/chatbot_web/frontend/src/components/Primitives/`:

```
Primitives/
├── index.js          # Export all primitives
├── Text.jsx
├── Input.jsx
├── Button.jsx
├── List.jsx
├── Table.jsx
├── Panel.jsx
└── Stack.jsx
```

**Text.jsx:**
```jsx
export function Text({ content, state }) {
  // Handle template interpolation {{key}}
  const rendered = content.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    state?.data?.[key] ?? ''
  );
  return <span className="spec-text">{rendered}</span>;
}
```

**Input.jsx:**
```jsx
import { useState } from 'react';

export function Input({ placeholder, stateKey, onAction, state }) {
  const [value, setValue] = useState(state?.data?.[stateKey] ?? '');

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && onAction) {
      onAction({ key: stateKey, value });
      setValue('');
    }
  };

  return (
    <input
      className="spec-input"
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
    />
  );
}
```

**Button.jsx:**
```jsx
export function Button({ label, actionId, onAction }) {
  return (
    <button
      className="spec-button"
      onClick={() => onAction?.({ actionId })}
    >
      {label}
    </button>
  );
}
```

**List.jsx:**
```jsx
export function List({ itemsKey, state, onAction }) {
  const items = state?.data?.[itemsKey] ?? [];

  return (
    <ul className="spec-list">
      {items.map((item, idx) => (
        <li key={idx} className="spec-list-item">
          {typeof item === 'object' ? JSON.stringify(item) : item}
          <button
            className="spec-list-remove"
            onClick={() => onAction?.({
              actionId: 'remove_item',
              payload: { key: itemsKey, index: idx }
            })}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
```

**Panel.jsx:**
```jsx
export function Panel({ direction = 'column', children }) {
  return (
    <div
      className="spec-panel"
      style={{
        display: 'flex',
        flexDirection: direction,
        gap: '8px'
      }}
    >
      {children}
    </div>
  );
}
```

### 4.2 WindowSpec Renderer

Create `/chatbot_web/frontend/src/components/SpecRenderer/SpecRenderer.jsx`:

```jsx
import { Text, Input, Button, List, Table, Panel, Stack } from '../Primitives';

const COMPONENT_MAP = {
  text: Text,
  input: Input,
  button: Button,
  list: List,
  table: Table,
  panel: Panel,
  stack: Stack,
};

export function SpecRenderer({ spec, state, onAction }) {
  const renderElement = (element) => {
    const Component = COMPONENT_MAP[element.type];

    if (!Component) {
      console.warn(`Unknown element type: ${element.type}`);
      return null;
    }

    const props = {
      ...element.props,
      key: element.id,
      state,
      onAction: (actionPayload) => {
        const actionId = element.actionId || actionPayload.actionId;
        onAction?.(actionId, actionPayload.payload || actionPayload);
      },
    };

    // Render children recursively
    if (element.children?.length) {
      return (
        <Component {...props}>
          {element.children.map(renderElement)}
        </Component>
      );
    }

    return <Component {...props} />;
  };

  return (
    <div className="spec-renderer">
      {spec.ui.map(renderElement)}
    </div>
  );
}
```

### 4.3 SpecWindow Component

Create `/chatbot_web/frontend/src/components/SpecWindow/SpecWindow.jsx`:

```jsx
import { useCallback } from 'react';
import { SpecRenderer } from '../SpecRenderer/SpecRenderer';
import { useWindowActions } from '../../hooks/useWindowActions';

export function SpecWindow({ windowRecord }) {
  const { executeAction } = useWindowActions(windowRecord.id);

  const handleAction = useCallback((actionId, payload) => {
    executeAction(actionId, payload);
  }, [executeAction]);

  return (
    <div className="spec-window">
      <SpecRenderer
        spec={windowRecord.spec}
        state={windowRecord.state}
        onAction={handleAction}
      />

      {/* Derive button */}
      <button
        className="derive-button"
        onClick={() => {/* Open derive modal */}}
      >
        Create from this...
      </button>
    </div>
  );
}
```

### 4.4 Hooks for Window Operations

Create `/chatbot_web/frontend/src/hooks/useWindowActions.js`:

```jsx
import { useCallback } from 'react';
import { useSpecWindows } from '../context/SpecWindowContext';

export function useWindowActions(windowId) {
  const { updateWindow } = useSpecWindows();

  const executeAction = useCallback(async (actionId, payload) => {
    const response = await fetch(`/api/windows/${windowId}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, payload })
    });

    if (response.ok) {
      const updated = await response.json();
      updateWindow(updated);
    }
  }, [windowId, updateWindow]);

  return { executeAction };
}
```

### Deliverables Phase 4:
- [ ] Primitive components (Text, Input, Button, List, Table, Panel, Stack)
- [ ] SpecRenderer component
- [ ] SpecWindow wrapper component
- [ ] useWindowActions hook
- [ ] CSS styling for primitives
- [ ] Integration with existing Window component

---

## Phase 5: State Management & WebSocket Integration (Days 6-7)

### 5.1 SpecWindow Context

Create `/chatbot_web/frontend/src/context/SpecWindowContext.jsx`:

```jsx
import { createContext, useContext, useReducer, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';

const SpecWindowContext = createContext(null);

const initialState = {
  windows: {},  // Map of windowId -> WindowRecord
  loading: true,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_SNAPSHOT':
      return {
        ...state,
        windows: Object.fromEntries(action.windows.map(w => [w.id, w])),
        loading: false,
      };
    case 'WINDOW_CREATED':
    case 'WINDOW_UPDATED':
      return {
        ...state,
        windows: { ...state.windows, [action.window.id]: action.window },
      };
    case 'WINDOW_DELETED':
      const { [action.windowId]: _, ...remaining } = state.windows;
      return { ...state, windows: remaining };
    default:
      return state;
  }
}

export function SpecWindowProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socket = useSocket();

  useEffect(() => {
    if (!socket) return;

    socket.on('snapshot', (windows) => {
      dispatch({ type: 'SET_SNAPSHOT', windows });
    });

    socket.on('window_created', (window) => {
      dispatch({ type: 'WINDOW_CREATED', window });
    });

    socket.on('window_updated', (window) => {
      dispatch({ type: 'WINDOW_UPDATED', window });
    });

    socket.on('window_deleted', ({ windowId }) => {
      dispatch({ type: 'WINDOW_DELETED', windowId });
    });

    return () => {
      socket.off('snapshot');
      socket.off('window_created');
      socket.off('window_updated');
      socket.off('window_deleted');
    };
  }, [socket]);

  const createWindow = async (prompt) => {
    const response = await fetch('/api/windows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    return response.json();
  };

  const deriveWindow = async (sourceId, prompt) => {
    const response = await fetch(`/api/windows/${sourceId}/derive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    return response.json();
  };

  const updateWindow = (window) => {
    dispatch({ type: 'WINDOW_UPDATED', window });
  };

  return (
    <SpecWindowContext.Provider value={{
      windows: Object.values(state.windows),
      windowsById: state.windows,
      loading: state.loading,
      createWindow,
      deriveWindow,
      updateWindow,
    }}>
      {children}
    </SpecWindowContext.Provider>
  );
}

export const useSpecWindows = () => useContext(SpecWindowContext);
```

### 5.2 Socket Hook

Create `/chatbot_web/frontend/src/hooks/useSocket.js`:

```jsx
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

export function useSocket() {
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    const newSocket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
    });

    newSocket.on('connect', () => {
      console.log('Socket connected');
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, []);

  return socket;
}
```

### Deliverables Phase 5:
- [ ] SpecWindowContext with reducer
- [ ] useSocket hook for WebSocket connection
- [ ] Real-time window sync
- [ ] Frontend/backend WebSocket integration

---

## Phase 6: Window Creation UX (Days 7-8)

### 6.1 Create Window Modal

Create `/chatbot_web/frontend/src/components/CreateWindowModal/CreateWindowModal.jsx`:

```jsx
import { useState } from 'react';
import { useSpecWindows } from '../../context/SpecWindowContext';

export function CreateWindowModal({ isOpen, onClose, sourceWindow = null }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const { createWindow, deriveWindow } = useSpecWindows();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setLoading(true);
    try {
      if (sourceWindow) {
        await deriveWindow(sourceWindow.id, prompt);
      } else {
        await createWindow(prompt);
      }
      onClose();
      setPrompt('');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>{sourceWindow ? 'Create from this window' : 'New Window'}</h2>
        {sourceWindow && (
          <p className="source-info">
            Deriving from: <strong>{sourceWindow.title}</strong>
          </p>
        )}
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={sourceWindow
              ? "What should the new window do with this data?"
              : "What should this window do?"
            }
            autoFocus
            disabled={loading}
          />
          <div className="modal-actions">
            <button type="button" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" disabled={loading || !prompt.trim()}>
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

### 6.2 Desktop Integration

Update existing Desktop component to render SpecWindows:

```jsx
// In Desktop.jsx
import { useSpecWindows } from '../../context/SpecWindowContext';
import { SpecWindow } from '../SpecWindow/SpecWindow';

function Desktop() {
  const { windows } = useSpecWindows();
  const [createModalOpen, setCreateModalOpen] = useState(false);

  return (
    <div className="desktop">
      {/* Existing windows */}

      {/* Spec-based windows */}
      {windows.map(windowRecord => (
        <Window key={windowRecord.id} windowData={windowRecord}>
          <SpecWindow windowRecord={windowRecord} />
        </Window>
      ))}

      {/* Create button */}
      <button
        className="create-window-button"
        onClick={() => setCreateModalOpen(true)}
      >
        +
      </button>

      <CreateWindowModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
      />
    </div>
  );
}
```

### Deliverables Phase 6:
- [ ] CreateWindowModal component
- [ ] DeriveWindowModal (or combined modal)
- [ ] Desktop integration with SpecWindows
- [ ] "+" button for new window creation
- [ ] "Create from this" context menu/button

---

## Phase 7: Derivation & Bindings (Days 8-9)

### 7.1 Transform Functions

Create `/chatbot_web/services/transforms.py`:

```python
from typing import Dict, Any, List
from collections import Counter

TRANSFORMS = {
    "identity": lambda data: data,
    "countDuplicates": count_duplicates,
    "filterNotEmpty": filter_not_empty,
    "sortAlpha": sort_alphabetically,
    "groupBy": group_by_field,
}

def count_duplicates(items: List[Any]) -> Dict[str, int]:
    """Count occurrences of each item"""
    if not items:
        return {}
    return dict(Counter(items))

def filter_not_empty(items: List[Any]) -> List[Any]:
    """Remove empty/null items"""
    return [i for i in items if i]

def sort_alphabetically(items: List[Any]) -> List[Any]:
    """Sort items alphabetically"""
    return sorted(items, key=str)

def group_by_field(items: List[Dict], field: str) -> Dict[str, List]:
    """Group items by a field value"""
    result = {}
    for item in items:
        key = item.get(field, 'unknown')
        result.setdefault(key, []).append(item)
    return result

def apply_transform(transform_name: str, data: Any, **kwargs) -> Any:
    """Apply named transform to data"""
    fn = TRANSFORMS.get(transform_name)
    if not fn:
        return data
    return fn(data, **kwargs) if kwargs else fn(data)
```

### 7.2 Binding Resolution

Create `/chatbot_web/services/binding_resolver.py`:

```python
from models.window_spec import WindowRecord, WindowBinding
from stores.window_store import window_store
from services.transforms import apply_transform

def resolve_bindings(window: WindowRecord) -> Dict[str, Any]:
    """Resolve window bindings to actual data"""
    if not window.bindings:
        return {}

    source = window_store.get(window.bindings.sourceWindowId)
    if not source:
        return {}

    source_data = source.state.data.get(window.bindings.inputKey, [])

    if window.bindings.transform:
        return {
            "boundData": apply_transform(window.bindings.transform, source_data)
        }

    return {"boundData": source_data}
```

### Deliverables Phase 7:
- [ ] Transform functions library
- [ ] Binding resolver
- [ ] Derived window state computation
- [ ] Auto-update derived windows when source changes

---

## Phase 8: Demo Polish (Days 9-10)

### 8.1 Demo Scenario Implementation

Ensure the following flow works smoothly:

1. **User clicks +** → "Collect customer feedback" prompt
2. **Window renders** with input + list
3. **User adds items** directly (type, press Enter)
4. **User clicks "Create from this"** → "Show repeated issues" prompt
5. **Derived window** shows counts
6. **Click item** → opens details window

### 8.2 Polish Tasks

- [ ] Smooth window animations (Framer Motion)
- [ ] Loading states for AI generation
- [ ] Error handling with user feedback
- [ ] Window focus management
- [ ] Keyboard shortcuts (Escape to close modal)
- [ ] Responsive sizing for spec content

### 8.3 CSS Styling

Create `/chatbot_web/frontend/src/components/Primitives/primitives.css`:

```css
.spec-renderer {
  padding: 16px;
  height: 100%;
  overflow: auto;
}

.spec-panel {
  display: flex;
  gap: 8px;
}

.spec-input {
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  width: 100%;
}

.spec-button {
  padding: 8px 16px;
  background: #4a90d9;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.spec-button:hover {
  background: #357abd;
}

.spec-list {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}

.spec-list-item {
  padding: 8px;
  background: #f5f5f5;
  border-radius: 4px;
  margin-bottom: 4px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.spec-list-remove {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  font-size: 18px;
}

.derive-button {
  position: absolute;
  bottom: 8px;
  right: 8px;
  font-size: 12px;
  padding: 4px 8px;
  background: #f0f0f0;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
}
```

### Deliverables Phase 8:
- [ ] Complete demo flow working
- [ ] Visual polish and animations
- [ ] Error handling throughout
- [ ] Performance optimization

---

## File Structure Summary

```
chatbot_web/
├── app.py                          # Update: register blueprints, socketio
├── models/
│   └── window_spec.py              # NEW: Pydantic schemas
├── stores/
│   ├── window_store.py             # NEW: In-memory storage
│   └── action_registry.py          # NEW: Action handlers
├── routes/
│   └── windows.py                  # NEW: REST API
├── services/
│   ├── event_bus.py                # NEW: WebSocket events
│   ├── spec_generator.py           # NEW: AI spec generation
│   ├── spec_templates.py           # NEW: Fallback templates
│   ├── transforms.py               # NEW: Data transforms
│   └── binding_resolver.py         # NEW: Binding resolution
├── requirements.txt                # Update: add pydantic, flask-socketio
└── frontend/
    ├── package.json                # Update: add socket.io-client
    └── src/
        ├── components/
        │   ├── Primitives/         # NEW: UI primitives
        │   ├── SpecRenderer/       # NEW: Spec interpreter
        │   ├── SpecWindow/         # NEW: Spec window wrapper
        │   └── CreateWindowModal/  # NEW: Creation UI
        ├── context/
        │   └── SpecWindowContext.jsx  # NEW: Spec state management
        └── hooks/
            ├── useSocket.js        # NEW: WebSocket hook
            └── useWindowActions.js # NEW: Action hook
```

---

## Dependencies to Add

### Backend (requirements.txt)
```
pydantic>=2.5.0
flask-socketio>=5.3.0
python-socketio>=5.10.0
```

### Frontend (package.json)
```json
{
  "dependencies": {
    "socket.io-client": "^4.7.0"
  }
}
```

---

## Timeline Summary

| Phase | Description | Days |
|-------|-------------|------|
| 1 | Data Models & Schema | 1-2 |
| 2 | Backend API Endpoints | 2-3 |
| 3 | AI Spec Generator | 3-4 |
| 4 | Frontend WindowSpec Renderer | 4-6 |
| 5 | State Management & WebSocket | 6-7 |
| 6 | Window Creation UX | 7-8 |
| 7 | Derivation & Bindings | 8-9 |
| 8 | Demo Polish | 9-10 |

**Total: ~10 working days for demo-ready implementation**

---

## Success Criteria

1. User can create a window with natural language prompt
2. Window renders correctly from generated spec
3. User can interact directly (add items, click buttons)
4. User can derive new windows from existing ones
5. Derived windows update when source data changes
6. WebSocket keeps all clients in sync
7. Demo scenario runs smoothly end-to-end

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| AI generates invalid specs | Schema validation + fallback templates |
| WebSocket connection issues | Fallback to polling, reconnection logic |
| Performance with many windows | Virtualization, lazy rendering |
| State sync conflicts | Server as source of truth, optimistic updates |
