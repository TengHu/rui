# /sandbox-ssh - Interactive E2B Sandbox Terminal

SSH into an E2B sandbox for interactive debugging via PTY interface.

## Usage

When user invokes `/sandbox-ssh`, help them connect to a running E2B sandbox.

## Steps

1. **Check for running sandboxes**:
   ```bash
   export $(grep -v '^#' .env | xargs) && python sandbox_ssh.py --list
   ```

2. **If sandbox ID provided**, connect directly:
   ```bash
   export $(grep -v '^#' .env | xargs) && python sandbox_ssh.py $ARGUMENTS
   ```

3. **If no sandbox ID**, prompt user to select from the list or run interactive mode:
   ```bash
   export $(grep -v '^#' .env | xargs) && python sandbox_ssh.py
   ```

## Arguments

- `<sandbox_id>` - Connect to specific sandbox
- `--list` or `-l` - List all running sandboxes
- `--cwd <path>` - Set initial working directory (default: /home/user/workspace)

## Examples

```bash
# List sandboxes
/sandbox-ssh --list

# Connect to sandbox
/sandbox-ssh abc123xyz

# Connect with custom directory
/sandbox-ssh abc123xyz --cwd /home/user/myproject
```

## Exit

Press **Ctrl+]** (Control + right bracket) to disconnect.

## Common Debug Tasks

Once connected:
- `ps aux` - View running processes
- `cat events.jsonl | tail -20` - View recent agent events
- `ls -la` - List workspace files
- `curl localhost:3000/mcp` - Test MCP server
- `free -h` - Check memory usage
