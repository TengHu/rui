---
id: sandbox-ssh-debugging
trigger: "when user wants to debug, inspect, or manually interact with an E2B sandbox"
confidence: 0.9
domain: e2b-sandbox
source: local-implementation
created: 2025-02-04
---

# Use sandbox_ssh.py for Interactive Sandbox Debugging

## Trigger Conditions

- User mentions "SSH into sandbox"
- User wants to "debug" a sandbox
- User needs to "inspect" sandbox state
- User wants "terminal access" to sandbox
- Agent behavior needs manual investigation
- User asks to "log into" or "connect to" sandbox

## Action

1. **List available sandboxes** if ID not provided:
   ```bash
   python sandbox_ssh.py --list
   ```

2. **Connect to sandbox**:
   ```bash
   python sandbox_ssh.py <sandbox_id>
   ```

3. **Common debugging commands** once connected:
   - Check processes: `ps aux`
   - View logs: `cat /tmp/events.jsonl` or `cat /tmp/events_<window_id>.jsonl`
   - View agent debug log: `cat /tmp/agent_debug.log`
   - View MCP server log: `cat /tmp/mcp-server.log`
   - View MCP app logs: `ls -la /tmp/mcp-apps/`
   - View window events: `ls -la /tmp/.window-events/`
   - Check files: `ls -la /home/user/workspace/`
   - Test MCP: `curl localhost:3000/health`

## Exit

Press **Ctrl+]** to disconnect cleanly.

## Evidence

- Script tested successfully against running E2B sandbox
- Uses E2B PTY API for full terminal emulation
- Supports terminal resize, colors, and interactive programs
