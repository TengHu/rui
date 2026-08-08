"""
EventManager — owns per-channel event storage, poller lifecycle, and session tracking.

Two module-level singletons:
  - main_events: used by /api/chat (main chat)
  - window_events: used by route window chat
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Any, AsyncGenerator, Callable, Dict, Optional

from services.file_poller import FilePoller, stream_sandbox_events

logger = logging.getLogger(__name__)


class EventManager:
    """Manages event storage, pollers, agent-end signals, and session IDs for a set of channels."""

    def __init__(self, name: str = "default"):
        self._name = name
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._end_events: Dict[str, asyncio.Event] = {}
        self._pollers: Dict[str, FilePoller] = {}
        self._session_ids: Dict[str, str] = {}

    def init_channel(self, channel_id: str) -> tuple:
        """Initialize (or reset) a channel for a new message.

        Returns (storage_dict, message_id).
        """
        message_id = str(uuid.uuid4())[:8]
        self._storage[channel_id] = {
            "events": [],
            "done": False,
            "last_sent": 0,
            "message_id": message_id,
        }
        self._end_events[channel_id] = asyncio.Event()
        return self._storage[channel_id], message_id

    def get_storage(self, channel_id: str) -> Optional[Dict[str, Any]]:
        return self._storage.get(channel_id)

    def set_session_id(self, channel_id: str, sid: str):
        self._session_ids[channel_id] = sid

    def get_session_id(self, channel_id: str) -> Optional[str]:
        return self._session_ids.get(channel_id)

    async def start_poller(
        self,
        channel_id: str,
        sandbox,
        events_path: str,
        skip_lines: int = 0,
        mcp_server_url: Optional[str] = None,
    ) -> Optional[FilePoller]:
        """Stop any existing poller, start a new one, and return it."""
        existing = self._pollers.get(channel_id)
        if existing:
            try:
                await existing.stop()
            except Exception as e:
                logger.warning(
                    "Error stopping existing poller for %s: %s: %s",
                    channel_id, type(e).__name__, e,
                )

        storage = self._storage.get(channel_id)
        if not storage:
            return None

        def _on_session_init(cid: str, sid: str):
            self._session_ids[cid] = sid

        def _on_agent_end(cid: str):
            end_ev = self._end_events.get(cid)
            if end_ev:
                end_ev.set()

        poller = await stream_sandbox_events(
            sandbox,
            events_path,
            storage,
            channel_id,
            mcp_server_url,
            skip_lines=skip_lines,
            on_session_init=_on_session_init,
            on_agent_end=_on_agent_end,
        )
        if poller:
            self._pollers[channel_id] = poller
        return poller

    async def _wait_for_agent_end(self, channel_id, poller, end_event, timeout, start_time):
        """Phase 1: Wait for poller to see agent_end signal."""
        while time.time() - start_time < timeout:
            if poller.agent_end_seen:
                logger.info("Poller confirmed agent_end for %s", channel_id)
                return
            if end_event and end_event.is_set():
                logger.info("Event signal confirmed agent_end for %s", channel_id)
                return
            await asyncio.sleep(0.2)

        logger.warning(
            "agent_end not seen within %.0fs for %s, poller read %d lines",
            timeout, channel_id, poller.last_line_count,
        )

    async def _drain_sse_events(self, channel_id, storage, drain_timeout=10.0):
        """Phase 2: Wait for all SSE events to be sent to clients."""
        drain_deadline = time.time() + drain_timeout
        while time.time() < drain_deadline:
            if storage:
                total = len(storage.get("events", []))
                sent = storage.get("last_sent", 0)
                if total == sent:
                    await asyncio.sleep(0.5)
                    if len(storage.get("events", [])) == storage.get("last_sent", 0):
                        logger.info("All %d events delivered for %s", total, channel_id)
                        return
            await asyncio.sleep(0.1)

    async def wait_for_delivery(
        self,
        channel_id: str,
        poller: FilePoller,
        timeout: float = 60.0,
    ):
        """Wait for all events to stream, then clean up the poller."""
        storage = self._storage.get(channel_id)
        end_event = self._end_events.get(channel_id)
        start_time = time.time()

        try:
            await self._wait_for_agent_end(channel_id, poller, end_event, timeout, start_time)
            await self._drain_sse_events(channel_id, storage)
            await asyncio.sleep(1.0)

            elapsed = time.time() - start_time
            total = len(storage.get("events", [])) if storage else 0
            sent = storage.get("last_sent", 0) if storage else 0
            logger.info(
                "Event delivery complete for %s in %.1fs (lines: %d, events: %d, sent: %d)",
                channel_id, elapsed, poller.last_line_count, total, sent,
            )
        except Exception as e:
            logger.exception("Error waiting for event delivery: %s", e)
        finally:
            try:
                await poller.stop()
            except Exception as e:
                logger.warning("Error stopping poller: %s", e)
            self._pollers.pop(channel_id, None)
            self._end_events.pop(channel_id, None)

    def _format_sse(self, data: dict) -> str:
        return f"data: {json.dumps(data)}\n\n"

    def _flush_pending(self, storage, extra):
        """Yield SSE strings for unsent events and update last_sent."""
        events_list = storage.get("events", [])
        last_sent = storage.get("last_sent", 0)
        msg_id = storage.get("message_id")
        pending = events_list[last_sent:]
        storage["last_sent"] = len(events_list)
        return [self._format_sse({**ev, "message_id": msg_id, **extra}) for ev in pending]

    async def sse_generator(
        self, channel_id: str, extra_fields: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[str, None]:
        """Yield SSE events for a channel."""
        extra = extra_fields or {}
        yield self._format_sse({"type": "connected", **extra})

        wait_start = time.time()
        while self.get_storage(channel_id) is None:
            if time.time() - wait_start > 30:
                yield self._format_sse({"type": "error", "message": "Timeout waiting for event queue"})
                return
            await asyncio.sleep(0.1)

        timeout_count = 0
        while timeout_count < 1200:
            storage = self.get_storage(channel_id)
            if not storage:
                break

            if len(storage.get("events", [])) > storage.get("last_sent", 0):
                for chunk in self._flush_pending(storage, extra):
                    yield chunk
                timeout_count = 0
                if storage.get("done"):
                    break
            else:
                await asyncio.sleep(0.1)
                timeout_count += 1
                if timeout_count % 50 == 0:
                    yield self._format_sse({"type": "heartbeat", **extra})
                if storage.get("done"):
                    for chunk in self._flush_pending(storage, extra):
                        yield chunk
                    break

        yield self._format_sse({"type": "stream_end", **extra})

    def remove_channel(self, channel_id: str) -> Optional[FilePoller]:
        """Remove all state for a channel. Returns the poller (if any) for async cleanup."""
        self._storage.pop(channel_id, None)
        self._end_events.pop(channel_id, None)
        self._session_ids.pop(channel_id, None)
        return self._pollers.pop(channel_id, None)


# Module-level singletons
main_events = EventManager("main")
window_events = EventManager("window")
