---
name: create-mcp-app
description: Create MCP Apps for RouteWindow - interactive UIs with bidirectional MCP communication. Use when user asks for interactive apps with tool calls, real-time updates, or rich UI controls.
---

# Create MCP App (Conversational)

Build interactive MCP apps through a conversational, iterative process.

## Two-Phase Workflow

```
Phase 1: UI Builder Agent
├── Build UI using prebuilt modules
├── Register app (user sees it immediately)
├── Ask for feedback
└── Iterate until user is happy

Phase 2: Tool Implementer Agent
├── Ask user what tools the app needs
├── Check shared registry for existing tools
├── Create TOOLS.md listing all tools
├── Implement missing tools one by one
└── Re-register app with tools
```

---

## Phase 1: Build the UI

**Use the UI Builder Agent** via Task tool with `subagent_type: "ui-builder"`

### Steps

1. **Create app directory**: `mkdir -p /home/user/workspace/<app-name>`

2. **Copy prebuilt modules**:
   ```bash
   cp -r /home/user/workspace/.claude/skills/create-mcp-app/modules/base/* /home/user/workspace/<app-name>/
   ```

3. **Customize UI**: Edit `mcp-app.html` and `src/mcp-app.ts`

4. **Build and register**:
   ```bash
   npm install && npm run build
   curl -s -X POST http://localhost:3000/register \
     -H 'Content-Type: application/json' \
     -d '{"name":"<app-name>","appDir":"/home/user/workspace/<app-name>"}'
   ```

5. **Render via meta-tool**: After registration, call the meta-tool to display the app:
   ```
   mcp__app-server__app({ "name": "<app-name>" })
   ```
   This works even for apps registered during the current session.

6. **Show user and ask for feedback**

7. **Iterate** based on feedback

---

## Phase 2: Implement Tools

**Use the Tool Implementer Agent** via Task tool with `subagent_type: "tool-implementer"`

### Steps

1. **Ask user** what tools the app should have

2. **Check shared registry** at `/home/user/workspace/.claude/skills/create-mcp-app/modules/tools/registry.json`

3. **Create TOOLS.md** listing:
   - Tools to reuse from registry
   - Tools to create (with input/output specs)

4. **Implement each missing tool** in `/home/user/workspace/.claude/skills/create-mcp-app/modules/tools/`

5. **Update registry.json**

6. **Re-register app**

---

## Shared Tool Registry

Tools are shared across all apps at `/home/user/workspace/.claude/skills/create-mcp-app/modules/tools/`:

```
/home/user/workspace/.claude/skills/create-mcp-app/modules/tools/
├── sandbox-read.ts    # Pre-installed
├── sandbox-write.ts   # Pre-installed
├── sandbox-list.ts    # Pre-installed
├── sandbox-exec.ts    # Pre-installed
├── [custom-tool].ts   # Created by apps
└── registry.json      # Tool metadata
```

**Key Principle**: Check before creating. Reuse existing tools.

---

## Prebuilt Modules

Located at `/home/user/workspace/.claude/skills/create-mcp-app/modules/`:

```
/home/user/workspace/.claude/skills/create-mcp-app/modules/
├── base/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── mcp-app.html
│   └── src/
│       ├── app-init.ts
│       └── mcp-app.ts
└── tools/
    ├── sandbox-io.ts
    ├── sandbox-read.ts
    ├── sandbox-write.ts
    ├── sandbox-list.ts
    ├── sandbox-exec.ts
    └── registry.json
```

---

## Quick Reference

### App Class Pattern
```typescript
const app = new App({ name: "My App", version: "1.0.0" });
app.ontoolresult = (result) => { /* handle */ };
app.connect(); // AFTER handlers
```

### Tool Handler Pattern
```typescript
export const tool = { name: "my-tool", inputSchema: {...} };
export async function handler(args) {
  return { content: [{ type: "text", text: result }] };
}
```

### Registration
```bash
curl -s -X POST http://localhost:3000/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"app-name","appDir":"/home/user/workspace/app-name"}'
```

---

## When to Use

Use `create-mcp-app` for:
- Interactive applications with tool calls
- Real-time data updates
- Rich UI controls (charts, tables, forms)

