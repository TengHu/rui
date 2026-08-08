"""
Background file watcher for sandbox workspace changes.

Emits Socket.IO events when files are created, modified, or deleted.
Supports multiple concurrent watchers (one per sandbox) for multi-tenancy.
"""

import asyncio
import logging
from typing import Dict, Optional

from e2b_code_interpreter import AsyncSandbox

logger = logging.getLogger(__name__)

# Per-sandbox watcher tasks keyed by sandbox_id
_file_watchers: Dict[str, asyncio.Task] = {}


async def _watch_workspace_files(sandbox_id: str, workspace_dir: str, user_id: Optional[int] = None):
    """Watch workspace files for changes and emit Socket.IO events scoped to user."""
    from services.event_bus_fastapi import emit_file_changed_sync

    watched_files: Dict[str, tuple] = {}
    watch_extensions = ('.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.json')

    logger.info(f"Starting file watcher for sandbox {sandbox_id} (user_id={user_id})")

    try:
        sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)

        while True:
            try:
                files = await sandbox.files.list(workspace_dir)
                current_files = set()

                for f in files:
                    if not f.name.endswith(watch_extensions):
                        continue

                    file_path = f"{workspace_dir}/{f.name}"
                    current_files.add(file_path)
                    file_key = (
                        getattr(f, 'modified_at', None) or getattr(f, 'mtime', 0),
                        getattr(f, 'size', 0),
                    )

                    if file_path in watched_files:
                        if watched_files[file_path] != file_key:
                            logger.info(f"File modified: {file_path}")
                            emit_file_changed_sync(sandbox_id, file_path, "modified", user_id=user_id)
                            watched_files[file_path] = file_key
                    else:
                        if watched_files:
                            logger.info(f"File created: {file_path}")
                            emit_file_changed_sync(sandbox_id, file_path, "created", user_id=user_id)
                        watched_files[file_path] = file_key

                for file_path in list(watched_files.keys()):
                    if file_path not in current_files:
                        logger.info(f"File deleted: {file_path}")
                        emit_file_changed_sync(sandbox_id, file_path, "deleted", user_id=user_id)
                        del watched_files[file_path]

            except Exception as e:
                logger.warning(f"File watcher error: {e}")

            await asyncio.sleep(0.5)

    except asyncio.CancelledError:
        logger.info(f"File watcher stopped for sandbox {sandbox_id}")
    except Exception as e:
        logger.exception(f"File watcher crashed: {e}")


def start_file_watcher_if_needed(sandbox_id: str, workspace_dir: str, user_id: Optional[int] = None):
    """Start the file watcher background task for a sandbox if not already running."""
    existing = _file_watchers.get(sandbox_id)
    if existing is not None and not existing.done():
        return

    _file_watchers[sandbox_id] = asyncio.create_task(
        _watch_workspace_files(sandbox_id, workspace_dir, user_id=user_id)
    )
    logger.info(f"Started file watcher for sandbox {sandbox_id} (user_id={user_id})")
