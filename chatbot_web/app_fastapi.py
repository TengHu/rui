#!/usr/bin/env python3
"""
FastAPI web service for chatbot interface that calls sandbox_runner.
"""

import os
import sys
import json
import logging
import shlex
import base64
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any
from dotenv import load_dotenv

# Load .env file before any other imports that read env vars
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Depends
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from pydantic import BaseModel

# Add parent directory to path to import sandbox_runner
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Add current directory to path for local imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sandbox_runner import run_agent, AGENT_SPECS, DEFAULT_AGENT, upload_agent, ensure_agent_dependencies
from e2b_code_interpreter import AsyncSandbox
from e2b.exceptions import NotFoundException

from services.sandbox_service import get_or_create_user_sandbox
from services.error_utils import sanitize_error
from services.event_manager import main_events
from middleware.auth import get_current_user
from config import WORKSPACE_DIR

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# Configuration - these should be set via environment variables
SANDBOX_ID = os.environ.get("SANDBOX_ID")

# Backward-compat shim so terminal_fastapi can still read event_queues
event_queues = main_events._storage


async def _resolve_sandbox(user_id, storage):
    """Determine (or create) the sandbox for a user's request."""
    sandbox_id = SANDBOX_ID

    if not sandbox_id:
        if storage:
            storage["events"].append({
                "type": "status",
                "data": {"message": "Your virtual computer is starting..."},
            })
        sandbox_id = await get_or_create_user_sandbox(user_id)
        if sandbox_id and storage:
            storage["events"].append({
                "type": "status",
                "data": {"message": "Virtual computer is ready!"},
            })

    if not sandbox_id:
        raise HTTPException(status_code=500, detail="No sandbox available")
    return sandbox_id


async def _count_existing_lines(sandbox, events_path: str) -> int:
    """Count existing lines in the events file so the poller can skip them."""
    try:
        content = await sandbox.files.read(events_path)
        return len(content.splitlines()) if content else 0
    except Exception:
        return 0


# Pydantic models for request bodies
class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[str] = None


class SandboxNewRequest(BaseModel):
    pass  # Empty body allowed


# Lifespan context manager for startup/shutdown
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    # Startup
    logger.info("FastAPI app starting up...")

    # Initialize database
    from services.database import init_db, close_db
    await init_db()

    # Import and initialize SocketIO
    from services.event_bus_fastapi import init_socketio, sio
    init_socketio(app)

    yield

    # Shutdown
    logger.info("FastAPI app shutting down...")
    await close_db()


# Create FastAPI app
app = FastAPI(
    title="Chatbot Web Service",
    description="FastAPI web service for chatbot interface with sandbox execution",
    version="2.0.0",
    lifespan=lifespan,
)

# Session middleware required by authlib for OAuth state
session_secret = os.environ.get("SESSION_SECRET_KEY", "change-me-to-a-random-secret")
app.add_middleware(SessionMiddleware, secret_key=session_secret, session_cookie="oauth_session")

# Add CORS middleware
_cors_origins = os.environ.get("CORS_ORIGINS", "http://localhost:5001,http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# SSE Events endpoint
@app.get("/api/events/{conversation_id}")
async def events(conversation_id: str, user=Depends(get_current_user)):
    """Server-Sent Events endpoint for streaming agent events."""
    return StreamingResponse(
        main_events.sse_generator(conversation_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


async def _run_chat_agent(sandbox_id, conversation_id, message, session_id, storage, message_id):
    """Connect to sandbox, run agent, wait for delivery, return response dict."""
    sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)

    try:
        await sandbox.set_timeout(3600)
    except Exception as e:
        logger.warning("Could not refresh sandbox timeout: %s", e)

    events_path = f"{WORKSPACE_DIR}/events.jsonl"
    prior_line_count = await _count_existing_lines(sandbox, events_path)

    spec = AGENT_SPECS[DEFAULT_AGENT]
    await upload_agent(sandbox=sandbox, cwd=WORKSPACE_DIR, spec=spec)

    poller = None
    if conversation_id:
        poller = await main_events.start_poller(
            conversation_id, sandbox, events_path, skip_lines=prior_line_count,
        )

    result = await run_agent(
        sandbox=sandbox, query=message, cwd=WORKSPACE_DIR,
        spec=spec, session_id=session_id,
    )

    if poller and conversation_id:
        await main_events.wait_for_delivery(conversation_id, poller)

    if result.success:
        return {
            "response": result.output,
            "success": True,
            "conversation_id": conversation_id,
            "message_id": message_id,
        }
    raise HTTPException(status_code=500, detail=sanitize_error(result.error))


@app.post("/api/chat")
async def chat(request: ChatRequest, user=Depends(get_current_user)):
    """Handle chat messages and run them through the sandbox agent."""
    conversation_id = request.conversation_id
    message = request.message.strip()
    user_id = user["user_id"]

    logger.info(f"Conversation ID: {conversation_id}, User: {user_id}")

    if not message:
        raise HTTPException(status_code=400, detail="Message is required")
    if not os.environ.get("E2B_API_KEY"):
        raise HTTPException(status_code=500, detail="E2B_API_KEY environment variable not set")

    logger.info(f"Processing message: {message[:50]}...")

    session_id = main_events.get_session_id(conversation_id) if conversation_id else None
    storage, message_id = (
        main_events.init_channel(conversation_id) if conversation_id else (None, None)
    )
    sandbox_id = await _resolve_sandbox(user_id, storage)

    try:
        return await _run_chat_agent(sandbox_id, conversation_id, message, session_id, storage, message_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error processing chat message")
        raise HTTPException(status_code=500, detail=sanitize_error(str(e)))


@app.post("/api/sandbox/new")
async def new_sandbox(user=Depends(get_current_user)):
    """Create (or reuse) a per-user sandbox. Uses async-only sandbox service."""
    try:
        if not os.environ.get("E2B_API_KEY"):
            raise HTTPException(status_code=500, detail="E2B_API_KEY environment variable not set")

        user_id = user["user_id"]
        sandbox_id = await get_or_create_user_sandbox(user_id)
        if not sandbox_id:
            raise HTTPException(status_code=500, detail="Failed to create sandbox")

        # Warm up the sandbox before replying "ready"
        sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
        await ensure_agent_dependencies(sandbox)
        spec = AGENT_SPECS[DEFAULT_AGENT]
        await upload_agent(sandbox=sandbox, cwd=WORKSPACE_DIR, spec=spec)

        logger.info(f"Sandbox ready: {sandbox_id} for user {user_id}")

        return {"success": True, "sandbox_id": sandbox_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error creating sandbox")
        raise HTTPException(status_code=500, detail=sanitize_error(str(e)))


@app.get("/api/sandbox/info")
async def sandbox_info(
    sandbox_id: str = Query(..., description="Sandbox ID to get info for"),
    user=Depends(get_current_user),
):
    """Get sandbox metadata including timing information."""
    try:
        info = await AsyncSandbox.get_info(sandbox_id=sandbox_id)
        return {
            "success": True,
            "sandbox_id": info.sandbox_id,
            "started_at": info.started_at.isoformat() if info.started_at else None,
            "end_at": info.end_at.isoformat() if info.end_at else None,
        }
    except Exception as e:
        logger.exception("Error getting sandbox info")
        raise HTTPException(status_code=500, detail=sanitize_error(str(e)))


async def _connect_sandbox_or_404(sandbox_id: str):
    """Connect to a sandbox, returning JSONResponse(404) if not found."""
    try:
        return await AsyncSandbox.connect(sandbox_id=sandbox_id)
    except NotFoundException:
        logger.error(f"Sandbox not found: {sandbox_id}")
        return JSONResponse(
            status_code=404,
            content={
                "error": f"Sandbox '{sandbox_id}' not found. It may have expired or been deleted.",
                "success": False,
                "sandbox_not_found": True,
            },
        )


@app.get("/api/sandbox/file")
async def read_sandbox_file(
    path: str = Query(..., description="File path in sandbox"),
    sandbox_id: str = Query(..., description="Sandbox ID to connect to"),
    binary: str = Query("false", description="If 'true', read as binary and return base64-encoded"),
    user=Depends(get_current_user),
):
    """Read a file from the sandbox."""
    try:
        is_binary = binary.lower() == "true"
        result = await _connect_sandbox_or_404(sandbox_id)
        if isinstance(result, JSONResponse):
            return result
        sandbox = result

        if not await sandbox.files.exists(path):
            raise HTTPException(status_code=404, detail="File not found")

        try:
            await sandbox.files.list(path)
            raise HTTPException(status_code=400, detail="Path is a directory, not a file")
        except HTTPException:
            raise
        except Exception:
            pass

        if is_binary:
            content_bytes = await sandbox.files.read_bytes(path)
            content = base64.b64encode(content_bytes).decode('utf-8')
        else:
            content = await sandbox.files.read(path)

        return {"success": True, "path": path, "content": content, "is_binary": is_binary, "exists": True}

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error reading sandbox file: {path}")
        raise HTTPException(status_code=500, detail=sanitize_error(str(e)))


async def _write_file_to_sandbox(sandbox, sandbox_id, target_path, filename, file_content):
    """Write file content to sandbox. Accepts any file type and size."""
    await sandbox.files.write(target_path, file_content)
    logger.info(f"Uploaded file {filename} ({len(file_content)} bytes) to {target_path} in sandbox {sandbox_id}")


@app.post("/api/sandbox/upload")
async def upload_sandbox_file(
    file: UploadFile = File(...),
    sandbox_id: str = Form(...),
    target_path: Optional[str] = Form(None),
    user=Depends(get_current_user),
):
    """Upload a file to the sandbox."""
    try:
        if not file.filename:
            raise HTTPException(status_code=400, detail="No file selected")

        result = await _connect_sandbox_or_404(sandbox_id)
        if isinstance(result, JSONResponse):
            return result
        sandbox = result

        try:
            if not target_path:
                desktop_dir = f"{WORKSPACE_DIR}/desktop"
                try:
                    await sandbox.commands.run(f"mkdir -p {shlex.quote(desktop_dir)}", timeout=10)
                except Exception as e:
                    logger.warning(f"Could not create desktop folder: {e}")
                target_path = f"{desktop_dir}/{file.filename}"

            file_content = await file.read()
            await _write_file_to_sandbox(sandbox, sandbox_id, target_path, file.filename, file_content)

            return {"success": True, "path": target_path, "filename": file.filename, "size": len(file_content)}
        finally:
            try:
                await sandbox.close()
            except Exception as e:
                logger.warning(f"Error closing sandbox connection: {e}")

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error uploading file to sandbox")
        raise HTTPException(status_code=500, detail=sanitize_error(str(e)))


@app.get("/api/common-app-registry")
async def get_common_app_registry(
    sandbox_id: Optional[str] = Query(None, description="Sandbox ID (uses shared sandbox if omitted)"),
    user=Depends(get_current_user),
):
    """Read all registered common apps from .common_app_registry/ in the sandbox."""
    user_id = user["user_id"]
    resolved_id = sandbox_id
    if not resolved_id:
        resolved_id = await get_or_create_user_sandbox(user_id)
    if not resolved_id:
        return {"success": True, "apps": []}

    try:
        sandbox = await AsyncSandbox.connect(sandbox_id=resolved_id)
        registry_dir = f"{WORKSPACE_DIR}/.common_app_registry"

        try:
            files = await sandbox.files.list(registry_dir)
        except Exception:
            return {"success": True, "apps": []}

        apps = []
        for f in files:
            if not f.name.endswith(".json"):
                continue
            try:
                content = await sandbox.files.read(f"{registry_dir}/{f.name}")
                app_data = json.loads(content)
                apps.append(app_data)
            except Exception as e:
                logger.warning("Failed to read registry file %s: %s", f.name, e)

        return {"success": True, "apps": apps}

    except Exception as e:
        logger.warning("Failed to read common app registry: %s", e)
        return {"success": True, "apps": []}


@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "sandbox_id": SANDBOX_ID,
        "sandbox_configured": bool(SANDBOX_ID or os.environ.get("E2B_API_KEY")),
    }


# ── Sandbox proxy for PostHog iframe recording ──────────────────────

POSTHOG_KEY = os.environ.get("VITE_POSTHOG_KEY", "")
POSTHOG_HOST = os.environ.get("VITE_POSTHOG_HOST", "https://us.i.posthog.com")

POSTHOG_SNIPPET = """
<script>
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init('__PH_KEY__', {
    api_host: '__PH_HOST__',
    session_recording: { recordCrossOriginIframes: true }
  });
</script>
"""


def _extract_sandbox_id_from_url(url: str) -> Optional[str]:
    """Extract the sandbox_id from an E2B sandbox URL.

    E2B URL format: https://{port}-{sandbox_id}.{e2b_domain}/...
    e.g. https://3000-abc123def456.e2b.app/
    Returns None if the URL does not match the expected pattern.
    """
    try:
        from urllib.parse import urlparse
        hostname = urlparse(url).hostname or ""
        # Grab the subdomain prefix: "3000-abc123def456"
        prefix = hostname.split(".")[0]
        port_str, _, sandbox_id = prefix.partition("-")
        if port_str.isdigit() and sandbox_id:
            return sandbox_id
    except Exception:
        pass
    return None


@app.get("/api/sandbox-proxy")
async def sandbox_proxy(
    url: str = Query(..., description="Sandbox URL to proxy"),
    user=Depends(get_current_user),
):
    """Proxy sandbox HTML with PostHog snippet injected for session recording."""
    if not url.startswith("https://"):
        raise HTTPException(status_code=400, detail="Only HTTPS URLs allowed")

    # Verify the sandbox in the URL belongs to the requesting user.
    url_sandbox_id = _extract_sandbox_id_from_url(url)
    if url_sandbox_id:
        from services.database import get_active_sandbox
        user_sandbox = await get_active_sandbox(user["user_id"])
        if user_sandbox != url_sandbox_id:
            raise HTTPException(status_code=403, detail="Forbidden")

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
            resp = await client.get(url)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch sandbox: {e}")

    content_type = resp.headers.get("content-type", "")
    if "text/html" not in content_type:
        return HTMLResponse(content=resp.text, status_code=resp.status_code)

    html = resp.text

    # Inject <base> so relative asset URLs resolve against the sandbox origin
    base_tag = f'<base href="{url}">'
    ph = POSTHOG_SNIPPET.replace("__PH_KEY__", POSTHOG_KEY).replace("__PH_HOST__", POSTHOG_HOST)

    if "<head>" in html:
        html = html.replace("<head>", f"<head>{base_tag}{ph}", 1)
    elif "<HEAD>" in html:
        html = html.replace("<HEAD>", f"<HEAD>{base_tag}{ph}", 1)
    elif "<html>" in html or "<HTML>" in html:
        html = html.replace("<html>", f"<html><head>{base_tag}{ph}</head>", 1)
        html = html.replace("<HTML>", f"<HTML><head>{base_tag}{ph}</head>", 1)
    else:
        html = f"<head>{base_tag}{ph}</head>{html}"

    return HTMLResponse(content=html)


# Import and include routers
from routes.auth_fastapi import router as auth_router
from routes.windows_fastapi import router as windows_router
from routes.route_windows_fastapi import router as route_windows_router
from routes.filesystem_fastapi import router as filesystem_router
from routes.terminal_fastapi import router as terminal_router
from routes.mcp_fastapi import router as mcp_router

app.include_router(auth_router)
app.include_router(windows_router)
app.include_router(route_windows_router)
app.include_router(filesystem_router)
app.include_router(terminal_router)
app.include_router(mcp_router)

# Mount static files (must be last to not override API routes)
# Serve the React app from frontend/dist
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "dist")
if os.path.exists(static_dir):
    app.mount("/assets", StaticFiles(directory=os.path.join(static_dir, "assets")), name="assets")

    @app.get("/")
    async def index():
        """Serve the React app."""
        return FileResponse(os.path.join(static_dir, "index.html"))

    # Catch-all for client-side routing
    @app.get("/{full_path:path}")
    async def catch_all(full_path: str):
        """Serve index.html for client-side routing."""
        # Don't catch API routes
        if full_path.startswith("api/") or full_path.startswith("socket.io/"):
            raise HTTPException(status_code=404, detail="Not found")

        file_path = os.path.join(static_dir, full_path)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(static_dir, "index.html"))


if __name__ == "__main__":
    import uvicorn

    if not SANDBOX_ID:
        logger.warning("SANDBOX_ID not set. Set it via environment variable.")
        logger.warning("Example: export SANDBOX_ID=your-sandbox-id")

    port = int(os.environ.get("PORT", 5001))
    logger.info(f"Starting FastAPI chatbot web service on port {port}")
    logger.info(f"Sandbox ID: {SANDBOX_ID or 'NOT SET'}")

    uvicorn.run(
        "app_fastapi:app",
        host="0.0.0.0",
        port=port,
        reload=True,
        log_level="info",
    )
