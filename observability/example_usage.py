"""
Simple usage examples.
"""

import os
from e2b_code_interpreter import Sandbox
from observability import EventFileWatcher


def example_console():
    """Stream events to console."""
    sandbox_id = os.environ.get("SANDBOX_ID")
    sandbox = Sandbox.connect(sandbox_id=sandbox_id)

    print("Watching events...")
    watcher = EventFileWatcher(sandbox)

    def print_event(event):
        event_type = event.get("type", "unknown")
        seq = event.get("seq", "?")
        print(f"[{seq}] {event_type}")

        if event_type == "tool_start":
            tool = event.get("data", {}).get("tool")
            print(f"  Tool: {tool}")
        elif event_type == "tool_end":
            error = event.get("data", {}).get("error")
            if error:
                print(f"  Error: {error}")

    watcher.watch(print_event)


def example_file():
    """Save events to file."""
    sandbox_id = os.environ.get("SANDBOX_ID")
    sandbox = Sandbox.connect(sandbox_id=sandbox_id)

    print("Saving events to agent_events.jsonl...")
    watcher = EventFileWatcher(sandbox)

    with open("agent_events.jsonl", "w") as f:
        def save_event(event):
            import json
            f.write(json.dumps(event) + "\n")
            f.flush()
            print(f"Saved: {event.get('type', 'unknown')}")

        watcher.watch(save_event)


def example_custom():
    """Custom event handler."""
    sandbox_id = os.environ.get("SANDBOX_ID")
    sandbox = Sandbox.connect(sandbox_id=sandbox_id)

    watcher = EventFileWatcher(sandbox)

    def my_handler(event):
        # Do whatever you want with events
        if event["type"] == "tool_start":
            print(f"Tool: {event['data']['tool']}")

    watcher.watch(my_handler)


if __name__ == "__main__":
    example_console()
