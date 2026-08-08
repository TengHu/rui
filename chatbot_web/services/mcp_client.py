"""
MCP JSON-RPC client utilities: domain resolution, health checks, RPC calls, and tool discovery.
"""

import json
import logging
from typing import Dict, Optional

import httpx

from config import MCP_SERVER_PORT, E2B_DOMAINS

logger = logging.getLogger(__name__)

# Cache: sandbox_id -> resolved e2b domain
_sandbox_domains: Dict[str, str] = {}


def build_mcp_server_url(sandbox_id: str, domain: str) -> str:
    """Return the public MCP JSON-RPC endpoint URL for a sandbox (stateless /mcp-rpc)."""
    return f"https://{MCP_SERVER_PORT}-{sandbox_id}.{domain}/mcp-rpc"


async def resolve_e2b_domain(sandbox_id: str) -> str:
    """Resolve which E2B domain is reachable for this sandbox."""
    cached = _sandbox_domains.get(sandbox_id)
    if cached:
        return cached

    async with httpx.AsyncClient(timeout=3.0) as client:
        for domain in E2B_DOMAINS:
            try:
                resp = await client.get(f"https://{MCP_SERVER_PORT}-{sandbox_id}.{domain}/health")
                if resp.status_code < 500:
                    _sandbox_domains[sandbox_id] = domain
                    return domain
            except Exception:
                continue

    fallback = E2B_DOMAINS[0]
    _sandbox_domains[sandbox_id] = fallback
    return fallback


async def get_mcp_health(sandbox_id: str, e2b_domain: str) -> Optional[dict]:
    """Query the MCP server's /health endpoint to get registered apps."""
    url = f"https://{MCP_SERVER_PORT}-{sandbox_id}.{e2b_domain}/health"
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.warning(f"MCP health check failed: {e}")
            return None


async def find_mcp_tool_call_in_events(
    sandbox: "AsyncSandbox", events_path: str
) -> Optional[str]:
    """
    Read the events file and find the last MCP tool call.

    MCP tools are namespaced as: mcp__app-server__<tool-name>
    Returns the tool name (without prefix) if found, None otherwise.
    """
    MCP_TOOL_PREFIX = "mcp__app-server__"

    try:
        events_content = await sandbox.files.read(events_path)
        if not events_content:
            return None

        mcp_tool_name = None
        for line in events_content.strip().split("\n"):
            if not line:
                continue
            try:
                event = json.loads(line)
                if event.get("type") == "tool_start":
                    tool = event.get("data", {}).get("tool", "")
                    if tool.startswith(MCP_TOOL_PREFIX):
                        mcp_tool_name = tool[len(MCP_TOOL_PREFIX):]
            except json.JSONDecodeError:
                continue

        return mcp_tool_name
    except Exception as e:
        logger.warning(f"Failed to read events file for MCP tool detection: {e}")
        return None


async def mcp_rpc(
    base_url: str, method: str, params: Optional[dict] = None
) -> Optional[dict]:
    """Send a JSON-RPC 2.0 request to the MCP server and return the result.

    Handles both JSON and SSE response formats (the MCP server uses SSE
    when enableJsonResponse is false for session-based transport).
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            base_url,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            json={
                "jsonrpc": "2.0",
                "method": method,
                "params": params or {},
                "id": 1,
            },
        )
        response.raise_for_status()

        content_type = response.headers.get("content-type", "")

        if "text/event-stream" in content_type:
            for line in response.text.splitlines():
                if line.startswith("data: "):
                    try:
                        data = json.loads(line[6:])
                        if "result" in data:
                            return data["result"]
                        if "error" in data:
                            logger.warning("MCP RPC error for %s: %s", method, data["error"])
                            return None
                    except json.JSONDecodeError:
                        continue
            return None

        data = response.json()
        if "error" in data:
            logger.warning("MCP RPC error for %s: %s", method, data["error"])
            return None
        return data.get("result")


async def discover_mcp_tools(mcp_server_url: str) -> Optional[dict]:
    """
    Call tools/list to get tool definitions with UI metadata.

    Returns:
        dict mapping tool_name -> { resourceUri, inputSchema }
        or None if discovery fails
    """
    try:
        result = await mcp_rpc(mcp_server_url, "tools/list", {})
        if not result:
            return None

        tools = result.get("tools")
        if not isinstance(tools, list):
            logger.warning("MCP tools/list returned invalid format (tools is not a list)")
            return None

        tool_metadata = {}
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            tool_name = tool.get("name")
            if not isinstance(tool_name, str):
                continue
            ui_meta = tool.get("_meta", {}).get("ui", {})
            resource_uri = ui_meta.get("resourceUri")
            if tool_name and resource_uri:
                tool_metadata[tool_name] = {
                    "resourceUri": resource_uri,
                    "inputSchema": tool.get("inputSchema"),
                }

        return tool_metadata
    except Exception as e:
        logger.warning(f"Failed to discover MCP tools: {e}")
        return None
