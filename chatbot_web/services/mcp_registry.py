from typing import List, Optional, Dict
import json
from pathlib import Path


class MCPServerInfo:
    def __init__(self, id: str, name: str, description: str,
                 default_url: str, tools: List[str],
                 documentation: str, has_ui: bool):
        self.id = id
        self.name = name
        self.description = description
        self.default_url = default_url
        self.tools = tools
        self.documentation = documentation
        self.has_ui = has_ui


class MCPRegistry:
    def __init__(self, registry_path: Optional[str] = None):
        if registry_path is None:
            # Use path relative to this module file
            self.registry_path = Path(__file__).parent.parent / "config" / "mcp_registry.json"
        else:
            self.registry_path = Path(registry_path)
        self._servers: Dict[str, MCPServerInfo] = {}
        self._load_registry()

    def _load_registry(self):
        with open(self.registry_path) as f:
            data = json.load(f)
            for server_data in data["servers"]:
                server = MCPServerInfo(**server_data)
                self._servers[server.id] = server

    def get_all(self) -> List[MCPServerInfo]:
        return list(self._servers.values())

    def get_by_id(self, server_id: str) -> Optional[MCPServerInfo]:
        return self._servers.get(server_id)

    def search(self, query: str) -> List[MCPServerInfo]:
        results = []
        query_lower = query.lower()
        for server in self._servers.values():
            if (query_lower in server.name.lower() or
                query_lower in server.description.lower() or
                any(query_lower in tool for tool in server.tools)):
                results.append(server)
        return results


# Global singleton
mcp_registry = MCPRegistry()
