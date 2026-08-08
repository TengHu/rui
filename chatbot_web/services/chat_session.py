"""
Shared chat session utilities: sandbox line counting and chat response building.
"""

import logging
from typing import Optional

from config import WORKSPACE_DIR, MCP_SERVER_PORT
from services.error_utils import sanitize_error
from services.mcp_client import (
    find_mcp_tool_call_in_events,
    get_mcp_health,
    discover_mcp_tools,
)

logger = logging.getLogger(__name__)


async def count_existing_lines(sandbox, events_path: str) -> int:
    """Count existing lines in the events file so the poller can skip them."""
    try:
        content = await sandbox.files.read(events_path)
        return len(content.splitlines()) if content else 0
    except Exception:
        return 0


async def finalize_mcp(sandbox, sandbox_id, e2b_domain, events_path, mcp_server_url, window):
    """Post-agent MCP discovery: find tool calls, resolve resource URIs, discover tools."""
    mcp_tool_name = None
    mcp_resource_uri = None

    logger.info("MCP discovery: looking for MCP tool calls in events...")
    called_tool = await find_mcp_tool_call_in_events(sandbox, events_path)

    if called_tool:
        logger.info(f"MCP discovery: agent called MCP tool '{called_tool}'")
        mcp_tool_name = called_tool
        mcp_resource_uri = await _lookup_resource_uri(sandbox_id, e2b_domain, called_tool)

    if not mcp_tool_name and window.mcp_tool_name:
        mcp_tool_name = window.mcp_tool_name
        mcp_resource_uri = window.mcp_resource_uri
        logger.info(f"MCP discovery: preserving existing tool={mcp_tool_name}, uri={mcp_resource_uri}")

    if not mcp_tool_name:
        logger.warning("MCP discovery: no MCP tool call found and no existing tool data")

    mcp_tools = await discover_mcp_tools(mcp_server_url)
    if mcp_tools:
        logger.info(f"Discovered {len(mcp_tools)} MCP tools for frontend preloading")

    return mcp_tool_name, mcp_resource_uri, mcp_tools


async def _lookup_resource_uri(sandbox_id, e2b_domain, tool_name) -> Optional[str]:
    """Look up the resource URI for a tool from MCP health endpoint."""
    try:
        health = await get_mcp_health(sandbox_id, e2b_domain)
        if health:
            for app_name, app_info in health.get("apps", {}).items():
                if tool_name in app_info.get("tools", []):
                    uri = app_info.get("resourceUri")
                    logger.info(f"MCP discovery: found app '{app_name}' for tool '{tool_name}', uri={uri}")
                    return uri
    except Exception as e:
        logger.warning(f"MCP discovery: failed to look up resource URI: {e}")
    return None


def build_chat_response(
    agent_result, window, window_id, sandbox_id, e2b_domain,
    mcp_server_base, is_common, message_id, new_session_id,
    sandbox_url, mcp_tool_name=None, mcp_resource_uri=None, mcp_tools=None,
):
    """Build the response dict after agent completes."""
    from models.route_window import route_window_store

    update_kwargs = dict(
        sandbox_id=sandbox_id, sandbox_url=sandbox_url,
        session_id=new_session_id, is_loading=False,
    )
    if not is_common:
        update_kwargs.update(
            mcp_server_url=mcp_server_base,
            mcp_tool_name=mcp_tool_name,
            mcp_resource_uri=mcp_resource_uri,
        )

    window.set_sandbox_url(sandbox_id, e2b_domain)
    route_window_store.update(window_id, **update_kwargs)

    response_data = {
        "success": agent_result.success,
        "response": agent_result.output,
        "message_id": message_id,
        "window_id": window_id,
        "sandbox_url": sandbox_url,
        "sandbox_id": sandbox_id,
        "session_id": new_session_id,
        "mcp_server_url": mcp_server_base,
        "mcp_tool_name": mcp_tool_name,
        "mcp_resource_uri": mcp_resource_uri,
        "mcp_tools": mcp_tools,
    }

    if not agent_result.success:
        response_data["error"] = sanitize_error(agent_result.error or "Unknown error")

    logger.info(f"Route window {window_id} response: type={window.window_type}, mcp_tool={mcp_tool_name}")
    return response_data
