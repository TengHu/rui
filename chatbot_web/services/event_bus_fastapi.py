"""
WebSocket event bus for real-time window updates using python-socketio with FastAPI.

Uses python-socketio (async mode) for native FastAPI integration.
All emissions are scoped to per-user rooms for multi-tenancy isolation.
"""

import logging
import socketio
from http.cookies import SimpleCookie
from typing import Dict, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from models.window_spec import WindowRecord
    from models.route_window import RouteWindowRecord

logger = logging.getLogger(__name__)

# Create async Socket.IO server
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
)

# Create ASGI app for Socket.IO
socket_app = socketio.ASGIApp(sio)

# Flag to track if already initialized
_initialized = False

# Map socket ID -> user_id for lookup during events
_sid_to_user: Dict[str, int] = {}


def _user_room(user_id: int) -> str:
    """Return the Socket.IO room name for a given user."""
    return f"user_{user_id}"


def _parse_user_id_from_environ(environ: dict) -> Optional[int]:
    """Extract user_id from the session JWT cookie in a Socket.IO environ dict."""
    from middleware.auth import _decode_token
    from jose import JWTError

    cookie_header = environ.get("HTTP_COOKIE", "")
    if not cookie_header:
        return None

    cookie = SimpleCookie()
    cookie.load(cookie_header)
    session_morsel = cookie.get("session")
    if not session_morsel:
        return None

    try:
        payload = _decode_token(session_morsel.value)
    except (JWTError, RuntimeError):
        return None

    user_id = payload.get("user_id")
    if not isinstance(user_id, int):
        return None
    return user_id


def _emit_to_user_room(event_name: str, data: dict, user_id: Optional[int]):
    """Schedule a Socket.IO emit scoped to a user room (sync context helper).

    If user_id is None the event is silently dropped to prevent
    accidental global broadcasts.
    """
    import asyncio

    if user_id is None:
        logger.warning("Dropping %s emit: no user_id (would broadcast globally)", event_name)
        return

    kwargs = {"event": event_name, "data": data, "room": _user_room(user_id)}

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(sio.emit(**kwargs))
        else:
            loop.run_until_complete(sio.emit(**kwargs))
    except RuntimeError:
        asyncio.run(sio.emit(**kwargs))


def init_socketio(app):
    """Initialize Socket.IO with FastAPI app."""
    global _initialized
    if _initialized:
        return

    # Mount Socket.IO at /socket.io/
    app.mount("/socket.io", socket_app)

    @sio.event
    async def connect(sid, environ):
        """Authenticate via session cookie and send user-scoped snapshot."""
        user_id = _parse_user_id_from_environ(environ)
        if user_id is None:
            logger.warning("Socket.IO connect rejected: no valid session (sid=%s)", sid)
            return False

        _sid_to_user[sid] = user_id
        sio.enter_room(sid, _user_room(user_id))
        logger.info("Socket.IO connect: sid=%s user_id=%s", sid, user_id)

        from stores.window_store import window_store

        windows = window_store.get_all_for_user(user_id)
        await sio.emit("snapshot", [w.to_client_dict() for w in windows], to=sid)

    @sio.event
    async def disconnect(sid):
        """Clean up user mapping on disconnect."""
        user_id = _sid_to_user.pop(sid, None)
        logger.info("Socket.IO disconnect: sid=%s user_id=%s", sid, user_id)

    @sio.event
    async def broadcast_selection(sid, selection):
        """Broadcast a selection event to the same user's other tabs/windows."""
        user_id = _sid_to_user.get(sid)
        if user_id is None:
            return
        await sio.emit(
            "selection_changed",
            selection,
            room=_user_room(user_id),
            skip_sid=sid,
        )

    # Register window store listener to broadcast updates to owner's room
    from stores.window_store import window_store

    def on_window_change(event_type: str, record: "WindowRecord"):
        """Broadcast window changes to the owning user's room."""
        event_name = f"window_{event_type}"
        _emit_to_user_room(event_name, record.to_client_dict(), record.user_id)

    window_store.add_listener(on_window_change)

    # Register route window store listener to broadcast updates to owner's room
    from models.route_window import route_window_store

    def on_route_window_change(event_type: str, record: "RouteWindowRecord"):
        """Broadcast route window changes to the owning user's room."""
        event_name = f"route_window_{event_type}"
        _emit_to_user_room(event_name, record.to_client_dict(), record.user_id)

    route_window_store.add_listener(on_route_window_change)

    _initialized = True


# ── Async emit helpers (user-scoped) ─────────────────────────────────

async def emit_window_event(event_type: str, window: "WindowRecord"):
    """Broadcast a window event to the owning user's room."""
    if window.user_id is None:
        logger.warning("Dropping window_%s emit: no user_id", event_type)
        return
    event_name = f"window_{event_type}"
    await sio.emit(event_name, window.to_client_dict(), room=_user_room(window.user_id))


async def emit_route_window_event(event_type: str, window: "RouteWindowRecord"):
    """Broadcast a route window event to the owning user's room."""
    if window.user_id is None:
        logger.warning("Dropping route_window_%s emit: no user_id", event_type)
        return
    event_name = f"route_window_{event_type}"
    await sio.emit(event_name, window.to_client_dict(), room=_user_room(window.user_id))


async def emit_file_changed(
    sandbox_id: str,
    file_path: str,
    change_type: str = "modified",
    user_id: Optional[int] = None,
):
    """Broadcast a file change event scoped to the user's room."""
    if user_id is None:
        logger.warning("Dropping file_changed emit: no user_id")
        return
    import time

    data = {
        "sandbox_id": sandbox_id,
        "path": file_path,
        "change_type": change_type,
        "timestamp": time.time(),
    }
    await sio.emit("file_changed", data, room=_user_room(user_id))


# ── Sync emit helpers (for store listeners / non-async contexts) ─────

def emit_window_event_sync(event_type: str, window: "WindowRecord"):
    """Sync version of emit_window_event scoped to user room."""
    event_name = f"window_{event_type}"
    _emit_to_user_room(event_name, window.to_client_dict(), window.user_id)


def emit_route_window_event_sync(event_type: str, window: "RouteWindowRecord"):
    """Sync version of emit_route_window_event scoped to user room."""
    event_name = f"route_window_{event_type}"
    _emit_to_user_room(event_name, window.to_client_dict(), window.user_id)


def emit_file_changed_sync(
    sandbox_id: str,
    file_path: str,
    change_type: str = "modified",
    user_id: Optional[int] = None,
):
    """Sync version of emit_file_changed scoped to user room."""
    import time

    data = {
        "sandbox_id": sandbox_id,
        "path": file_path,
        "change_type": change_type,
        "timestamp": time.time(),
    }
    _emit_to_user_room("file_changed", data, user_id)
