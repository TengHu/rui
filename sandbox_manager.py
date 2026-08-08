#!/usr/bin/env python3
"""
Sandbox Manager - Create, list, and manage E2B sandboxes.

Can be used as a module or CLI tool.
"""

import sys
import argparse
import os
import time
import logging
from pathlib import Path
from typing import List, Optional
from dataclasses import dataclass
from e2b_code_interpreter import Sandbox
from e2b.exceptions import TimeoutException


logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def _log_run_code_result(step: str, result) -> None:
    """Log stdout/stderr from an E2B run_code result if present."""
    stdout = getattr(getattr(result, "logs", None), "stdout", None)
    stderr = getattr(getattr(result, "logs", None), "stderr", None)
    if stdout:
        text = "".join(stdout) if isinstance(stdout, list) else stdout
        text = text.strip()
        if text:
            logger.info("%s stdout: %s", step, text)
    if stderr:
        text = "".join(stderr) if isinstance(stderr, list) else stderr
        text = text.strip()
        if text:
            logger.error("%s stderr: %s", step, text)


@dataclass
class SandboxInfo:
    """Information about a sandbox."""
    sandbox_id: str
    sandbox: Sandbox


class SandboxManager:
    """Manages E2B sandbox lifecycle."""

    def __init__(
        self,
        workdir: str = "/workspace",
        user: str = "sandbox",
        template_id: Optional[str] = None,
    ):
        """Initialize the sandbox manager."""
        self._active_sandboxes: dict[str, Sandbox] = {}
        self._workdir = workdir
        self._user = user
        self._template_id = os.environ.get("E2B_TEMPLATE_ID") or template_id

    def create_sandbox(self) -> SandboxInfo:
        """
        Create a new E2B sandbox.

        Returns:
            SandboxInfo with sandbox ID and instance
        """
        envs = {
            "WORKDIR": self._workdir,
            "USER": self._user,
            "HOME": self._workdir,
        }
        anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
        if anthropic_key:
            envs["ANTHROPIC_API_KEY"] = anthropic_key

        timeout_seconds = 3600
        if self._template_id:
            sandbox = Sandbox.create(
                template=self._template_id,
                envs=envs or None,
                allow_internet_access=True,
                timeout=timeout_seconds,
                network = {
                    "allow_public_traffic": True,
                }
            )
        else:
            sandbox = Sandbox.create(
                envs=envs or None,
                allow_internet_access=True,
                timeout=timeout_seconds,
                network = {
                    "allow_public_traffic": True,
                }
            )
        sandbox_id = sandbox.sandbox_id

        # Ensure working directory exists inside the sandbox
        for attempt in range(10):
            try:
                result = sandbox.run_code(
                    f"""
import os
os.makedirs({self._workdir!r}, exist_ok=True)
# Create desktop folder for user-uploaded files
desktop_dir = os.path.join({self._workdir!r}, 'desktop')
os.makedirs(desktop_dir, exist_ok=True)
"""
                )
                _log_run_code_result("mkdir_workdir", result)
                break
            except TimeoutException:
                time.sleep(1)

        # Track active sandbox
        self._active_sandboxes[sandbox_id] = sandbox

        return SandboxInfo(sandbox_id=sandbox_id, sandbox=sandbox)

    def get_sandbox(self, sandbox_id: str) -> Optional[Sandbox]:
        """
        Get an active sandbox by ID.

        Args:
            sandbox_id: The sandbox ID

        Returns:
            Sandbox instance or None if not found
        """
        return self._active_sandboxes.get(sandbox_id)

    def list_active(self) -> List[str]:
        """
        List all active sandbox IDs.

        Returns:
            List of active sandbox IDs
        """
        return list(self._active_sandboxes.keys())

    def delete_sandbox(self, sandbox_id: str) -> bool:
        """
        Delete a sandbox by ID.

        Args:
            sandbox_id: The sandbox ID to delete

        Returns:
            True if deleted, False if not found
        """
        sandbox = self._active_sandboxes.get(sandbox_id)
        if sandbox:
            sandbox.kill()
            del self._active_sandboxes[sandbox_id]
            return True
        return False

    def delete_all(self) -> int:
        """
        Delete all active sandboxes.

        Returns:
            Number of sandboxes deleted
        """
        count = len(self._active_sandboxes)
        for sandbox in self._active_sandboxes.values():
            sandbox.kill()
        self._active_sandboxes.clear()
        return count

    def __len__(self) -> int:
        """Return number of active sandboxes."""
        return len(self._active_sandboxes)

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - cleanup all sandboxes."""
        self.delete_all()


# CLI functionality
def cli_create():
    """CLI: Create a new sandbox."""
    manager = SandboxManager()
    info = manager.create_sandbox()
    print(f"✓ Created sandbox: {info.sandbox_id}")
    return 0


def cli_list():
    """CLI: List active sandboxes."""
    # Note: This only lists sandboxes in current session
    # E2B doesn't provide API to list all user sandboxes
    print("Note: Can only list sandboxes in current session")
    print("Use E2B dashboard to see all sandboxes: https://e2b.dev/dashboard")
    return 0


def cli_remove(sandbox_id: str):
    """CLI: Remove a sandbox by ID."""
    manager = SandboxManager()
    # Try to get and delete the sandbox
    try:
        # Create a sandbox instance from ID (if possible)
        # Note: E2B doesn't provide direct reconnect, so this is limited
        print(f"Note: This only works for sandboxes in current session")
        print(f"To delete sandbox {sandbox_id}, use E2B dashboard: https://e2b.dev/dashboard")
        return 1
    except Exception as e:
        print(f"✗ Error: {e}")
        return 1


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Manage E2B sandboxes",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s create                        Create a new sandbox
  %(prog)s list-not-working-for-now      List active sandboxes (not working for now)
  %(prog)s remove-not-working-for-now <id>  Remove a sandbox by ID (not working for now)

Note: E2B API is session-based. Use E2B dashboard for full management:
https://e2b.dev/dashboard
        """
    )

    subparsers = parser.add_subparsers(dest='command', help='Command to execute')

    # Create command
    subparsers.add_parser('create', help='Create a new sandbox')

    # List command (not working for now)
    subparsers.add_parser('list-not-working-for-now', help='List active sandboxes (not working for now)')

    # Remove command (not working for now)
    remove_parser = subparsers.add_parser('remove-not-working-for-now', help='Remove a sandbox (not working for now)')
    remove_parser.add_argument('sandbox_id', help='Sandbox ID to remove')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    # Execute command
    if args.command == 'create':
        return cli_create()
    elif args.command == 'list-not-working-for-now':
        return cli_list()
    elif args.command == 'remove-not-working-for-now':
        return cli_remove(args.sandbox_id)
    else:
        parser.print_help()
        return 1


if __name__ == '__main__':
    sys.exit(main())
