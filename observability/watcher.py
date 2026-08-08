"""
Simple event file watcher using E2B's file metadata + polling.
"""

import json
import logging
from collections import deque
from threading import Lock
from typing import Callable, Dict, Any, Optional, List, Tuple, Deque

from e2b_code_interpreter import Sandbox, AsyncSandbox

logger = logging.getLogger(__name__)

import asyncio
class EventFileWatcher:
    """
    Watch events.jsonl by polling file metadata and reading deltas.
    """

    def __init__(
        self,
        sandbox: Sandbox,
        events_path: str = "/tmp/events.jsonl",
        poll_interval: float = 1.0,
    ):
        self.sandbox = sandbox
        self.events_path = events_path
        self.last_read_pos = 0
        self.poll_interval = poll_interval
        self._last_size = None
        self._last_mtime = None
        self._partial_line = ""

    def watch(
        self,
        callback: Callable[[Dict[str, Any]], None],
        raw_callback: Optional[Callable[[str], None]] = None,
    ) -> None:
        """
        Watch for file changes and call callback with each new event.

        Args:
            callback: Function to call with each event dict
            raw_callback: Optional function to receive raw new content
        """

        try:
            import time
            logger.info(f"Watching {self.events_path}")

            # Read existing events (if any) before waiting for new ones
            self._dispatch_new_content(callback, raw_callback, force=True)

            while True:
                if self._should_read():
                    self._dispatch_new_content(callback, raw_callback)
                time.sleep(self.poll_interval)
        except KeyboardInterrupt:
            logger.info("Stopping watcher")

    def _get_info(self):
        try:
            info = self.sandbox.files.get_info(self.events_path)
        except Exception as e:
            logger.debug("Failed to get file info: %s", e, exc_info=True)
            return None

        if info is None:
            return None

        if isinstance(info, dict):
            size = info.get("size")
            mtime = info.get("modified") or info.get("mtime")
        else:
            size = getattr(info, "size", None)
            mtime = getattr(info, "modified", None) or getattr(info, "mtime", None)

        return {"size": size, "mtime": mtime}

    def _should_read(self) -> bool:
        info = self._get_info()
        if info is None:
            return True

        size = info.get("size")
        mtime = info.get("mtime")

        if size is None:
            return True

        if size < self.last_read_pos:
            self.last_read_pos = 0
            self._partial_line = ""
            self._last_size = size
            self._last_mtime = mtime
            return True

        if size == self.last_read_pos:
            self._last_size = size
            self._last_mtime = mtime
            return False

        self._last_size = size
        self._last_mtime = mtime
        return True

    def _dispatch_new_content(
        self,
        callback: Callable[[Dict[str, Any]], None],
        raw_callback: Optional[Callable[[str], None]],
        force: bool = False,
    ) -> None:
        lines, raw_text = self._read_new_lines(force=force)
        if raw_text and raw_callback:
            raw_callback(raw_text)
        if lines:
            self._emit_events(lines, callback)

    def _read_new_lines(self, force: bool = False) -> Tuple[List[str], str]:
        """Read new lines from file and return (lines, raw_text)."""
        try:
            if not force and not self._should_read():
                return [], ""

            # Read entire file
            content = self.sandbox.files.read(self.events_path)

            # Only process new content
            if len(content) <= self.last_read_pos:
                return [], ""

            new_content = content[self.last_read_pos:]
            self.last_read_pos = len(content)

            # Handle partial lines
            chunk = f"{self._partial_line}{new_content}"
            if not chunk:
                return [], ""

            if chunk.endswith("\n"):
                lines = chunk.split("\n")[:-1]
                self._partial_line = ""
            else:
                lines = chunk.split("\n")
                self._partial_line = lines.pop() if lines else ""

            if not lines:
                return [], ""

            raw_text = "\n".join(lines) + "\n"
            return lines, raw_text

        except Exception as e:
            logger.error(f"Error reading events: {e}")
            return [], ""

    def _emit_events(self, lines: List[str], callback: Callable[[Dict[str, Any]], None]) -> None:
        for line in lines:
            if not line.strip():
                continue

            try:
                event = json.loads(line)
                callback(event)
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON: {line[:100]}")

class EventFileWatcherAsync:
    """
    Watch events.jsonl using E2B AsyncSandbox streaming watch_dir API.
    """

    def __init__(
        self,
        sandbox: AsyncSandbox,
        events_path: str = "/tmp/events.jsonl",
    ):
        self.sandbox = sandbox
        self.events_path = events_path
        self.watch_dir = events_path.rsplit("/", 1)[0]

        self.last_read_pos = 0
        self._partial_line = ""

        self._wake = None
        self._stop = None
        self._stop_requested = False

    def stop(self) -> None:
        self._stop_requested = True
        if self._stop is not None:
            self._stop.set()
        if self._wake is not None:
            self._wake.set()

    def _ensure_events(self) -> None:
        loop = asyncio.get_running_loop()

        def is_bound_to_loop(evt: Optional[asyncio.Event]) -> bool:
            bound_loop = getattr(evt, "_loop", None)
            return evt is not None and (bound_loop is None or bound_loop is loop)

        if not is_bound_to_loop(self._wake):
            self._wake = asyncio.Event()
        if not is_bound_to_loop(self._stop):
            self._stop = asyncio.Event()
        if self._stop_requested:
            self._stop.set()
            self._wake.set()

    def _event_targets_file(self, event) -> bool:
        name = getattr(event, "name", None) or getattr(event, "path", None)
        if not name:
            return False

        # event.name is often relative to watched dir; handle a few shapes
        if name == self.events_path:
            return True

        target_basename = self.events_path.rsplit("/", 1)[-1]
        if name == target_basename:
            return True

        if isinstance(name, str) and name.endswith(f"/{target_basename}"):
            return True

        joined = f"{self.watch_dir.rstrip('/')}/{str(name).lstrip('/')}"
        return joined == self.events_path

    def _event_should_trigger_read(self, event) -> bool:
        event_type = getattr(event, "type", None)
        if hasattr(event_type, "name"):
            event_type = event_type.name
        if isinstance(event_type, str):
            event_type = event_type.upper()

        # E2B proto has CREATE/WRITE/REMOVE/RENAME/CHMOD (no MODIFY),
        # but keep this a bit permissive.
        return event_type in ("WRITE", "CREATE", "MODIFY", "CHANGED") or event_type is None

    async def watch(
        self,
        callback: Callable[[Dict[str, Any]], Any],
        raw_callback: Optional[Callable[[str], Any]] = None,
        *,
        recursive: bool = False,
        timeout: float = 0,  # 0 => no limit (per SDK docstring)
        on_exit: Optional[Callable[[Exception], Any]] = None,
    ) -> None:
        self._ensure_events()

        async def on_event(event) -> None:
            if not self._event_targets_file(event):
                return
            if self._event_should_trigger_read(event):
                self._wake.set()

        handle = await self.sandbox.files.watch_dir(
            self.watch_dir,
            on_event=on_event,
            on_exit=on_exit,
            timeout=timeout,
            recursive=recursive,
        )

        try:
            # Read existing content once
            await self._dispatch_new_content(callback, raw_callback, force=True)

            while not self._stop.is_set():
                await self._wake.wait()
                self._wake.clear()

                if self._stop.is_set():
                    break

                await self._dispatch_new_content(callback, raw_callback)
        finally:
            await handle.stop()

    async def _dispatch_new_content(
        self,
        callback: Callable[[Dict[str, Any]], Any],
        raw_callback: Optional[Callable[[str], Any]],
        *,
        force: bool = False,
    ) -> None:
        lines, raw_text = await self._read_new_lines(force=force)

        if raw_text and raw_callback:
            raw_callback(raw_text)

        for line in lines:
            s = line.strip()
            if not s:
                continue
            try:
                callback(json.loads(s))
            except json.JSONDecodeError:
                # ignore bad lines; optionally log
                continue

    async def _read_new_lines(self, *, force: bool = False) -> Tuple[List[str], str]:
        try:
            content = await self.sandbox.files.read(self.events_path)

            # Handle truncation/rotation
            if len(content) < self.last_read_pos:
                self.last_read_pos = 0
                self._partial_line = ""

            if not force and len(content) <= self.last_read_pos:
                return [], ""

            new_content = content[self.last_read_pos :]
            self.last_read_pos = len(content)

            chunk = f"{self._partial_line}{new_content}"
            if not chunk:
                return [], ""

            if chunk.endswith("\n"):
                lines = chunk.split("\n")[:-1]
                self._partial_line = ""
            else:
                parts = chunk.split("\n")
                self._partial_line = parts.pop() if parts else ""
                lines = parts

            if not lines:
                return [], ""

            raw_text = "\n".join(lines) + "\n"
            return lines, raw_text
        except Exception:
            return [], ""
