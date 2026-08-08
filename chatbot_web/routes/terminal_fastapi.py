"""
FastAPI WebSocket endpoint for interactive terminal sessions via E2B sandbox.

Provides a dedicated WebSocket at /api/terminal/ws for real-time shell access.
"""

import os
import sys
import asyncio
import logging
from typing import Dict, Any, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, Depends

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from e2b_code_interpreter import AsyncSandbox
from e2b.exceptions import NotFoundException
from e2b import PtySize

from config import WORKSPACE_DIR
from middleware.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/terminal", tags=["terminal"])

# Active terminal sessions: websocket_id -> session_info
_terminal_sessions: Dict[str, Dict[str, Any]] = {}


async def _resolve_sandbox_for_user(user_id: Optional[int]) -> Optional[str]:
    """Get or create sandbox for a user, with fallback to shared."""
    try:
        if user_id:
            from services.sandbox_service import get_or_create_user_sandbox
            return await get_or_create_user_sandbox(user_id)

        from services.sandbox_service import (
            get_shared_sandbox_id as svc_get_id,
            get_or_create_shared_sandbox,
        )
        sandbox_id = svc_get_id()
        if not sandbox_id:
            sandbox_id = await get_or_create_shared_sandbox()
        return sandbox_id
    except ImportError as e:
        logger.error("Could not import sandbox service: %s", e)
        return None


def _decode_ws_token(token: str) -> Optional[dict]:
    """Decode a JWT from WebSocket query parameter."""
    try:
        from middleware.auth import _decode_token
        return _decode_token(token)
    except Exception:
        return None


@router.websocket("/ws")
async def terminal_websocket(
    websocket: WebSocket,
    sandbox_id: Optional[str] = Query(None, description="Sandbox ID to connect to"),
    token: Optional[str] = Query(None, description="JWT token for auth"),
):
    """
    WebSocket endpoint for interactive terminal sessions.

    Protocol:
    - Client sends: {"type": "input", "data": "..."}  # User input
    - Client sends: {"type": "resize", "cols": 80, "rows": 24}  # Terminal resize
    - Server sends: {"type": "output", "data": "..."}  # Shell output
    - Server sends: {"type": "ready"}  # Terminal is ready
    - Server sends: {"type": "error", "message": "..."}  # Error occurred
    """
    await websocket.accept()

    session_id = id(websocket)
    sandbox = None
    terminal = None

    # Authenticate via token query param or cookie
    user_id = None
    if token:
        payload = _decode_ws_token(token)
        if payload:
            user_id = payload.get("user_id")
    if not user_id:
        # Try cookie fallback
        session_cookie = websocket.cookies.get("session")
        if session_cookie:
            payload = _decode_ws_token(session_cookie)
            if payload:
                user_id = payload.get("user_id")

    try:
        # Get sandbox ID
        if not sandbox_id:
            sandbox_id = await _resolve_sandbox_for_user(user_id)

        if not sandbox_id:
            try:
                await websocket.send_json({
                    "type": "error",
                    "message": "No sandbox available. Please start a chat first to initialize the sandbox."
                })
            except:
                pass
            await websocket.close()
            return

        # Connect to sandbox
        try:
            sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
            logger.info(f"Terminal connected to sandbox: {sandbox_id}")
        except NotFoundException:
            try:
                await websocket.send_json({
                    "type": "error",
                    "message": f"Sandbox {sandbox_id} not found. It may have expired."
                })
            except:
                pass
            await websocket.close()
            return
        except Exception as e:
            try:
                await websocket.send_json({
                    "type": "error",
                    "message": f"Failed to connect to sandbox: {str(e)}"
                })
            except:
                pass
            await websocket.close()
            return

        # Store session early so send_output can check it
        _terminal_sessions[session_id] = {
            "sandbox": sandbox,
            "terminal": None,
            "terminal_pid": None,
            "sandbox_id": sandbox_id,
        }

        # Create PTY terminal
        try:
            # Create a PTY with bash shell
            terminal = await sandbox.pty.create(
                size=PtySize(rows=24, cols=80),
                on_data=lambda data: asyncio.create_task(
                    send_output(websocket, data, session_id)
                ),
                cwd=WORKSPACE_DIR,
                envs={"TERM": "xterm-256color"},
            )

            # Get the PID from terminal handle
            terminal_pid = terminal.pid

            # Update session with terminal info
            _terminal_sessions[session_id].update({
                "terminal": terminal,
                "terminal_pid": terminal_pid,
            })

            # Notify client terminal is ready
            await websocket.send_json({"type": "ready"})
            logger.info(f"Terminal PTY created for session {session_id}")

        except Exception as e:
            logger.error(f"Failed to create PTY: {e}")
            # Remove session since PTY creation failed
            _terminal_sessions.pop(session_id, None)
            try:
                await websocket.send_json({
                    "type": "error",
                    "message": f"Failed to create terminal: {str(e)}"
                })
            except:
                pass
            await websocket.close()
            return

        # Handle incoming messages
        while True:
            try:
                message = await websocket.receive_json()
                msg_type = message.get("type")

                if msg_type == "input":
                    # Send input to terminal via sandbox.pty.send_stdin
                    data = message.get("data", "")
                    if data and sandbox and terminal:
                        # Convert string to bytes for send_stdin
                        await sandbox.pty.send_stdin(terminal.pid, data.encode('utf-8'))

                elif msg_type == "resize":
                    # Resize terminal via sandbox.pty.resize
                    cols = message.get("cols", 80)
                    rows = message.get("rows", 24)
                    if sandbox and terminal:
                        await sandbox.pty.resize(terminal.pid, PtySize(rows=rows, cols=cols))
                        logger.debug(f"Terminal resized to {cols}x{rows}")

                elif msg_type == "ping":
                    # Respond to ping for keepalive
                    await websocket.send_json({"type": "pong"})

            except WebSocketDisconnect:
                logger.info(f"Terminal WebSocket disconnected: {session_id}")
                break
            except Exception as e:
                logger.error(f"Error handling terminal message: {e}")
                break

    except WebSocketDisconnect:
        logger.info(f"Terminal WebSocket disconnected during setup: {session_id}")
    except Exception as e:
        logger.exception(f"Terminal WebSocket error: {e}")
    finally:
        # Cleanup
        session = _terminal_sessions.pop(session_id, None)
        if session:
            sandbox = session.get("sandbox")
            terminal_pid = session.get("terminal_pid")
            if sandbox and terminal_pid:
                try:
                    await sandbox.pty.kill(terminal_pid)
                    logger.info(f"Terminal PTY killed for session {session_id}")
                except Exception as e:
                    logger.warning(f"Error killing terminal: {e}")


async def send_output(websocket: WebSocket, data: bytes, session_id: int):
    """Send terminal output to the WebSocket client."""
    # Check if session is still active before sending
    if session_id not in _terminal_sessions:
        return

    try:
        # Decode bytes to string for JSON transmission
        text = data.decode('utf-8', errors='replace')
        await websocket.send_json({
            "type": "output",
            "data": text
        })
    except WebSocketDisconnect:
        # WebSocket disconnected, silently ignore
        pass
    except Exception as e:
        logger.debug(f"Failed to send terminal output: {e}")


@router.get("/status")
async def terminal_status(user=Depends(get_current_user)):
    """Get status of active terminal sessions."""
    return {
        "active_sessions": len(_terminal_sessions),
    }
