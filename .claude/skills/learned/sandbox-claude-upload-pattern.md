# Sandbox .claude Directory Upload Pattern

**Extracted:** 2025-02-04
**Context:** Uploading skill files, modules, and agent contexts to an e2b sandbox

## Problem

When building systems that run Claude agents inside sandboxes (e2b), you need to provide skill files, templates, and modules to the sandbox environment. Key challenges:

1. **Permission errors** - Root paths like `/.claude/` are not writable by sandbox user
2. **Separation of concerns** - Local `.claude/` (for your machine) vs sandbox `.claude/` (uploaded to sandbox)
3. **Path consistency** - Files reference paths that must exist in the sandbox

## Solution

### Directory Structure

Keep two separate directories:

```
project/
├── .claude/                          # LOCAL - for Claude Code on your machine
│   └── skills/create-mcp-app/
│       └── SKILL.md                  # References sandbox paths
│
└── chatbot_web/assets/sandbox-claude/  # SOURCE - gets uploaded to sandbox
    └── skills/create-mcp-app/
        ├── SKILL.md
        ├── agents/
        └── modules/
```

### Upload Target

Upload to **workspace directory**, not root:

```python
# WRONG - permission denied
target_base = "/.claude"

# CORRECT - user has write permission
target_base = f"{workdir}/.claude"  # e.g., /home/user/workspace/.claude
```

### Upload Function Pattern

```python
async def _upload_sandbox_claude(sandbox: AsyncSandbox, workdir: str) -> None:
    """Upload sandbox-claude assets to {workdir}/.claude/ in the sandbox."""
    assets_dir = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "assets", "sandbox-claude"
    )
    target_base = f"{workdir}/.claude"

    if not os.path.exists(assets_dir):
        logger.warning("sandbox-claude assets not found: %s", assets_dir)
        return

    # Walk and upload all files
    for root, dirs, files in os.walk(assets_dir):
        rel_root = os.path.relpath(root, assets_dir)
        target_dir = target_base if rel_root == "." else f"{target_base}/{rel_root}"

        await sandbox.commands.run(f"mkdir -p '{target_dir}'", timeout=10)

        for filename in files:
            local_path = os.path.join(root, filename)
            target_path = f"{target_dir}/{filename}"
            with open(local_path, "r") as f:
                content = f.read()
            await sandbox.files.write(target_path, content)

    logger.info("✓ Uploaded %s/.claude/ to sandbox", workdir)
```

### Path References in Skill Files

All paths in uploaded skill files must use the sandbox workspace path:

```markdown
# In sandbox-claude/skills/create-mcp-app/SKILL.md

## Copy modules:
cp -r /home/user/workspace/.claude/skills/create-mcp-app/modules/base/* ./

## Check registry:
cat /home/user/workspace/.claude/skills/create-mcp-app/modules/tools/registry.json
```

## When to Use

- Building multi-agent systems that run in sandboxes
- Providing skill contexts, templates, or modules to sandbox agents
- Any system where local development files need to be available in a sandbox environment

## Key Rules

1. **Never use root paths** - Always use workspace-relative paths
2. **Keep source separate** - `assets/sandbox-claude/` for uploaded content
3. **Sync if needed** - Copy SKILL.md to local `.claude/` if it should match
4. **Update all references** - When changing paths, update all files that reference them
