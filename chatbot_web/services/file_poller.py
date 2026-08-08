"""
FilePoller — polls a JSONL events file in an E2B sandbox and streams new events.

On start: compacts the previous run's events to a gzip archive and clears the file.
The live file always contains only the current run's events.
"""

import asyncio
import json
import logging
import os
import re
import time
from typing import Callable, Optional

from e2b_code_interpreter import AsyncSandbox

logger = logging.getLogger(__name__)

SAFE_ID_PATTERN = re.compile(r'^[a-zA-Z0-9_-]+$')
MCP_TOOL_PREFIX = "mcp__app-server__"


class FilePoller:
    """Polls a JSONL file in the sandbox and streams events to a storage dict.

    Responsibilities:
      - Read new lines from the events file every poll_interval
      - Enrich MCP tool events with UI metadata (if mcp_server_url set)
      - On start: compact previous run to gzip archive, clear events file
    """

    def __init__(
        self,
        sandbox: AsyncSandbox,
        events_path: str,
        storage: dict,
        conversation_id: Optional[str] = None,
        mcp_server_url: Optional[str] = None,
        on_session_init: Optional[Callable[[str, str], None]] = None,
        on_agent_end: Optional[Callable[[str], None]] = None,
    ):
        self.sandbox = sandbox
        self.events_path = events_path
        self.storage = storage
        self.conversation_id = conversation_id
        self.mcp_server_url = mcp_server_url
        self.on_session_init = on_session_init
        self.on_agent_end = on_agent_end
        self.last_line_count = 0
        self.running = True
        self.task: Optional[asyncio.Task] = None
        self.agent_end_seen = False

        validated_id = _validate_id(conversation_id)
        self.window_id = validated_id
        # Use /tmp for window events to avoid permission issues
        base = "/tmp/.window-events"
        self.window_events_dir = f"{base}/{validated_id}" if validated_id else None
        self.archive_dir = f"{self.window_events_dir}/archives" if self.window_events_dir else None

    # ── lifecycle ──────────────────────────────────────────────────────

    async def start(self):
        await self._init_window_events_dir()
        await self._compact_and_clear()
        self.task = asyncio.create_task(self._poll_loop())
        logger.info(f"Started file poller for {self.events_path}")

    async def stop(self):
        self.running = False
        self.storage["done"] = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        logger.info(f"Stopped file poller for {self.events_path}")

    async def kill(self):
        await self.stop()

    # ── poll loop ─────────────────────────────────────────────────────

    async def _poll_loop(self):
        poll_interval = 0.1
        consecutive_errors = 0
        max_errors = 10

        while self.running and consecutive_errors < max_errors:
            try:
                try:
                    content = await self.sandbox.files.read(self.events_path)
                except FileNotFoundError:
                    await asyncio.sleep(poll_interval)
                    continue
                except Exception as e:
                    logger.warning(f"FilePoller read failed: {type(e).__name__}: {e}")
                    await asyncio.sleep(poll_interval)
                    continue

                lines = content.splitlines()
                current_line_count = len(lines)

                if current_line_count < self.last_line_count:
                    self.last_line_count = 0

                if current_line_count > self.last_line_count:
                    for line in lines[self.last_line_count:]:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                            self._process_event(event)
                        except json.JSONDecodeError:
                            self._append_event({"type": "log", "data": {"message": line}})

                    self.last_line_count = current_line_count
                    consecutive_errors = 0

                # Drain remaining events after agent_end
                if self.agent_end_seen:
                    for _ in range(5):
                        await asyncio.sleep(poll_interval)
                        try:
                            content = await self.sandbox.files.read(self.events_path)
                            lines = content.splitlines()
                            if len(lines) < self.last_line_count:
                                self.last_line_count = 0
                            if len(lines) > self.last_line_count:
                                for line in lines[self.last_line_count:]:
                                    line = line.strip()
                                    if line:
                                        try:
                                            event = json.loads(line)
                                            self._process_event(event)
                                        except json.JSONDecodeError:
                                            pass
                                self.last_line_count = len(lines)
                        except Exception:
                            pass

                    self.storage["done"] = True
                    logger.info(f"Poller finished after agent_end, total lines: {self.last_line_count}")
                    break

                await asyncio.sleep(poll_interval)

            except asyncio.CancelledError:
                logger.info(f"Poller cancelled for {self.conversation_id}")
                self.storage["done"] = True
                break
            except Exception as e:
                consecutive_errors += 1
                logger.warning(f"Poller error ({consecutive_errors}/{max_errors}): {e}")
                await asyncio.sleep(poll_interval * 2)

        self.storage["done"] = True

    # ── event processing ──────────────────────────────────────────────

    def _process_event(self, event: dict):
        event_type = event.get("type")

        if self.conversation_id and event_type == "session_init":
            session_id = event.get("data", {}).get("session_id")
            if session_id and self.on_session_init:
                self.on_session_init(self.conversation_id, session_id)

        if event_type == "agent_end":
            self.agent_end_seen = True
            if self.conversation_id and self.on_agent_end:
                self.on_agent_end(self.conversation_id)
            logger.info(f"agent_end detected for {self.conversation_id}")

        enriched = self._enrich_mcp_event(event)
        self._append_event(enriched)

    def _append_event(self, event: dict):
        self.storage["events"].append(event)

    def _enrich_mcp_event(self, event: dict) -> dict:
        if not self.mcp_server_url:
            return event

        event_type = event.get("type")
        data = event.get("data", {})

        if event_type == "mcp_tools_discovered":
            return {**event, "data": {**data, "mcpServerUrl": self.mcp_server_url}}

        if event_type == "mcp_tool_result":
            return {
                **event,
                "type": "tool_result",
                "data": {**data, "mcpServerUrl": self.mcp_server_url},
            }

        if event_type == "input_json_delta":
            tool_name = data.get("tool_name", "")
            if tool_name.startswith(MCP_TOOL_PREFIX):
                short_name = tool_name[len(MCP_TOOL_PREFIX):]
                partial_json = data.get("partial_json", "")

                # If this is the meta-tool ("app"), try to extract the actual
                # target tool name from the partial JSON for frontend routing
                actual_tool_name = short_name
                is_proxy = short_name == "app"
                if is_proxy:
                    try:
                        parsed = json.loads(partial_json)
                        if isinstance(parsed, dict) and "name" in parsed:
                            actual_tool_name = parsed["name"]
                    except (json.JSONDecodeError, TypeError):
                        pass  # Partial JSON not yet complete — use "app" as fallback

                return {
                    **event,
                    "type": "tool_input_partial",
                    "data": {
                        "tool_name": actual_tool_name,
                        "tool_use_id": data.get("tool_use_id"),
                        "partial_json": partial_json,
                        "is_proxy": is_proxy,
                    },
                }

        return event

    # ── compact + clear ───────────────────────────────────────────────

    async def _compact_and_clear(self):
        """Gzip the current events file to an archive, then truncate it."""
        if not self.archive_dir:
            return
        try:
            timestamp = int(time.time())
            archive_path = f"{self.archive_dir}/run.{timestamp}.jsonl.gz"
            await self.sandbox.commands.run(
                f"gzip -c {self.events_path} > {archive_path}"
                f" && : > {self.events_path}",
                timeout=30,
            )
            self.last_line_count = 0
            logger.info(f"Compacted run to {archive_path}")
        except Exception as e:
            logger.warning(f"Compact failed: {e}")

    # ── sandbox setup ─────────────────────────────────────────────────

    async def _init_window_events_dir(self):
        if not self.window_events_dir:
            return
        try:
            await self.sandbox.commands.run(f"mkdir -p {self.archive_dir}", timeout=5)
            await self.sandbox.commands.run(
                f"ln -sf {self.events_path} {self.window_events_dir}/current.jsonl",
                timeout=5,
            )
            logger.info(f"Initialized window events dir: {self.window_events_dir}")
        except Exception as e:
            logger.warning(f"Failed to init window events dir: {e}")


# ── helper to start a poller ──────────────────────────────────────────

async def stream_sandbox_events(
    sandbox: AsyncSandbox,
    events_path: str,
    storage: dict,
    conversation_id: Optional[str] = None,
    mcp_server_url: Optional[str] = None,
    skip_lines: int = 0,
    on_session_init: Optional[Callable[[str, str], None]] = None,
    on_agent_end: Optional[Callable[[str], None]] = None,
) -> Optional[FilePoller]:
    """Create and start a FilePoller. Returns the poller handle for cleanup."""
    try:
        try:
            if not await sandbox.files.exists(events_path):
                await sandbox.files.write(events_path, "")
        except Exception as e:
            logger.warning(f"Could not create events file: {e}")

        poller = FilePoller(
            sandbox, events_path, storage, conversation_id, mcp_server_url,
            on_session_init, on_agent_end,
        )
        poller.last_line_count = skip_lines
        await poller.start()
        return poller

    except Exception as e:
        logger.exception(f"Failed to start file poller: {e}")
        return None


# ── utils ─────────────────────────────────────────────────────────────

def _validate_id(conversation_id: Optional[str]) -> Optional[str]:
    if conversation_id is None:
        return None
    if not SAFE_ID_PATTERN.match(conversation_id):
        logger.warning(f"Invalid conversation_id format: {conversation_id[:50]}")
        return None
    return conversation_id
