# Window App Composition - Design Document

## Problem Statement

Currently, composing multiple window apps requires manual orchestration:

1. User prompts App A: "Export this data to a CSV file"
2. User prompts App B: "Load that CSV file and visualize it"
3. Repeat for each step in the workflow...

This is tedious, error-prone, and doesn't scale. Users want window apps to be **composable primitives** that can be combined to build complex features.

---

## Goals

1. **Easy composition**: Users can combine window apps without manual file passing
2. **Natural orchestration**: Use natural language to coordinate multiple apps
3. **Reusable workflows**: Save and replay common compositions
4. **Self-contained apps**: Each window app remains independent and portable

---

## Inspiration

### Anthropic Agent SDK - Research Agent Pattern

The [claude-agent-sdk-demos](https://github.com/anthropics/claude-agent-sdk-demos) research agent demonstrates:

- **Coordinator pattern**: A main agent orchestrates multiple subagents
- **Parallel execution**: Subagents work independently on subtopics
- **Result synthesis**: Coordinator aggregates and combines results
- **Activity tracking**: Users see what each subagent is doing

This pattern maps well to window app composition:
- Main chat = Coordinator
- Window apps = Subagents
- MessageBus = Communication layer

---

## Proposed Solutions

### Solution 1: Data Contracts + Auto-Wiring

**Concept**: Each window app declares what data it produces and consumes. The system automatically suggests compatible connections.

#### App Manifest

```javascript
// Each window app declares its capabilities
window.appManifest = {
  name: 'Sales Chart',

  // What this app can output
  outputs: [
    { type: 'json-array', topic: 'selection', description: 'Selected data points' },
    { type: 'csv', topic: 'export', description: 'Full dataset export' }
  ],

  // What this app can receive
  inputs: [
    { type: 'json-array', topic: 'data', description: 'Data to visualize' },
    { type: 'filter', topic: 'filter', description: 'Filter criteria' }
  ],

  // Commands this app responds to
  commands: [
    { name: 'export', description: 'Export current view' },
    { name: 'highlight', params: ['ids'], description: 'Highlight specific items' }
  ]
}
```

#### UX Flow

1. User selects data in App A
2. Floating action button appears: "Send to..."
3. System shows compatible apps (those with matching input types)
4. User clicks App B → data flows automatically

#### Implementation

1. Apps register manifests on connect via MessageBus
2. Parent maintains registry of all app capabilities
3. UI shows smart suggestions based on compatibility
4. SelectionActionButton component triggers cross-app data flow

**Effort**: Low-Medium
**Impact**: High

---

### Solution 2: Main Chat as Coordinator Agent

**Concept**: The main chat window (outside individual windows) acts as an orchestrator that can address and coordinate multiple window apps.

#### Syntax

```
User: @chart-app export the current selection, then send it to @table-app for filtering

User: Take the data from "Sales Chart" window, filter by region='West', and visualize in "Map View"
```

#### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Main Chat (Coordinator)               │
│                                                         │
│  - Understands all window apps via registry             │
│  - Can send commands to any window via MessageBus       │
│  - Chains operations: App A → App B → App C             │
│  - Reports progress and results to user                 │
└─────────────────────────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
    ┌─────────┐   ┌─────────┐   ┌─────────┐
    │ Window  │   │ Window  │   │ Window  │
    │ App A   │   │ App B   │   │ App C   │
    └─────────┘   └─────────┘   └─────────┘
```

#### Command Protocol

```javascript
// Coordinator sends command to window app
window.messaging.publish('command', {
  action: 'export',
  params: { format: 'json' },
  replyTo: 'coordinator',
  requestId: 'abc123'
})

// Window app responds
window.messaging.publish('command-response', {
  requestId: 'abc123',
  status: 'success',
  data: [/* exported data */]
})
```

#### Benefits

- Natural language interface (what users already know)
- No new UI needed - leverages existing chat
- Can handle complex multi-step workflows
- Mirrors Agent SDK coordinator pattern

**Effort**: Medium
**Impact**: Very High

---

### Solution 3: Saved Workflows / Commands

**Concept**: Users define reusable workflows that orchestrate multiple window apps. These can be saved, shared, and replayed.

#### Workflow Definition

```yaml
name: weekly-sales-report
description: Generate weekly sales report from raw data

steps:
  - window: data-source
    action: query
    params:
      sql: "SELECT * FROM sales WHERE date >= DATE_SUB(NOW(), INTERVAL 7 DAY)"
    output: $raw_data

  - window: transform-app
    action: aggregate
    input: $raw_data
    params:
      groupBy: region
      metrics: [sum:revenue, count:orders]
    output: $aggregated

  - window: chart-app
    action: render
    input: $aggregated
    params:
      type: bar
      x: region
      y: revenue

  - window: export-app
    action: pdf
    params:
      title: "Weekly Sales Report"
      include: [chart-app, transform-app]
```

#### UX

```
User: /run weekly-sales-report
System: Running workflow "weekly-sales-report"...
        ✓ Step 1: Queried data source (1,247 rows)
        ✓ Step 2: Aggregated by region (5 groups)
        ✓ Step 3: Rendered bar chart
        ✓ Step 4: Generated PDF report
        Done! PDF saved to ~/reports/weekly-sales-2024-01-20.pdf
```

#### Benefits

- Reproducible workflows
- Can be shared between users
- Version controlled
- Self-documenting

**Effort**: Medium-High
**Impact**: High

---

### Solution 4: Visual Flow Builder

**Concept**: A visual canvas where users drag window apps and connect them with wires. Data flows along the connections.

#### UI Mockup

```
┌─────────────────────────────────────────────────────────┐
│  Flow Builder                                    [Save] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌──────────┐       ┌───────────┐       ┌──────────┐  │
│   │ CSV      │──────▶│ Filter    │──────▶│ Bar      │  │
│   │ Import   │       │ Transform │       │ Chart    │  │
│   └──────────┘       └───────────┘       └──────────┘  │
│        │                                      │         │
│        │             ┌───────────┐            │         │
│        └────────────▶│ Table     │◀───────────┘         │
│                      │ View      │                      │
│                      └───────────┘                      │
│                                                         │
│  [+ Add App]                                            │
└─────────────────────────────────────────────────────────┘
```

#### Implementation

- React Flow or similar library for the canvas
- Nodes = window apps (or app templates)
- Edges = data connections
- Double-click node to open full window app

#### Benefits

- Highly visual and intuitive
- Good for complex multi-branch workflows
- Users can see the full pipeline at a glance

**Effort**: High
**Impact**: Medium (nice-to-have, not essential)

---

## Recommended Implementation Order

| Phase | Feature | Effort | Impact | Dependencies |
|-------|---------|--------|--------|--------------|
| 0 | **Complete MessageBus** | Medium | Required | - |
| 1 | **App Manifests** | Low | High | MessageBus |
| 2 | **Smart Send-To Suggestions** | Low | High | App Manifests |
| 3 | **Main Chat Coordinator** | Medium | Very High | MessageBus, Manifests |
| 4 | **Saved Workflows** | Medium | High | Coordinator |
| 5 | **Visual Flow Builder** | High | Medium | All above |

---

## Phase 1: App Manifests (Detailed)

### Changes Required

#### 1. Extend MessageBus Protocol

```javascript
// New message types
const MSG_TYPES = {
  // ... existing types

  // Manifest exchange
  MANIFEST_REGISTER: 'MB_MANIFEST_REGISTER',  // App registers its capabilities
  MANIFEST_QUERY: 'MB_MANIFEST_QUERY',        // Request all registered manifests

  // Commands
  COMMAND: 'MB_COMMAND',                      // Send command to app
  COMMAND_RESPONSE: 'MB_COMMAND_RESPONSE',    // App responds to command
}
```

#### 2. Update SDK

```javascript
window.messaging = {
  // ... existing methods

  // Register app capabilities
  registerManifest(manifest) { ... },

  // Handle incoming commands
  onCommand(handler) { ... },

  // Respond to a command
  respondToCommand(requestId, result) { ... },
}
```

#### 3. Parent Registry

```javascript
// In MessageBusContext.jsx
const [appRegistry, setAppRegistry] = useState(new Map())

// Structure:
// windowId -> {
//   manifest: { name, inputs, outputs, commands },
//   status: 'ready',
//   connectedAt: timestamp
// }
```

#### 4. AI System Prompt Update

```
When building apps, register a manifest to enable composition:

window.messaging.registerManifest({
  name: 'My Data App',
  outputs: [{ type: 'json-array', topic: 'selection' }],
  inputs: [{ type: 'json-array', topic: 'data' }],
  commands: [
    { name: 'export', description: 'Export data' },
    { name: 'filter', params: ['criteria'], description: 'Filter data' }
  ]
})

Handle commands:
window.messaging.onCommand((cmd) => {
  if (cmd.action === 'export') {
    const data = getExportData()
    window.messaging.respondToCommand(cmd.requestId, { data })
  }
})
```

---

## Phase 2: Main Chat Coordinator (Detailed)

### Architecture

```
┌────────────────────────────────────────────────────────────┐
│                      Main Chat Agent                        │
│                                                            │
│  Tools available:                                          │
│  - list_windows() -> [{id, name, manifest}]               │
│  - send_command(windowId, action, params) -> result        │
│  - get_window_data(windowId) -> current state             │
│  - create_window(spec) -> windowId                        │
│                                                            │
│  Agent can:                                                │
│  - Parse user intent ("send chart data to table")         │
│  - Resolve window references ("the chart" -> window-123)  │
│  - Chain commands across windows                          │
│  - Report progress and results                            │
└────────────────────────────────────────────────────────────┘
```

### Example Interaction

```
User: Take the selected data from my sales chart and show it in the table view

Agent thinking:
1. User wants to transfer data between windows
2. "sales chart" likely refers to window with name containing "sales" and "chart"
3. "table view" likely refers to window with table capabilities
4. Need to: export from source, import to target

Agent actions:
1. list_windows() -> finds "Sales Chart" (id: w1) and "Data Table" (id: w2)
2. send_command(w1, 'export', {format: 'json'}) -> gets data
3. send_command(w2, 'import', {data: ...}) -> loads into table

Agent response:
"Done! I've transferred 47 data points from Sales Chart to Data Table."
```

---

## Open Questions

1. **Error handling**: What happens when a window app doesn't respond to a command?
2. **Type coercion**: How to handle format mismatches (CSV app → JSON app)?
3. **Permissions**: Should some commands require user confirmation?
4. **Persistence**: Should workflows survive browser refresh?
5. **Versioning**: How to handle manifest changes when apps are updated?

---

## References

- [Anthropic Agent SDK Demos](https://github.com/anthropics/claude-agent-sdk-demos)
- [MessageBus Design Doc](./RELIABLE_WINDOW_MESSAGING_PLAN.md)
- [Window Messaging Overview](./WINDOW_MESSAGING.md)
- [Node-RED](https://nodered.org/) - Visual flow-based programming
- [n8n](https://n8n.io/) - Workflow automation
