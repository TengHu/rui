#!/usr/bin/env python3
"""
SSH into an E2B sandbox - interactive terminal access.

Usage:
    python sandbox_ssh.py --list                 # List running sandboxes
    python sandbox_ssh.py <sandbox_id>           # Connect to a sandbox
    python sandbox_ssh.py                        # Interactive selection
"""

import argparse
import asyncio
import os
import sys
import select
import signal
import termios
import tty
from typing import Optional, List

from e2b import Sandbox
from e2b.api.client.models import SandboxState
from e2b.sandbox.sandbox_api import SandboxQuery, SandboxInfo
from e2b.sandbox.commands.command_handle import PtySize
from e2b_code_interpreter import AsyncSandbox


def get_running_sandboxes() -> List[SandboxInfo]:
    """Get all running E2B sandboxes."""
    sandboxes = []
    paginator = Sandbox.list(query=SandboxQuery(state=[SandboxState.RUNNING]))
    while paginator.has_next:
        for info in paginator.next_items():
            sandboxes.append(info)
    return sandboxes


def list_sandboxes() -> int:
    """List all running sandboxes."""
    sandboxes = get_running_sandboxes()
    if not sandboxes:
        print("No running sandboxes found.")
        return 0

    print(f"\n{'ID':<40} {'Template':<25} {'State':<10}")
    print("-" * 80)
    for info in sandboxes:
        print(f"{info.sandbox_id:<40} {info.template_id or 'default':<25} {info.state:<10}")
    print(f"\nTotal: {len(sandboxes)} sandbox(es)")
    return 0


def select_sandbox() -> Optional[str]:
    """Interactively select a sandbox from running sandboxes."""
    sandboxes = get_running_sandboxes()
    if not sandboxes:
        print("No running sandboxes found.")
        return None

    print("\nSelect a sandbox to connect to:\n")
    for i, info in enumerate(sandboxes, 1):
        template = info.template_id or "default"
        print(f"  [{i}] {info.sandbox_id} ({template})")

    print()
    try:
        choice = input("Enter number (or 'q' to quit): ").strip()
        if choice.lower() == 'q':
            return None
        idx = int(choice) - 1
        if 0 <= idx < len(sandboxes):
            return sandboxes[idx].sandbox_id
        print("Invalid selection.")
        return None
    except (ValueError, EOFError, KeyboardInterrupt):
        return None


class TerminalHandler:
    """Handle raw terminal mode for SSH-like experience."""

    def __init__(self):
        self.old_settings = None
        self.is_raw = False

    def enter_raw_mode(self):
        """Put terminal into raw mode for character-by-character input."""
        if not sys.stdin.isatty():
            return
        self.old_settings = termios.tcgetattr(sys.stdin.fileno())
        tty.setraw(sys.stdin.fileno())
        self.is_raw = True

    def exit_raw_mode(self):
        """Restore terminal to normal mode."""
        if self.old_settings and self.is_raw:
            termios.tcsetattr(
                sys.stdin.fileno(),
                termios.TCSADRAIN,
                self.old_settings
            )
            self.is_raw = False

    def get_terminal_size(self) -> tuple[int, int]:
        """Get terminal size (cols, rows)."""
        try:
            size = os.get_terminal_size()
            return (size.columns, size.lines)
        except OSError:
            return (80, 24)


async def ssh_session(sandbox_id: str, cwd: str = "/home/user/workspace") -> int:
    """
    Start an interactive SSH-like session with the sandbox.

    Args:
        sandbox_id: E2B sandbox ID to connect to
        cwd: Initial working directory

    Returns:
        Exit code (0 for success)
    """
    terminal = TerminalHandler()
    sandbox = None
    pid = None

    exit_requested = asyncio.Event()
    resize_needed = asyncio.Event()

    def signal_handler(sig, frame):
        exit_requested.set()

    def resize_handler(sig, frame):
        resize_needed.set()

    original_sigint = signal.signal(signal.SIGINT, signal_handler)
    original_sigwinch = signal.signal(signal.SIGWINCH, resize_handler)

    try:
        print(f"Connecting to sandbox {sandbox_id}...")
        sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
        print(f"Connected. Starting shell in {cwd}...")
        print("Press Ctrl+] to exit.\n")

        cols, rows = terminal.get_terminal_size()

        def on_pty_data(data: bytes):
            """Callback for PTY output data."""
            if data and not exit_requested.is_set():
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()

        pty_handle = await sandbox.pty.create(
            size=PtySize(rows=rows, cols=cols),
            on_data=on_pty_data,
            cwd=cwd,
            timeout=0,
        )

        pid = pty_handle.pid

        terminal.enter_raw_mode()

        try:
            while not exit_requested.is_set():
                if resize_needed.is_set():
                    resize_needed.clear()
                    new_cols, new_rows = terminal.get_terminal_size()
                    try:
                        await sandbox.pty.resize(
                            pid,
                            PtySize(rows=new_rows, cols=new_cols)
                        )
                    except Exception:
                        pass

                if sys.stdin.isatty():
                    readable, _, _ = select.select([sys.stdin], [], [], 0.1)
                    if readable:
                        char = sys.stdin.read(1)
                        if char:
                            if ord(char) == 29:
                                exit_requested.set()
                                break
                            try:
                                await sandbox.pty.send_stdin(
                                    pid,
                                    char.encode() if isinstance(char, str) else char
                                )
                            except Exception:
                                break
                else:
                    await asyncio.sleep(0.1)

        except asyncio.CancelledError:
            pass

        return 0

    except Exception as e:
        print(f"\nError: {e}", file=sys.stderr)
        return 1

    finally:
        if sandbox and pid:
            try:
                await sandbox.pty.kill(pid)
            except Exception:
                pass
        terminal.exit_raw_mode()
        signal.signal(signal.SIGINT, original_sigint)
        signal.signal(signal.SIGWINCH, original_sigwinch)
        print("\nDisconnected.")


async def async_main(args: argparse.Namespace) -> int:
    """Async main entry point."""
    if args.list:
        return list_sandboxes()

    sandbox_id = args.sandbox_id
    if not sandbox_id:
        sandbox_id = select_sandbox()
        if not sandbox_id:
            return 1

    return await ssh_session(sandbox_id, args.cwd)


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="SSH into an E2B sandbox - interactive terminal access.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --list                    List all running sandboxes
  %(prog)s abc123                    Connect to sandbox 'abc123'
  %(prog)s                           Interactive sandbox selection

Press Ctrl+] to exit the SSH session.
        """
    )
    parser.add_argument(
        "sandbox_id",
        nargs="?",
        help="Sandbox ID to connect to"
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List all running sandboxes"
    )
    parser.add_argument(
        "--cwd", "-c",
        default="/home/user/workspace",
        help="Initial working directory (default: /home/user/workspace)"
    )

    args = parser.parse_args()

    if not os.environ.get("E2B_API_KEY"):
        print("Error: E2B_API_KEY not found in environment.", file=sys.stderr)
        print("Set it with: export E2B_API_KEY='your-api-key'", file=sys.stderr)
        return 1

    return asyncio.run(async_main(args))


if __name__ == "__main__":
    sys.exit(main())
