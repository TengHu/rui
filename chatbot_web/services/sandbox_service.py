"""
Async sandbox lifecycle service for the FastAPI app.

Per-user sandbox isolation: each authenticated user gets their own E2B sandbox,
tracked in the SQLite database. Replaces the previous global shared sandbox.
"""

import os
import asyncio
import logging
from typing import Optional, Dict

from e2b_code_interpreter import AsyncSandbox
from config import WORKSPACE_DIR as DEFAULT_WORKSPACE_DIR

logger = logging.getLogger(__name__)

# Per-user lock dict to prevent concurrent creation for the same user
_user_locks: Dict[int, asyncio.Lock] = {}


def _get_user_lock(user_id: int) -> asyncio.Lock:
    """Get or create a per-user asyncio Lock."""
    if user_id not in _user_locks:
        _user_locks[user_id] = asyncio.Lock()
    return _user_locks[user_id]


def _build_envs() -> dict:
    """Build env vars for sandbox."""
    envs = {
        "WORKDIR": DEFAULT_WORKSPACE_DIR,
        "USER": "sandbox",
        "HOME": DEFAULT_WORKSPACE_DIR,
    }
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        envs["ANTHROPIC_API_KEY"] = anthropic_key
    return envs


async def _ensure_workdir(sandbox: AsyncSandbox, workdir: str) -> None:
    """Create workdir, desktop dir, and common app registry inside the sandbox."""
    desktop_dir = f"{workdir}/desktop"
    registry_dir = f"{workdir}/.common_app_registry"
    code = (
        f"import os; "
        f"os.makedirs({workdir!r}, exist_ok=True); "
        f"os.makedirs({desktop_dir!r}, exist_ok=True); "
        f"os.makedirs({registry_dir!r}, exist_ok=True)"
    )
    await sandbox.commands.run(f"python3 -c {code!r}", timeout=10)


async def _upload_sandbox_claude(sandbox: AsyncSandbox, workdir: str) -> None:
    """Upload sandbox-claude assets to {workdir}/.claude/ in the sandbox."""
    assets_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "sandbox-claude")
    target_base = f"{workdir}/.claude"

    if not os.path.exists(assets_dir):
        logger.warning("sandbox-claude assets not found: %s", assets_dir)
        return

    for root, dirs, files in os.walk(assets_dir):
        rel_root = os.path.relpath(root, assets_dir)
        if rel_root == ".":
            target_dir = target_base
        else:
            target_dir = f"{target_base}/{rel_root}"

        await sandbox.commands.run(f"mkdir -p '{target_dir}'", timeout=10)

        for filename in files:
            local_path = os.path.join(root, filename)
            target_path = f"{target_dir}/{filename}"
            try:
                with open(local_path, "r") as f:
                    content = f.read()
                await sandbox.files.write(target_path, content)
                logger.debug("Uploaded: %s", target_path)
            except Exception as e:
                logger.warning("Failed to upload %s: %s", local_path, e)

    logger.info("Uploaded /.claude/ to sandbox")


async def _upload_prebuilt_apps(sandbox: AsyncSandbox, workdir: str) -> None:
    """Upload pre-built common apps and their registry entries to the sandbox."""
    assets_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")

    app_names = ["atom-editor", "btc-dashboard", "csv-explorer", "draw-app"]
    for app_name in app_names:
        local_app_dir = os.path.join(assets_dir, app_name)
        if not os.path.exists(local_app_dir):
            logger.warning("Pre-built app not found: %s", local_app_dir)
            continue

        target_app_dir = f"{workdir}/{app_name}"
        for root, _dirs, files in os.walk(local_app_dir):
            rel_root = os.path.relpath(root, local_app_dir)
            target_dir = target_app_dir if rel_root == "." else f"{target_app_dir}/{rel_root}"
            await sandbox.commands.run(f"mkdir -p '{target_dir}'", timeout=10)

            for filename in files:
                local_path = os.path.join(root, filename)
                target_path = f"{target_dir}/{filename}"
                try:
                    with open(local_path, "r") as f:
                        content = f.read()
                    await sandbox.files.write(target_path, content)
                    logger.debug("Uploaded app file: %s", target_path)
                except Exception as e:
                    logger.warning("Failed to upload %s: %s", local_path, e)

        logger.info("Uploaded pre-built app: %s", app_name)

    registry_local = os.path.join(assets_dir, ".common_app_registry")
    registry_remote = f"{workdir}/.common_app_registry"
    if os.path.exists(registry_local):
        for filename in os.listdir(registry_local):
            if not filename.endswith(".json"):
                continue
            local_path = os.path.join(registry_local, filename)
            target_path = f"{registry_remote}/{filename}"
            try:
                with open(local_path, "r") as f:
                    content = f.read()
                await sandbox.files.write(target_path, content)
                logger.debug("Uploaded registry: %s", target_path)
            except Exception as e:
                logger.warning("Failed to upload registry %s: %s", filename, e)

        logger.info("Uploaded .common_app_registry to sandbox")


async def _start_mcp_server(sandbox: AsyncSandbox, workdir: str) -> None:
    """Upload and start the shared MCP server on port 3000 inside the sandbox."""
    mcp_server_dir = f"{workdir}/.mcp-server"

    await sandbox.commands.run(f"mkdir -p {mcp_server_dir}", timeout=10)

    assets_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "mcp-server")

    for filename in ("server.ts", "package.json"):
        local_path = os.path.join(assets_dir, filename)
        if os.path.exists(local_path):
            with open(local_path, "r") as f:
                content = f.read()
            await sandbox.files.write(f"{mcp_server_dir}/{filename}", content)
            logger.info("Uploaded %s to %s/%s", filename, mcp_server_dir, filename)
        else:
            logger.warning("MCP server asset not found: %s", local_path)

    result = await sandbox.commands.run(
        f"cd {mcp_server_dir} && npm install",
        timeout=120,
    )
    if result.exit_code != 0:
        logger.error("MCP server npm install failed: %s", result.stderr)
        return

    supervisor_script = (
        f"cd {mcp_server_dir} && DELAY=1 && while true; do "
        f"echo \"[$(date -Iseconds)] MCP server starting (pid $$, delay ${{DELAY}}s)\" >> /tmp/mcp-server-stdout.log; "
        f"START=$(date +%s); "
        f"PORT=3000 npx tsx server.ts >> /tmp/mcp-server-stdout.log 2>&1; "
        f"EXIT=$?; "
        f"ELAPSED=$(( $(date +%s) - START )); "
        f"echo \"[$(date -Iseconds)] MCP server exited with code $EXIT after ${{ELAPSED}}s\" >> /tmp/mcp-server-stdout.log; "
        f"if [ $ELAPSED -gt 60 ]; then DELAY=1; fi; "
        f"sleep $DELAY; "
        f"if [ $DELAY -lt 30 ]; then DELAY=$(( DELAY * 2 )); fi; "
        f"done &"
    )
    await sandbox.commands.run(supervisor_script, timeout=15, background=True)

    for attempt in range(15):
        try:
            health = await sandbox.commands.run(
                "curl -sf http://localhost:3000/health",
                timeout=5,
            )
            if health.exit_code == 0:
                logger.info("Shared MCP server is ready on port 3000")
                return
        except Exception:
            pass
        await asyncio.sleep(1)

    logger.warning("MCP server not confirmed ready after 15 attempts — continuing anyway")


async def _create_and_init_sandbox() -> Optional[str]:
    """Create a new sandbox with full initialization. Returns sandbox_id or None."""
    try:
        template_id = os.environ.get("E2B_TEMPLATE_ID")
        envs = _build_envs()
        timeout_seconds = 3600
        network = {"allow_public_traffic": True}

        if template_id:
            sandbox = await AsyncSandbox.create(
                template=template_id,
                envs=envs,
                allow_internet_access=True,
                timeout=timeout_seconds,
                network=network,
            )
        else:
            sandbox = await AsyncSandbox.create(
                envs=envs,
                allow_internet_access=True,
                timeout=timeout_seconds,
                network=network,
            )

        sandbox_id = sandbox.sandbox_id
        await _ensure_workdir(sandbox, DEFAULT_WORKSPACE_DIR)
        await _upload_prebuilt_apps(sandbox, DEFAULT_WORKSPACE_DIR)
        await _start_mcp_server(sandbox, DEFAULT_WORKSPACE_DIR)
        await _upload_sandbox_claude(sandbox, DEFAULT_WORKSPACE_DIR)

        logger.info("Created sandbox: %s", sandbox_id)
        return sandbox_id

    except Exception as e:
        logger.exception("Failed to create sandbox: %s", e)
        return None


async def _is_sandbox_alive(sandbox_id: str) -> bool:
    """Check if a sandbox is still running."""
    try:
        sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
        await sandbox.commands.run("echo ok", timeout=5)
        return True
    except Exception as e:
        logger.info("Sandbox %s is not alive: %s", sandbox_id, e)
        return False


async def get_or_create_user_sandbox(user_id: int) -> Optional[str]:
    """
    Get or create an isolated sandbox for a specific user.

    1. Check DB for active sandbox -> verify alive -> return if valid
    2. If expired/dead -> deactivate in DB
    3. Create new sandbox
    4. Store sandbox_id in DB -> return
    """
    from services.database import get_active_sandbox, deactivate_sandbox, set_user_sandbox

    lock = _get_user_lock(user_id)
    async with lock:
        # Check for existing active sandbox
        existing_id = await get_active_sandbox(user_id)
        if existing_id:
            if await _is_sandbox_alive(existing_id):
                logger.info("Reusing sandbox %s for user %s", existing_id, user_id)
                return existing_id
            else:
                logger.info("Sandbox %s dead for user %s, deactivating", existing_id, user_id)
                await deactivate_sandbox(user_id, existing_id)

        # Create new sandbox
        sandbox_id = await _create_and_init_sandbox()
        if sandbox_id:
            await set_user_sandbox(user_id, sandbox_id)
            logger.info("Created sandbox %s for user %s", sandbox_id, user_id)

        return sandbox_id


# ── Backward-compat helpers ──────────────────────────────────────────
# These are kept temporarily for code that hasn't been migrated yet.

_shared_sandbox_id: Optional[str] = None
_shared_sandbox_initialized = False
_creation_lock: Optional[object] = None


def _get_creation_lock():
    global _creation_lock
    if _creation_lock is None:
        _creation_lock = asyncio.Lock()
    return _creation_lock


async def get_or_create_shared_sandbox(force_new: bool = False) -> Optional[str]:
    """Legacy: get or create a shared sandbox (non-user-scoped)."""
    global _shared_sandbox_id, _shared_sandbox_initialized

    if not force_new and _shared_sandbox_id:
        return _shared_sandbox_id

    if not force_new and _shared_sandbox_initialized:
        return _shared_sandbox_id

    lock = _get_creation_lock()
    async with lock:
        if not force_new and _shared_sandbox_id:
            return _shared_sandbox_id

        _shared_sandbox_initialized = True
        sandbox_id = await _create_and_init_sandbox()
        if sandbox_id:
            _shared_sandbox_id = sandbox_id
        else:
            _shared_sandbox_initialized = False

        return _shared_sandbox_id


def set_shared_sandbox_id(sandbox_id: Optional[str]) -> None:
    global _shared_sandbox_id, _shared_sandbox_initialized
    _shared_sandbox_id = sandbox_id
    if sandbox_id is None:
        _shared_sandbox_initialized = False


def get_shared_sandbox_id() -> Optional[str]:
    return _shared_sandbox_id
