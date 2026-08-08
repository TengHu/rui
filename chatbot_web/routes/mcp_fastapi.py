from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from middleware.auth import get_current_user
from typing import List, Dict, Any, Optional
from services.mcp_registry import mcp_registry
from services.mcp_connection_service import mcp_connection_manager

router = APIRouter(
    prefix="/api/mcp",
    tags=["mcp"],
    dependencies=[Depends(get_current_user)],
)


class ConnectRequest(BaseModel):
    server_id: str
    custom_url: Optional[str] = None  # Override default URL if needed


class ToolCallRequest(BaseModel):
    tool_name: str
    arguments: Dict[str, Any]


@router.get("/registry")
async def get_mcp_registry():
    """Get list of available MCP servers from registry."""
    servers = mcp_registry.get_all()
    return {
        "servers": [
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "default_url": s.default_url,
                "tools": s.tools,
                "has_ui": s.has_ui,
                "documentation": s.documentation
            }
            for s in servers
        ]
    }


@router.get("/registry/{server_id}")
async def get_mcp_server_info(server_id: str):
    """Get detailed info about a specific MCP server."""
    server = mcp_registry.get_by_id(server_id)
    if not server:
        raise HTTPException(status_code=404, detail=f"Server {server_id} not found")

    return {
        "id": server.id,
        "name": server.name,
        "description": server.description,
        "default_url": server.default_url,
        "tools": server.tools,
        "has_ui": server.has_ui,
        "documentation": server.documentation
    }


@router.post("/windows/{window_id}/connect")
async def connect_mcp_server(window_id: str, request: ConnectRequest):
    """Connect a window to an MCP server."""
    server_info = mcp_registry.get_by_id(request.server_id)
    if not server_info:
        raise HTTPException(status_code=404, detail=f"Server {request.server_id} not found")

    url = request.custom_url or server_info.default_url

    try:
        connection = await mcp_connection_manager.connect(window_id, request.server_id, url)

        return {
            "success": True,
            "server_id": request.server_id,
            "url": url,
            "tools": connection.tools,
            "resources": connection.resources,
            "connected_at": connection.connected_at.isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to connect: {str(e)}")


@router.delete("/windows/{window_id}/disconnect")
async def disconnect_mcp_server(window_id: str):
    """Disconnect window from MCP server."""
    await mcp_connection_manager.disconnect(window_id)
    return {"success": True}


@router.get("/windows/{window_id}/connection")
async def get_connection_status(window_id: str):
    """Get connection status for a window."""
    connection = mcp_connection_manager.get_connection(window_id)

    if not connection:
        return {"connected": False}

    # Health check
    is_healthy = await connection.health_check()

    return {
        "connected": True,
        "server_id": connection.server_id,
        "url": connection.url,
        "is_healthy": is_healthy,
        "connected_at": connection.connected_at.isoformat(),
        "tools": connection.tools,
        "resources": connection.resources
    }


@router.post("/windows/{window_id}/call-tool")
async def call_mcp_tool(window_id: str, request: ToolCallRequest):
    """Call a tool on the window's connected MCP server."""
    try:
        result = await mcp_connection_manager.call_tool(
            window_id,
            request.tool_name,
            request.arguments
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Tool call failed: {str(e)}")
