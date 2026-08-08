from typing import Optional, Dict, Any, List
import httpx
import asyncio
from datetime import datetime


class MCPConnection:
    def __init__(self, server_id: str, url: str):
        self.server_id = server_id
        self.url = url
        self.connected_at = datetime.utcnow()
        self.tools: List[Dict[str, Any]] = []
        self.resources: List[Dict[str, Any]] = []
        self.is_healthy = False

    async def initialize(self):
        """Discover server capabilities via initialize request."""
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json"
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                self.url,
                json={
                    "jsonrpc": "2.0",
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "roots": {"listChanged": True},
                            "sampling": {}
                        },
                        "clientInfo": {
                            "name": "RouteWindow MCP Client",
                            "version": "1.0.0"
                        }
                    },
                    "id": 1
                },
                headers=headers
            )
            result = response.json()

            # Store server capabilities
            capabilities = result.get("result", {}).get("capabilities", {})

            # Discover tools
            if capabilities.get("tools"):
                tools_response = await client.post(
                    self.url,
                    json={
                        "jsonrpc": "2.0",
                        "method": "tools/list",
                        "params": {},
                        "id": 2
                    },
                    headers=headers
                )
                self.tools = tools_response.json().get("result", {}).get("tools", [])

            # Discover resources
            if capabilities.get("resources"):
                resources_response = await client.post(
                    self.url,
                    json={
                        "jsonrpc": "2.0",
                        "method": "resources/list",
                        "params": {},
                        "id": 3
                    },
                    headers=headers
                )
                self.resources = resources_response.json().get("result", {}).get("resources", [])

            self.is_healthy = True

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Call a tool on the connected MCP server."""
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json"
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                self.url,
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": {
                        "name": tool_name,
                        "arguments": arguments
                    },
                    "id": 100
                },
                headers=headers
            )
            return response.json()

    async def read_resource(self, uri: str) -> Dict[str, Any]:
        """Read a resource from the connected MCP server."""
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json"
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                self.url,
                json={
                    "jsonrpc": "2.0",
                    "method": "resources/read",
                    "params": {"uri": uri},
                    "id": 101
                },
                headers=headers
            )
            return response.json()

    async def health_check(self) -> bool:
        """Check if server is still responsive."""
        try:
            headers = {
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json"
            }
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(
                    self.url,
                    json={
                        "jsonrpc": "2.0",
                        "method": "ping",
                        "params": {},
                        "id": 999
                    },
                    headers=headers
                )
                self.is_healthy = response.status_code == 200
                return self.is_healthy
        except Exception:
            self.is_healthy = False
            return False


class MCPConnectionManager:
    def __init__(self):
        self._connections: Dict[str, MCPConnection] = {}  # window_id -> connection
        self._lock = asyncio.Lock()

    async def connect(self, window_id: str, server_id: str, url: str) -> MCPConnection:
        """Connect to an MCP server for a specific window."""
        async with self._lock:
            # Disconnect existing if any
            if window_id in self._connections:
                del self._connections[window_id]

            # Create new connection
            connection = MCPConnection(server_id, url)
            await connection.initialize()

            self._connections[window_id] = connection
            return connection

    def get_connection(self, window_id: str) -> Optional[MCPConnection]:
        """Get the connection for a window."""
        return self._connections.get(window_id)

    async def disconnect(self, window_id: str):
        """Disconnect MCP server for a window."""
        async with self._lock:
            if window_id in self._connections:
                del self._connections[window_id]

    async def call_tool(self, window_id: str, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Call a tool via the window's connection."""
        connection = self.get_connection(window_id)
        if not connection:
            raise ValueError(f"No MCP connection for window {window_id}")

        return await connection.call_tool(tool_name, arguments)


# Global singleton
mcp_connection_manager = MCPConnectionManager()
