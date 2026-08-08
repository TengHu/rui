---
name: sandbox-ssh
description: SSH into E2B sandboxes for interactive debugging via PTY interface
version: 1.0.0
command: sandbox-ssh
tags: [e2b, sandbox, ssh, debugging, pty, terminal]
---

# Sandbox SSH - Interactive E2B Debugging

Connect to running E2B sandboxes with an interactive terminal for debugging, inspection, and manual intervention.

## Quick Start

```bash
# List all running sandboxes
python sandbox_ssh.py --list

# Connect to a sandbox by ID
python sandbox_ssh.py <sandbox_id>

# Interactive sandbox selection
python sandbox_ssh.py
```

## Prerequisites

1. **E2B_API_KEY** must be set in environment (from `.env` file)
2. At least one running E2B sandbox

## Commands

### List Running Sandboxes

```bash
python sandbox_ssh.py --list
# or
python sandbox_ssh.py -l
```

Output:
```
ID                                       Template                  State
--------------------------------------------------------------------------------
iufd1m22v4w65fl53oh39                    gwir0qge2elav4fu56di      running

Total: 1 sandbox(es)
```

### Connect to Sandbox

```bash
# Direct connection
python sandbox_ssh.py <sandbox_id>

# With custom working directory
python sandbox_ssh.py <sandbox_id> --cwd /home/user/myproject

# Interactive selection (prompts for choice)
python sandbox_ssh.py
```

### Exit Session

Press **Ctrl+]** (Control + right bracket) to disconnect.

## Use Cases

### 1. Debug a Running Agent

When an agent in the sandbox behaves unexpectedly:

```bash
# Connect to the sandbox
python sandbox_ssh.py <sandbox_id>

# Inside sandbox: Check agent logs
cat /tmp/events.jsonl | tail -20

# Check agent debug log
cat /tmp/agent_debug.log

# Check running processes
ps aux | grep python

# Inspect files the agent created
ls -la /home/user/workspace/
```

### 2. Inspect MCP Server State

```bash
# Check if MCP server is running
curl -s http://localhost:3000/mcp

# View MCP server logs
cat /home/user/workspace/.mcp-server/server.log
```

### 3. Manual File Operations

```bash
# Edit a file manually
nano /home/user/workspace/config.json

# Install additional packages
pip install some-package

# Run tests manually
pytest /home/user/workspace/tests/
```

### 4. Network Debugging

```bash
# Check open ports
netstat -tlnp

# Test external connectivity
curl -I https://api.example.com

# Check DNS resolution
nslookup example.com
```

### 5. System Resource Check

```bash
# Memory usage
free -h

# Disk space
df -h

# CPU usage
top -bn1 | head -15
```

## Features

| Feature | Description |
|---------|-------------|
| **Full PTY emulation** | Colors, cursor movement, interactive programs |
| **Terminal resize** | Automatically adapts to window size changes |
| **Clean exit** | Ctrl+] exits cleanly without killing sandbox |
| **Multiple sessions** | Can have multiple SSH sessions to same sandbox |

## Troubleshooting

### "No running sandboxes found"

- Check that sandboxes are running: `python kill_all_sandboxes.py --dry-run`
- Verify E2B_API_KEY is set correctly
- Sandboxes may have timed out (default 1 hour)

### "Connection refused" or timeout

- Sandbox may be starting up, wait a few seconds
- Check sandbox status in E2B dashboard: https://e2b.dev/dashboard

### Terminal display issues

- Try resizing your terminal window
- Some programs may need `TERM=xterm-256color`

### Can't type or see output

- Ensure you're running in a real terminal (not a pipe)
- Try `stty sane` if terminal gets corrupted after crash

## Integration with Other Tools

### With sandbox_runner.py

```bash
# First, run an agent task
python sandbox_runner.py <sandbox_id> --query-file task.txt

# Then SSH in to inspect results
python sandbox_ssh.py <sandbox_id>
```

### With extend_sandbox_timeout.py

```bash
# Keep sandbox alive longer for debugging
python extend_sandbox_timeout.py <sandbox_id> 4  # 4 hours

# Then SSH in for extended debugging session
python sandbox_ssh.py <sandbox_id>
```

## API Reference

The script uses E2B's PTY API:

```python
from e2b_code_interpreter import AsyncSandbox
from e2b.sandbox.commands.command_handle import PtySize

# Connect to sandbox
sandbox = await AsyncSandbox.connect(sandbox_id="...")

# Create PTY with output callback
def on_data(data: bytes):
    sys.stdout.buffer.write(data)

pty = await sandbox.pty.create(
    size=PtySize(rows=24, cols=80),
    on_data=on_data,
    cwd="/home/user/workspace",
    timeout=0,  # No timeout
)

# Send input
await sandbox.pty.send_stdin(pty.pid, b"ls -la\n")

# Resize terminal
await sandbox.pty.resize(pty.pid, PtySize(rows=30, cols=100))

# Clean up
await sandbox.pty.kill(pty.pid)
```

## Related Files

- `sandbox_ssh.py` - Main SSH script
- `sandbox_runner.py` - Run agents in sandbox
- `sandbox_manager.py` - Create/manage sandboxes
- `kill_all_sandboxes.py` - List and kill sandboxes
- `extend_sandbox_timeout.py` - Extend sandbox lifetime
