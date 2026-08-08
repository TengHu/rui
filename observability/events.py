"""
Event logging utilities for agent observability.

Events are written to a JSONL file inside the sandbox for consumption
by external watchers.
"""

import json
import time
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Optional

# Global state for event tracking
_event_seq = 0
_write_lock = Lock()
_events_file: Optional[Path] = None


def create_events_file(workspace_path: str = "/home/user/workspace") -> Path:
    """
    Create the events.jsonl file in the workspace.

    Args:
        workspace_path: Path to workspace directory

    Returns:
        Path to events.jsonl file
    """
    global _events_file

    workspace = Path(workspace_path)
    workspace.mkdir(parents=True, exist_ok=True)

    _events_file = workspace / "events.jsonl"
    _events_file.touch()  # Create if not exists

    return _events_file


def append_event(event_type: str, data: Dict[str, Any], metadata: Optional[Dict[str, Any]] = None) -> None:
    """
    Append an event to the events.jsonl file.

    Args:
        event_type: Type of event (tool_start, tool_end, agent_message, etc.)
        data: Event data payload
        metadata: Optional metadata (tags, labels, etc.)
    """
    global _event_seq, _events_file

    if _events_file is None:
        # Auto-create if not initialized
        create_events_file()

    event = {
        "seq": _event_seq,
        "timestamp": time.time(),
        "type": event_type,
        "data": data,
    }

    if metadata:
        event["metadata"] = metadata

    _event_seq += 1

    # Atomic append with flush
    with _write_lock:
        with _events_file.open("a") as f:
            f.write(json.dumps(event) + "\n")
            f.flush()


def truncate_large(content: Any, max_length: int = 10000) -> Any:
    """
    Truncate large content to prevent huge event logs.

    Args:
        content: Content to potentially truncate
        max_length: Maximum length before truncation

    Returns:
        Original content or truncated version
    """
    if isinstance(content, str) and len(content) > max_length:
        return content[:max_length] + f"... [truncated {len(content) - max_length} chars]"

    if isinstance(content, dict):
        # Recursively truncate dict values
        return {k: truncate_large(v, max_length) for k, v in content.items()}

    if isinstance(content, list):
        # Truncate list if too many items
        if len(content) > 100:
            return content[:100] + [f"... [truncated {len(content) - 100} items]"]
        return [truncate_large(item, max_length) for item in content]

    return content


def rotate_events_file(max_size_bytes: int = 10_000_000) -> None:
    """
    Rotate events file if it exceeds max size.

    Args:
        max_size_bytes: Maximum file size before rotation (default 10MB)
    """
    global _events_file

    if _events_file is None or not _events_file.exists():
        return

    if _events_file.stat().st_size > max_size_bytes:
        # Rename to timestamped backup
        backup_name = f"events.{int(time.time())}.jsonl"
        backup_path = _events_file.parent / backup_name
        _events_file.rename(backup_path)

        # Create new file
        _events_file.touch()

        # Log rotation event
        append_event("system", {
            "message": "rotated log file",
            "old_file": backup_name,
            "size_bytes": _events_file.stat().st_size
        })
