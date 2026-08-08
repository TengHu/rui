"""
FastAPI REST API routes for RouteWindow operations - MCP app windows.

Endpoints:
- GET  /api/route-windows           - List all route windows
- POST /api/route-windows           - Create a new route window
- GET  /api/route-windows/:id       - Get single route window
- DELETE /api/route-windows/:id     - Delete route window
- POST /api/route-windows/:id/chat  - Send message to window's agent (runs in sandbox)
- GET  /api/route-windows/:id/events - SSE stream for window's agent events
- GET  /api/route-windows/:id/sandbox-url - Get sandbox URL for window
- PATCH /api/route-windows/:id/additional-prompt - Update per-window additional prompt
- PATCH /api/route-windows/:id/position - Update window position
- PATCH /api/route-windows/:id/size - Update window size
"""

import os
import sys
import asyncio
import logging
import json
import time
from typing import Optional, Dict, Any

import httpx

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from middleware.auth import get_current_user

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from models.route_window import route_window_store
from e2b_code_interpreter import AsyncSandbox
from sandbox_runner import run_agent, AGENT_SPECS, DEFAULT_AGENT, upload_agent

from config import WORKSPACE_DIR, MCP_SERVER_PORT
from services.error_utils import sanitize_error
from services.event_manager import window_events
from services.mcp_client import (
    build_mcp_server_url,
    resolve_e2b_domain,
    get_mcp_health,
    mcp_rpc,
)
from services.system_prompts import build_system_prompt
from services.file_watcher import start_file_watcher_if_needed
from services.chat_session import count_existing_lines, finalize_mcp, build_chat_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/route-windows", tags=["route-windows"])


def _check_window_owner(window, user_id: int) -> None:
    """Raise 403 if the window does not belong to the user."""
    if window.user_id is not None and window.user_id != user_id:
        raise HTTPException(status_code=403, detail="Forbidden")


# ── Pydantic models ──────────────────────────────────────────────────

MAX_ADDITIONAL_PROMPT_LENGTH = 5000


class CreateRouteWindowRequest(BaseModel):
    title: str = "New Window"
    window_type: str = "mcp"
    port: Optional[int] = None  # Optional: force a specific port (for registered apps)
    additional_prompt: Optional[str] = None
    position: Optional[Dict[str, int]] = None
    size: Optional[Dict[str, int]] = None

    @field_validator("window_type")
    @classmethod
    def validate_window_type(cls, v: str) -> str:
        if v not in ("mcp", "common"):
            raise ValueError("window_type must be 'mcp' or 'common'")
        return v

    @field_validator("additional_prompt")
    @classmethod
    def validate_additional_prompt(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        if len(v) > MAX_ADDITIONAL_PROMPT_LENGTH:
            raise ValueError(f"additional_prompt must be at most {MAX_ADDITIONAL_PROMPT_LENGTH} characters")
        return v


class ChatRequest(BaseModel):
    message: str
    sandbox_id: Optional[str] = None
    session_id: Optional[str] = None


class PositionRequest(BaseModel):
    x: int = 0
    y: int = 0


class SizeRequest(BaseModel):
    width: int = 600
    height: int = 400


class McpToolCallRequest(BaseModel):
    tool_name: str
    arguments: Optional[Dict[str, Any]] = None


class AppLogRequest(BaseModel):
    level: str
    data: Any
    logger: Optional[str] = None


class EnsureAppRequest(BaseModel):
    sandbox_id: Optional[str] = None


class AdditionalPromptRequest(BaseModel):
    additional_prompt: str

    @field_validator("additional_prompt")
    @classmethod
    def validate_additional_prompt(cls, v: str) -> str:
        v = v.strip()
        if len(v) > MAX_ADDITIONAL_PROMPT_LENGTH:
            raise ValueError(f"additional_prompt must be at most {MAX_ADDITIONAL_PROMPT_LENGTH} characters")
        return v


# ── CRUD endpoints ───────────────────────────────────────────────────

@router.get("")
async def get_all_route_windows(user=Depends(get_current_user)):
    """Get all route windows for the current user."""
    windows = route_window_store.get_all_for_user(user["user_id"])
    return [w.to_client_dict() for w in windows]


def _read_local_registry_ports() -> set:
    """Read ports claimed by pre-built apps from local .common_app_registry/*.json."""
    registry_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "assets", ".common_app_registry",
    )
    ports = set()
    if not os.path.exists(registry_dir):
        return ports
    for filename in os.listdir(registry_dir):
        if not filename.endswith(".json"):
            continue
        try:
            with open(os.path.join(registry_dir, filename), "r") as f:
                data = json.loads(f.read())
                port = data.get("port")
                if isinstance(port, int):
                    ports.add(port)
        except Exception:
            pass
    return ports


async def _read_sandbox_registry_ports(sandbox_id: str) -> set:
    """Read ports from .common_app_registry/ inside the sandbox."""
    ports = set()
    try:
        sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
        registry_dir = f"{WORKSPACE_DIR}/.common_app_registry"
        files = await sandbox.files.list(registry_dir)
        for f in files:
            if not f.name.endswith(".json"):
                continue
            try:
                content = await sandbox.files.read(f"{registry_dir}/{f.name}")
                data = json.loads(content)
                port = data.get("port")
                if isinstance(port, int):
                    ports.add(port)
            except Exception:
                pass
    except Exception:
        pass
    return ports


@router.post("", status_code=201)
async def create_route_window(request: CreateRouteWindowRequest, user=Depends(get_current_user)):
    """Create a new route window."""
    title = request.title.strip()
    user_id = user["user_id"]

    try:
        # For common windows without an explicit port, gather occupied ports
        # from the app registry so we don't collide with registered apps.
        registry_ports = set()
        if request.window_type == "common" and request.port is None:
            registry_ports = _read_local_registry_ports()
            from services.sandbox_service import get_or_create_user_sandbox
            sandbox_id = await get_or_create_user_sandbox(user_id)
            if sandbox_id:
                registry_ports |= await _read_sandbox_registry_ports(sandbox_id)

        record = route_window_store.create(
            title=title,
            additional_prompt=request.additional_prompt,
            window_type=request.window_type,
            port=request.port,
            registry_ports=registry_ports,
            user_id=user_id,
        )

        if request.position:
            route_window_store.update(record.id, position=request.position)
        if request.size:
            route_window_store.update(record.id, size=request.size)

        record = route_window_store.get(record.id)
        window_events.init_channel(record.id)

        logger.info(f"Created route window {record.id}: {record.title} for user {user_id}")
        return record.to_client_dict()

    except Exception as e:
        logger.exception(f"Failed to create route window: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{window_id}")
async def get_route_window(window_id: str, user=Depends(get_current_user)):
    """Get a single route window by ID."""
    window = route_window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])
    return window.to_client_dict()


@router.delete("/{window_id}")
async def delete_route_window(window_id: str, user=Depends(get_current_user)):
    """Delete a route window and clean up resources."""
    window = route_window_store.get(window_id)
    if window:
        _check_window_owner(window, user["user_id"])

    # Kill the process on the window's port before deleting
    if window and window.window_type == "common" and window.port and window.sandbox_id:
        try:
            sandbox = await AsyncSandbox.connect(sandbox_id=window.sandbox_id)
            lsof_result = await sandbox.commands.run(
                f"lsof -t -i:{window.port}",
                timeout=5,
            )
            pid = (lsof_result.stdout or "").strip()
            if pid:
                await sandbox.commands.run(f"kill {pid}", timeout=5)
                logger.info(f"Killed process {pid} on port {window.port} for window {window_id}")
            else:
                logger.info(f"No process found on port {window.port} for window {window_id}")
        except Exception as e:
            logger.warning(f"Failed to kill port {window.port} for window {window_id}: {e}")

    poller = window_events.remove_channel(window_id)
    if poller:
        try:
            await poller.stop()
        except Exception as e:
            logger.warning(f"Error stopping poller for window {window_id}: {type(e).__name__}: {e}")

    if route_window_store.delete(window_id):
        logger.info(f"Deleted route window {window_id}")
        return {"success": True, "id": window_id}
    raise HTTPException(status_code=404, detail="Window not found")


# ── Ensure app endpoint ─────────────────────────────────────────────

@router.post("/{window_id}/ensure-app")
async def ensure_app(window_id: str, request: EnsureAppRequest, user=Depends(get_current_user)):
    """Check if a common app's port is running; if not, look up registry and start it."""
    window = route_window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    if window.window_type != "common" or not window.port:
        return {"started": False, "reason": "not a common window with a port"}

    try:
        sandbox_id = await _resolve_window_sandbox(window, request.sandbox_id, user_id=user["user_id"])
        if not sandbox_id:
            raise HTTPException(status_code=500, detail="No sandbox available")

        sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
        e2b_domain = await resolve_e2b_domain(sandbox_id)
        port = window.port

        # Check if port is already running
        check = await sandbox.commands.run(
            f"curl -sf http://localhost:{port}/ -o /dev/null || echo __DOWN__",
            timeout=5,
        )
        port_is_up = "__DOWN__" not in (check.stdout or "")

        if port_is_up:
            sandbox_url = f"https://{port}-{sandbox_id}.{e2b_domain}"
            route_window_store.update(window_id, sandbox_id=sandbox_id, sandbox_url=sandbox_url)
            return {"started": True, "sandbox_url": sandbox_url, "sandbox_id": sandbox_id}

        # Port not running — look up .common_app_registry/ for a matching app
        registry_dir = f"{WORKSPACE_DIR}/.common_app_registry"
        registry_app = None
        try:
            files = await sandbox.files.list(registry_dir)
            for f in files:
                if not f.name.endswith(".json"):
                    continue
                try:
                    content = await sandbox.files.read(f"{registry_dir}/{f.name}")
                    app_data = json.loads(content)
                    if app_data.get("port") == port:
                        registry_app = app_data
                        break
                except Exception as e:
                    logger.warning(f"Failed to read registry file {f.name}: {e}")
        except Exception:
            pass  # Registry dir may not exist yet

        if not registry_app:
            return {"started": False, "registered": False}

        # Found a registered app — start it
        app_dir = registry_app.get("app_dir") or registry_app.get("directory", "")
        command = registry_app.get("command", "")
        if not app_dir or not command:
            return {"started": False, "registered": True, "reason": "missing directory or command"}

        await sandbox.commands.run(
            f"cd {app_dir} && {command} &",
            timeout=10,
            background=True,
        )
        logger.info(f"Started registered app on port {port}: cd {app_dir} && {command}")

        # Poll until the port comes up (max ~10 retries, 1s apart)
        started = False
        for _ in range(10):
            await asyncio.sleep(1)
            poll = await sandbox.commands.run(
                f"curl -sf http://localhost:{port}/ -o /dev/null || echo __DOWN__",
                timeout=5,
            )
            if "__DOWN__" not in (poll.stdout or ""):
                started = True
                break

        if started:
            sandbox_url = f"https://{port}-{sandbox_id}.{e2b_domain}"
            route_window_store.update(window_id, sandbox_id=sandbox_id, sandbox_url=sandbox_url)
            return {"started": True, "sandbox_url": sandbox_url, "sandbox_id": sandbox_id}

        return {"started": False, "registered": True, "reason": "port did not come up after start"}

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error in ensure-app for window {window_id}: {e}")
        raise HTTPException(status_code=500, detail=sanitize_error(str(e)))


# ── SSE endpoint ─────────────────────────────────────────────────────

@router.get("/{window_id}/events")
async def route_window_events(window_id: str, user=Depends(get_current_user)):
    """Server-Sent Events endpoint for streaming window agent events."""
    return StreamingResponse(
        window_events.sse_generator(window_id, {"windowId": window_id}),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ── Chat handler helpers ─────────────────────────────────────────────

async def _resolve_window_sandbox(window, requested_sandbox_id, user_id=None):
    """Resolve sandbox_id for a route window.

    When user_id is provided the sandbox is always scoped to that user —
    the client-supplied requested_sandbox_id is intentionally ignored to
    prevent one user from pointing their window at another user's sandbox.
    """
    if user_id:
        from services.database import get_active_sandbox
        from services.sandbox_service import get_or_create_user_sandbox

        # Fast path: if the window already holds the user's active sandbox,
        # return it immediately without an alive-check network round-trip.
        if window.sandbox_id:
            user_sandbox = await get_active_sandbox(user_id)
            if user_sandbox == window.sandbox_id:
                logger.info("RouteWindow reusing sandbox %s for user %s", window.sandbox_id, user_id)
                return window.sandbox_id

        # Authoritative path: derive the correct sandbox for this user.
        sandbox_id = await get_or_create_user_sandbox(user_id)
        if sandbox_id:
            window.sandbox_id = sandbox_id
            logger.info("RouteWindow sandbox %s for user %s", sandbox_id, user_id)
        return sandbox_id

    # Legacy path: no authenticated user (should not reach here in normal flow).
    if window.sandbox_id:
        logger.info("RouteWindow reusing sandbox %s (no user_id)", window.sandbox_id)
        return window.sandbox_id

    from services.sandbox_service import get_or_create_shared_sandbox
    sandbox_id = await get_or_create_shared_sandbox()
    if sandbox_id:
        window.sandbox_id = sandbox_id
    return sandbox_id


async def _ensure_mcp_ready(sandbox, sandbox_id, e2b_domain, events_path, storage):
    """Ensure the MCP server is running and verified. Returns mcp_server_url."""
    await _check_or_start_mcp_server(sandbox)

    try:
        url = f"https://{MCP_SERVER_PORT}-{sandbox_id}.{e2b_domain}/set-events-file"
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(url, json={"eventsFile": events_path})
        logger.info(f"Set MCP server events file to: {events_path}")
    except Exception as e:
        logger.warning(f"Failed to set events file on MCP server: {e}")

    mcp_server_url = build_mcp_server_url(sandbox_id, e2b_domain)
    await _verify_mcp_preflight(sandbox, sandbox_id, e2b_domain, mcp_server_url, storage)
    return mcp_server_url


async def _check_or_start_mcp_server(sandbox):
    """Ensure the shared MCP server is running on port 3000."""
    try:
        check = await sandbox.commands.run(
            "curl -sf http://localhost:3000/health || echo __MCP_DOWN__",
            timeout=5,
        )
        if "__MCP_DOWN__" in (check.stdout or ""):
            logger.info("MCP server not running, starting it...")
            from services.sandbox_service import _start_mcp_server
            await _start_mcp_server(sandbox, WORKSPACE_DIR)
            await asyncio.sleep(1)
    except Exception as e:
        logger.warning(f"MCP server health check failed, attempting start: {e}")
        try:
            from services.sandbox_service import _start_mcp_server
            await _start_mcp_server(sandbox, WORKSPACE_DIR)
            await asyncio.sleep(1)
        except Exception as e2:
            logger.error(f"Failed to start MCP server: {e2}")


async def _verify_mcp_preflight(sandbox, sandbox_id, e2b_domain, mcp_server_url, storage):
    """Run MCP pre-flight verification and emit status event."""
    from services.mcp_connection import verify_mcp_connection, MCPConnectionState

    health_url = f"https://{MCP_SERVER_PORT}-{sandbox_id}.{e2b_domain}/health"
    result = await verify_mcp_connection(
        mcp_server_url=mcp_server_url,
        health_url=health_url,
        max_retries=3,
        retry_delay=1.0,
    )

    logger.info(
        "MCP pre-flight: state=%s tools=%d meta_tools=%s latency=%.0fms",
        result.state.value, len(result.tools_available),
        result.meta_tools_present, result.latency_ms,
    )

    if storage is not None:
        storage["events"].append({
            "type": "mcp_connection_status",
            "ts": time.time(),
            "data": {
                "state": result.state.value,
                "tools_available": list(result.tools_available),
                "meta_tools_present": result.meta_tools_present,
                "error": result.error,
                "latency_ms": result.latency_ms,
            },
        })

    if result.state == MCPConnectionState.FAILED:
        await _handle_mcp_failure(sandbox, result)


async def _handle_mcp_failure(sandbox, verification):
    """Try in-sandbox fallback when public MCP URL fails."""
    logger.warning("Public MCP URL unreachable, trying in-sandbox fallback...")
    try:
        fallback = await sandbox.commands.run(
            "curl -sf http://localhost:3000/health || echo __MCP_DOWN__",
            timeout=5,
        )
        if "__MCP_DOWN__" in (fallback.stdout or ""):
            raise HTTPException(status_code=503, detail=f"MCP server unavailable: {verification.error}")
        logger.info("MCP server verified via in-sandbox fallback (localhost:3000)")
    except HTTPException:
        raise
    except Exception as err:
        logger.error("In-sandbox MCP fallback also failed: %s", err)
        raise HTTPException(status_code=503, detail=f"MCP server unavailable: {verification.error}")


async def _prepare_sandbox(sandbox_id, window_id, window, storage):
    """Connect to sandbox, upload agent, resolve domain. Returns (sandbox, spec, events_path, skip_lines, e2b_domain, mcp_server_base)."""
    sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
    is_common = window.window_type == "common"

    start_file_watcher_if_needed(sandbox_id, WORKSPACE_DIR, user_id=window.user_id)

    try:
        await sandbox.set_timeout(3600)
    except Exception as e:
        logger.warning(f"Could not set sandbox timeout: {e}")

    events_path = f"/tmp/events_{window_id}.jsonl"
    skip_lines = await count_existing_lines(sandbox, events_path)

    spec = AGENT_SPECS[DEFAULT_AGENT]
    await upload_agent(sandbox=sandbox, cwd=WORKSPACE_DIR, spec=spec)

    e2b_domain = await resolve_e2b_domain(sandbox_id)

    mcp_server_base = None
    if not is_common:
        mcp_server_base = await _ensure_mcp_ready(
            sandbox, sandbox_id, e2b_domain, events_path, storage,
        )

    return sandbox, spec, events_path, skip_lines, e2b_domain, mcp_server_base


async def _execute_and_collect(window, window_id, sandbox, sandbox_id, spec,
                                events_path, skip_lines, e2b_domain,
                                mcp_server_base, message, request):
    """Run agent, wait for delivery, capture session, and build response metadata."""
    poller = await window_events.start_poller(
        window_id, sandbox, events_path,
        skip_lines=skip_lines, mcp_server_url=mcp_server_base,
    )

    session_id = (
        request.session_id
        or window.session_id
        or window_events.get_session_id(window_id)
    )
    if session_id:
        logger.info(f"Window {window_id} resuming session: {session_id}")

    system_prompt = build_system_prompt(
        window.window_type, window.port, window_id, window.additional_prompt,
    )

    agent_result = await run_agent(
        sandbox=sandbox, query=message, cwd=WORKSPACE_DIR,
        spec=spec, system_prompt=system_prompt,
        session_id=session_id, events_file=events_path,
    )

    if poller:
        await window_events.wait_for_delivery(window_id, poller)

    new_session_id = window_events.get_session_id(window_id)
    if new_session_id:
        window.session_id = new_session_id
        logger.info(f"Window {window_id} captured session_id: {new_session_id}")

    is_common = window.window_type == "common"
    mcp_tool_name = mcp_resource_uri = mcp_tools = None
    if is_common:
        sandbox_url = f"https://{window.port}-{sandbox_id}.{e2b_domain}"
    else:
        sandbox_url = f"https://{MCP_SERVER_PORT}-{sandbox_id}.{e2b_domain}"
        mcp_tool_name, mcp_resource_uri, mcp_tools = await finalize_mcp(
            sandbox, sandbox_id, e2b_domain, events_path, mcp_server_base, window,
        )

    return agent_result, new_session_id, sandbox_url, mcp_server_base, mcp_tool_name, mcp_resource_uri, mcp_tools


# ── Chat endpoint ────────────────────────────────────────────────────

@router.post("/{window_id}/chat")
async def route_window_chat(window_id: str, request: ChatRequest, user=Depends(get_current_user)):
    """Send a message to the window's agent - executes in sandbox."""
    window = route_window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    message = request.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")

    storage, message_id = window_events.init_channel(window_id)
    window.set_loading(True)
    route_window_store.update(window_id, is_loading=True)

    try:
        sandbox_id = await _resolve_window_sandbox(window, request.sandbox_id, user_id=user["user_id"])
        if not sandbox_id:
            raise HTTPException(status_code=500, detail="No sandbox available")

        sandbox, spec, events_path, skip_lines, e2b_domain, mcp_server_base = (
            await _prepare_sandbox(sandbox_id, window_id, window, storage)
        )

        agent_result, new_session_id, sandbox_url, mcp_server_base, mcp_tool_name, mcp_resource_uri, mcp_tools = (
            await _execute_and_collect(
                window, window_id, sandbox, sandbox_id, spec,
                events_path, skip_lines, e2b_domain,
                mcp_server_base, message, request,
            )
        )

        return build_chat_response(
            agent_result, window, window_id, sandbox_id, e2b_domain,
            mcp_server_base, window.window_type == "common", message_id,
            new_session_id, sandbox_url, mcp_tool_name, mcp_resource_uri, mcp_tools,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error in route window chat: {e}")
        window.set_loading(False)
        route_window_store.update(window_id, is_loading=False)
        raise HTTPException(status_code=500, detail=sanitize_error(str(e)))


# ── Sandbox URL endpoint ─────────────────────────────────────────────

@router.get("/{window_id}/sandbox-url")
async def get_sandbox_url(window_id: str, user=Depends(get_current_user)):
    """Get the sandbox URL for this window."""
    window = route_window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    sandbox_id = window.sandbox_id
    if not sandbox_id:
        return {"error": "No sandbox for this window", "url": None}

    e2b_domain = await resolve_e2b_domain(sandbox_id)
    url_port = window.port if window.window_type == "common" and window.port else MCP_SERVER_PORT
    url = f"https://{url_port}-{sandbox_id}.{e2b_domain}"

    return {"url": url, "sandbox_id": sandbox_id}


# ── MCP tool endpoints ───────────────────────────────────────────────

@router.get("/sandbox/{sandbox_id}/mcp-tools")
async def list_mcp_tools_for_sandbox(sandbox_id: str, user=Depends(get_current_user)):
    """List all MCP tools available in a sandbox via MCP protocol's tools/list."""
    if not sandbox_id:
        raise HTTPException(status_code=400, detail="sandbox_id is required")

    try:
        e2b_domain = await resolve_e2b_domain(sandbox_id)
        base_url = build_mcp_server_url(sandbox_id, e2b_domain)

        health = await get_mcp_health(sandbox_id, e2b_domain)
        if not health:
            raise HTTPException(
                status_code=503,
                detail="MCP server is not responding. The server may not be started yet.",
            )

        result = await mcp_rpc(base_url, "tools/list", {})
        if result is None:
            raise HTTPException(status_code=502, detail="MCP server returned an error or empty result")

        tools = result.get("tools", [])
        return {
            "success": True,
            "tools": tools,
            "sandbox_id": sandbox_id,
            "mcp_server_url": base_url,
        }

    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502,
            detail=f"MCP server returned {e.response.status_code}: {e.response.text[:200]}",
        )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="MCP server request timed out")
    except Exception as e:
        logger.exception(f"MCP tools/list unexpected error for sandbox {sandbox_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


@router.post("/{window_id}/mcp-tool-call")
async def mcp_tool_call(window_id: str, request: McpToolCallRequest, user=Depends(get_current_user)):
    """Proxy a tool call from the frontend to the shared MCP server."""
    window = route_window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    sandbox_id = window.sandbox_id
    if not sandbox_id:
        raise HTTPException(status_code=400, detail="No sandbox for this window")

    e2b_domain = await resolve_e2b_domain(sandbox_id)
    base_url = build_mcp_server_url(sandbox_id, e2b_domain)

    try:
        result = await mcp_rpc(base_url, "tools/call", {
            "name": request.tool_name,
            "arguments": request.arguments or {},
        })

        if result is None:
            raise HTTPException(status_code=502, detail="MCP server returned an error")

        return {"success": True, "result": result}

    except httpx.HTTPStatusError as e:
        logger.error(f"MCP tool call failed: {e}")
        raise HTTPException(status_code=502, detail=f"MCP server error: {e.response.status_code}")
    except Exception as e:
        logger.exception(f"MCP tool call error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── App log endpoint ─────────────────────────────────────────────────

@router.post("/{window_id}/log")
async def route_window_log(window_id: str, request: AppLogRequest, user=Depends(get_current_user)):
    """Receive log messages from MCP apps and write to per-app log files."""
    window = route_window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    sandbox_id = window.sandbox_id
    if not sandbox_id:
        return {"success": True, "persisted": False}

    app_name = window.mcp_tool_name
    if not app_name:
        return {"success": True, "persisted": False}

    try:
        sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)

        log_entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "level": request.level,
            "source": request.logger or app_name,
            "data": request.data,
        }
        log_json = json.dumps(log_entry)

        app_dir = f"{WORKSPACE_DIR}/{app_name}"
        logs_dir = f"{app_dir}/.logs"
        log_file = f"{logs_dir}/runtime.jsonl"

        await sandbox.commands.run(f"mkdir -p {logs_dir}", timeout=5)

        escaped_json = log_json.replace("'", "'\\''")
        await sandbox.commands.run(f"echo '{escaped_json}' >> {log_file}", timeout=5)

        return {"success": True, "persisted": True}

    except Exception as e:
        logger.warning(f"Failed to persist app log: {e}")
        return {"success": True, "persisted": False, "error": str(e)}


# ── Additional prompt / position / size ──────────────────────────────

@router.patch("/{window_id}/additional-prompt")
async def update_route_window_additional_prompt(window_id: str, request: AdditionalPromptRequest, user=Depends(get_current_user)):
    """Update the per-window additional prompt."""
    window = route_window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    route_window_store.update(window_id, additional_prompt=request.additional_prompt)
    return {"success": True}


@router.patch("/{window_id}/position")
async def update_route_window_position(window_id: str, request: PositionRequest, user=Depends(get_current_user)):
    """Update window position (from drag)."""
    window = route_window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    window.position = {"x": request.x, "y": request.y}
    route_window_store.update(window_id, position=window.position)
    return {"success": True}


@router.patch("/{window_id}/size")
async def update_route_window_size(window_id: str, request: SizeRequest, user=Depends(get_current_user)):
    """Update window size (from resize)."""
    window = route_window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    window.size = {"width": request.width, "height": request.height}
    route_window_store.update(window_id, size=window.size)
    return {"success": True}
