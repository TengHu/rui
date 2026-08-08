"""
MCP connection verification service.

Verifies that the MCP server is reachable, the protocol handshake works,
and expected tools are discoverable -- BEFORE launching the agent.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class MCPConnectionState(Enum):
    """States in the MCP connection lifecycle."""
    INIT = "init"
    SERVER_REACHABLE = "server_reachable"
    PROTOCOL_VALIDATED = "protocol_validated"
    TOOLS_DISCOVERED = "tools_discovered"
    READY = "ready"
    DEGRADED = "degraded"
    FAILED = "failed"


@dataclass(frozen=True)
class MCPConnectionResult:
    """Immutable result of MCP connection verification."""
    state: MCPConnectionState
    tools_available: tuple  # Immutable tuple of tool names
    meta_tools_present: bool
    error: Optional[str] = None
    latency_ms: float = 0.0
    server_info: Dict = field(default_factory=dict)

    @property
    def is_ready(self) -> bool:
        return self.state == MCPConnectionState.READY

    @property
    def is_degraded(self) -> bool:
        return self.state == MCPConnectionState.DEGRADED

    @property
    def is_failed(self) -> bool:
        return self.state == MCPConnectionState.FAILED


# Required meta-tools that must be present for the system to function
REQUIRED_META_TOOLS = ("app", "list-apps")


async def verify_mcp_connection(
    mcp_server_url: str,
    health_url: str,
    max_retries: int = 3,
    retry_delay: float = 1.0,
    timeout: float = 10.0,
) -> MCPConnectionResult:
    """
    Verify MCP server connection through a multi-stage handshake.

    Stage 1: HTTP health check (server is running)
    Stage 2: MCP protocol handshake (tools/list request succeeds)
    Stage 3: Tool discovery (tools/list returns valid data)
    Stage 4: Tool validation (required meta-tools are present)

    Args:
        mcp_server_url: Base URL for MCP server (e.g., https://3000-sandbox.e2b.dev/mcp)
        health_url: Health endpoint URL (e.g., https://3000-sandbox.e2b.dev/health)
        max_retries: Maximum number of verification attempts
        retry_delay: Seconds to wait between retry attempts
        timeout: Timeout for each HTTP request

    Returns:
        MCPConnectionResult describing the connection state
    """
    start_time = time.monotonic()

    for attempt in range(max_retries):
        try:
            result = await _verify_single_attempt(
                mcp_server_url, health_url, timeout
            )
            if result.is_ready or result.is_degraded:
                return result
            # If failed, retry after delay
            if attempt < max_retries - 1:
                logger.warning(
                    "MCP verification attempt %d/%d failed: %s. Retrying in %.1fs",
                    attempt + 1, max_retries, result.error, retry_delay,
                )
                await asyncio.sleep(retry_delay)
        except Exception as e:
            if attempt < max_retries - 1:
                logger.warning(
                    "MCP verification attempt %d/%d exception: %s. Retrying in %.1fs",
                    attempt + 1, max_retries, e, retry_delay,
                )
                await asyncio.sleep(retry_delay)
            else:
                latency = (time.monotonic() - start_time) * 1000
                return MCPConnectionResult(
                    state=MCPConnectionState.FAILED,
                    tools_available=(),
                    meta_tools_present=False,
                    error=f"All {max_retries} verification attempts failed: {e}",
                    latency_ms=latency,
                )

    latency = (time.monotonic() - start_time) * 1000
    return MCPConnectionResult(
        state=MCPConnectionState.FAILED,
        tools_available=(),
        meta_tools_present=False,
        error=f"All {max_retries} verification attempts exhausted",
        latency_ms=latency,
    )


async def _verify_single_attempt(
    mcp_server_url: str,
    health_url: str,
    timeout: float,
) -> MCPConnectionResult:
    """Run a single verification attempt through all stages."""
    start_time = time.monotonic()

    async with httpx.AsyncClient(timeout=timeout) as client:
        # Stage 1: Health check
        try:
            health_resp = await client.get(health_url)
            health_resp.raise_for_status()
            server_info = health_resp.json()
        except Exception as e:
            return MCPConnectionResult(
                state=MCPConnectionState.FAILED,
                tools_available=(),
                meta_tools_present=False,
                error=f"Health check failed: {e}",
                latency_ms=_elapsed_ms(start_time),
            )

        # Stage 2: MCP protocol handshake via tools/list on the stateless endpoint
        # Using /mcp-rpc (stateless) avoids session management complexity
        rpc_url = mcp_server_url.replace("/mcp", "/mcp-rpc")
        try:
            rpc_resp = await client.post(
                rpc_url,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/list",
                    "params": {},
                    "id": 1,
                },
            )
            rpc_resp.raise_for_status()
        except Exception as e:
            return MCPConnectionResult(
                state=MCPConnectionState.SERVER_REACHABLE,
                tools_available=(),
                meta_tools_present=False,
                error=f"MCP protocol handshake failed: {e}",
                latency_ms=_elapsed_ms(start_time),
                server_info=server_info,
            )

        # Stage 3: Parse tool list
        try:
            rpc_data = rpc_resp.json()
            if "error" in rpc_data:
                return MCPConnectionResult(
                    state=MCPConnectionState.PROTOCOL_VALIDATED,
                    tools_available=(),
                    meta_tools_present=False,
                    error=f"tools/list returned error: {rpc_data['error']}",
                    latency_ms=_elapsed_ms(start_time),
                    server_info=server_info,
                )

            tools = rpc_data.get("result", {}).get("tools", [])
            tool_names = tuple(t.get("name", "") for t in tools if isinstance(t, dict))
        except Exception as e:
            return MCPConnectionResult(
                state=MCPConnectionState.PROTOCOL_VALIDATED,
                tools_available=(),
                meta_tools_present=False,
                error=f"Failed to parse tools/list response: {e}",
                latency_ms=_elapsed_ms(start_time),
                server_info=server_info,
            )

        # Stage 4: Validate required meta-tools
        meta_tools_present = all(t in tool_names for t in REQUIRED_META_TOOLS)

        if not meta_tools_present:
            missing = [t for t in REQUIRED_META_TOOLS if t not in tool_names]
            return MCPConnectionResult(
                state=MCPConnectionState.DEGRADED,
                tools_available=tool_names,
                meta_tools_present=False,
                error=f"Missing required meta-tools: {missing}",
                latency_ms=_elapsed_ms(start_time),
                server_info=server_info,
            )

        return MCPConnectionResult(
            state=MCPConnectionState.READY,
            tools_available=tool_names,
            meta_tools_present=True,
            latency_ms=_elapsed_ms(start_time),
            server_info=server_info,
        )


def _elapsed_ms(start: float) -> float:
    """Calculate elapsed milliseconds since start time."""
    return (time.monotonic() - start) * 1000
