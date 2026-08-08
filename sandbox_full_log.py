#!/usr/bin/env python3
"""
Pull the event log from an E2B sandbox window.

Usage:
    python sandbox_full_log.py <sandbox_id> <window_id>
    python sandbox_full_log.py <sandbox_id> <window_id> --summary
    python sandbox_full_log.py <sandbox_id> --list

Examples:
    python sandbox_full_log.py abc123 rwin_deadbeef
    python sandbox_full_log.py abc123 rwin_deadbeef --summary
    python sandbox_full_log.py abc123 rwin_deadbeef | jq 'select(.type == "tool_start")'
"""

import argparse
import asyncio
import json
import os
import sys
from collections import Counter

from e2b_code_interpreter import AsyncSandbox


EVENTS_BASE = "/tmp/.window-events"


async def fetch_full_log(sandbox_id: str, window_id: str) -> str:
    """Connect to sandbox and read full log (archives + current events)."""
    sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
    window_dir = f"{EVENTS_BASE}/{window_id}"

    result = await sandbox.commands.run(
        f"cd {window_dir}"
        " && (shopt -s nullglob; for f in archives/*.gz; do zcat \"$f\"; done)"
        " && cat current.jsonl 2>/dev/null",
        timeout=30,
    )

    if result.exit_code != 0:
        stderr = result.stderr.strip() if result.stderr else ""
        raise RuntimeError(f"Failed to read log for {window_id}: {stderr}")

    return result.stdout or ""


async def list_windows(sandbox_id: str) -> list[str]:
    """List all window IDs in .window-events/."""
    sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
    result = await sandbox.commands.run(
        f"ls -1 {EVENTS_BASE}",
        timeout=10,
    )

    if result.exit_code != 0:
        stderr = result.stderr.strip() if result.stderr else ""
        raise RuntimeError(f"Failed to list windows: {stderr}")

    stdout = result.stdout or ""
    return [line for line in stdout.strip().splitlines() if line.strip()]


def print_summary(raw_jsonl: str) -> None:
    """Print event count breakdown and key non-delta events."""
    type_counts: Counter = Counter()
    key_events: list[dict] = []
    total = 0

    for line in raw_jsonl.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        total += 1
        event_type = event.get("type", "unknown")
        type_counts[event_type] += 1

        if "delta" not in event_type:
            key_events.append(event)

    print(f"Total events: {total}", file=sys.stderr)
    print(f"Key events (non-delta): {len(key_events)}", file=sys.stderr)
    print(file=sys.stderr)
    print("Event type breakdown:", file=sys.stderr)

    for event_type, count in type_counts.most_common():
        print(f"  {count:>6}  {event_type}", file=sys.stderr)

    print(file=sys.stderr)
    print("Key events:", file=sys.stderr)

    for event in key_events:
        seq = event.get("seq", "?")
        event_type = event.get("type", "unknown")
        data = event.get("data", {})

        detail = ""
        if event_type == "tool_start":
            detail = f" tool={data.get('tool', '?')}"
        elif event_type == "tool_end":
            error = data.get("error")
            detail = f" error={error}" if error else ""
        elif event_type in ("agent_start", "agent_end"):
            detail = f" model={data.get('model', '?')}"

        print(f"  #{seq:<6} {event_type}{detail}", file=sys.stderr)


async def run_list(args: argparse.Namespace) -> int:
    """Handle --list flag."""
    try:
        windows = await list_windows(args.sandbox_id)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    if not windows:
        print("No windows found.", file=sys.stderr)
        return 0

    for window_id in windows:
        print(window_id)
    return 0


async def run_log(args: argparse.Namespace) -> int:
    """Handle default (fetch log) mode."""
    try:
        raw = await fetch_full_log(args.sandbox_id, args.window_id)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    if args.summary:
        print_summary(raw)
    else:
        sys.stdout.write(raw)

    return 0


async def async_main(args: argparse.Namespace) -> int:
    """Route to the correct handler."""
    if args.list:
        return await run_list(args)
    if not args.window_id:
        print("Error: window_id is required (or use --list)", file=sys.stderr)
        return 1
    return await run_log(args)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Pull the event log from an E2B sandbox.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("sandbox_id", help="E2B sandbox ID")
    parser.add_argument("window_id", nargs="?", help="Window ID (e.g. rwin_deadbeef)")
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List all window IDs in the sandbox",
    )
    parser.add_argument(
        "--summary", "-s",
        action="store_true",
        help="Print event count breakdown instead of raw JSONL",
    )

    args = parser.parse_args()

    if not os.environ.get("E2B_API_KEY"):
        print("Error: E2B_API_KEY not found in environment.", file=sys.stderr)
        print("Set it with: export E2B_API_KEY='your-api-key'", file=sys.stderr)
        return 1

    return asyncio.run(async_main(args))


if __name__ == "__main__":
    sys.exit(main())
