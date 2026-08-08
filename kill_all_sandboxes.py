#!/usr/bin/env python3
"""
List all running E2B sandboxes and kill them.
"""

import argparse
import os
import sys
from typing import Iterable

from e2b import Sandbox
from e2b.api.client.models import SandboxState
from e2b.sandbox.sandbox_api import SandboxQuery, SandboxInfo


def iter_running_sandboxes() -> Iterable[SandboxInfo]:
    paginator = Sandbox.list(query=SandboxQuery(state=[SandboxState.RUNNING]))
    while paginator.has_next:
        for info in paginator.next_items():
            yield info


def main() -> int:
    parser = argparse.ArgumentParser(
        description="List all running E2B sandboxes and kill them.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List sandboxes without killing them.",
    )
    args = parser.parse_args()

    if not os.environ.get("E2B_API_KEY"):
        print("E2B_API_KEY is not set in the environment.", file=sys.stderr)
        return 1

    sandboxes = list(iter_running_sandboxes())
    if not sandboxes:
        print("No running sandboxes found.")
        return 0

    print(f"Found {len(sandboxes)} running sandbox(es):")
    for info in sandboxes:
        print(f"- {info.sandbox_id} (template={info.template_id}, end_at={info.end_at}, state={info.state})")

    if args.dry_run:
        print("Dry run enabled; no sandboxes were killed.")
        return 0

    killed = 0
    failed = 0
    for info in sandboxes:
        try:
            ok = Sandbox.kill(info.sandbox_id)
            if ok:
                killed += 1
                print(f"✓ Killed {info.sandbox_id}")
            else:
                failed += 1
                print(f"✗ Not found: {info.sandbox_id}")
        except Exception as exc:
            failed += 1
            print(f"✗ Failed to kill {info.sandbox_id}: {exc}")

    print(f"Done. Killed={killed}, Failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
