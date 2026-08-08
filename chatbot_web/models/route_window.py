"""
RouteWindow data models - mini browser windows that render MCP or common apps.

Each RouteWindow hosts either:
- MCP app: agent creates and registers apps with shared MCP server on port 3000,
  rendered via AppRenderer.
- Common app: agent builds a standard web app on a dedicated port (3001+),
  rendered via a plain iframe.
"""

from pydantic import BaseModel, Field
from typing import Dict, Optional, Any, List
from datetime import datetime
import uuid



class RouteWindowRecord(BaseModel):
    """
    A mini-browser window that renders MCP apps or common web apps from the sandbox.

    MCP windows: agent creates MCP apps, registers them with the shared MCP server
    on port 3000, rendered via AppRenderer.
    Common windows: agent builds standard web apps on a dedicated port (3001+),
    rendered via a plain iframe.
    """

    id: str
    title: str
    window_type: str = "mcp"          # "mcp" or "common"
    port: Optional[int] = None        # Assigned port for common windows (3001+)
    user_id: Optional[int] = None     # Owner user ID for per-user isolation

    # Sandbox connection state
    sandbox_id: Optional[str] = None
    sandbox_url: Optional[str] = None  # e.g., "https://3000-abc123.e2b.app"

    # Agent conversation state
    session_id: Optional[str] = None
    is_loading: bool = False
    last_error: Optional[str] = None

    # Message history for the window's chat
    messages: List[Dict[str, Any]] = Field(default_factory=list)

    # Metadata
    created_at: datetime
    updated_at: datetime

    # MCP App fields
    mcp_tool_name: Optional[str] = None       # Name of this window's MCP tool
    mcp_tools: Optional[list] = None          # List of MCP tools discovered
    mcp_resource_uri: Optional[str] = None    # URI of the UI resource
    mcp_server_url: Optional[str] = None      # URL of the shared MCP server
    mcp_discovery: Optional[Dict[str, Any]] = None  # Full MCP discovery data (tools + resource HTML)

    # Per-window additional instructions for the agent
    additional_prompt: Optional[str] = None

    # Position/size (managed by frontend but stored for persistence)
    position: Optional[Dict[str, int]] = None  # {"x": 100, "y": 100}
    size: Optional[Dict[str, int]] = None  # {"width": 600, "height": 400}

    @classmethod
    def create(
        cls,
        title: str = "New Window",
        additional_prompt: Optional[str] = None,
        window_type: str = "mcp",
        port: Optional[int] = None,
        user_id: Optional[int] = None,
    ) -> "RouteWindowRecord":
        """Factory method to create a new RouteWindowRecord."""
        now = datetime.utcnow()
        window_id = f"rwin_{uuid.uuid4().hex[:8]}"

        if window_type == "common":
            default_prompt = (
                f"You are operating in window '{window_id}'. "
                f"Build a web app that serves on port {port}. "
                "For any application development task, you MUST use the develop-common-app skill."
            )
        else:
            default_prompt = (
                f"You are operating in window '{window_id}'. "
                "For any application development task, you MUST use the create-mcp-app skill."
            )

        return cls(
            id=window_id,
            title=title,
            window_type=window_type,
            port=port,
            user_id=user_id,
            additional_prompt=additional_prompt or default_prompt,
            created_at=now,
            updated_at=now,
        )

    def add_message(self, role: str, content: str) -> "RouteWindowRecord":
        """Add a message to the conversation history."""
        self.messages.append({
            "role": role,
            "content": content,
            "timestamp": datetime.utcnow().isoformat(),
        })
        self.updated_at = datetime.utcnow()
        return self

    def set_sandbox_url(self, sandbox_id: str, domain: str) -> "RouteWindowRecord":
        """Set the sandbox URL for this window."""
        self.sandbox_id = sandbox_id
        url_port = self.port if self.window_type == "common" and self.port else 3000
        self.sandbox_url = f"https://{url_port}-{sandbox_id}.{domain}"
        self.updated_at = datetime.utcnow()
        return self

    def set_loading(self, loading: bool) -> "RouteWindowRecord":
        """Set the loading state."""
        self.is_loading = loading
        self.updated_at = datetime.utcnow()
        return self

    def set_error(self, error: Optional[str]) -> "RouteWindowRecord":
        """Set an error message."""
        self.last_error = error
        self.updated_at = datetime.utcnow()
        return self

    def to_client_dict(self) -> Dict[str, Any]:
        """Convert to dict for sending to frontend."""
        return self.model_dump(mode="json")


class RouteWindowStore:
    """
    In-memory store for RouteWindow records.

    Thread-safe singleton store that broadcasts changes via listeners.
    """

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._windows: Dict[str, RouteWindowRecord] = {}
            cls._instance._listeners: List[callable] = []
        return cls._instance

    def add_listener(self, listener: callable):
        """Add a listener that gets called on window changes."""
        self._listeners.append(listener)

    def remove_listener(self, listener: callable):
        """Remove a listener."""
        if listener in self._listeners:
            self._listeners.remove(listener)

    def _notify(self, event_type: str, window: RouteWindowRecord):
        """Notify all listeners of a change."""
        for listener in self._listeners:
            try:
                listener(event_type, window)
            except Exception:
                pass

    def _next_common_port(self, registry_ports: Optional[set] = None) -> int:
        """Find the next available port for a common window (starting from 3001).

        Checks both active window ports and registry-occupied ports to avoid collisions.
        """
        used_ports = {
            w.port for w in self._windows.values()
            if w.window_type == "common" and w.port is not None
        }
        if registry_ports:
            used_ports |= registry_ports
        port = 3001
        while port in used_ports:
            port += 1
        return port

    def create(
        self,
        title: str = "New Window",
        additional_prompt: Optional[str] = None,
        window_type: str = "mcp",
        port: Optional[int] = None,
        registry_ports: Optional[set] = None,
        user_id: Optional[int] = None,
    ) -> RouteWindowRecord:
        """Create and store a new window."""
        if window_type == "common":
            port = port if port is not None else self._next_common_port(registry_ports)
        else:
            port = None
        window = RouteWindowRecord.create(
            title=title,
            additional_prompt=additional_prompt,
            window_type=window_type,
            port=port,
            user_id=user_id,
        )
        self._windows[window.id] = window
        self._notify("created", window)
        return window

    def get(self, window_id: str) -> Optional[RouteWindowRecord]:
        """Get a window by ID."""
        return self._windows.get(window_id)

    def get_all(self) -> List[RouteWindowRecord]:
        """Get all windows."""
        return list(self._windows.values())

    def get_all_for_user(self, user_id: int) -> List[RouteWindowRecord]:
        """Get all windows belonging to a specific user."""
        return [w for w in self._windows.values() if w.user_id == user_id]

    def update(self, window_id: str, **updates) -> Optional[RouteWindowRecord]:
        """Update a window and notify listeners."""
        window = self._windows.get(window_id)
        if not window:
            return None

        for key, value in updates.items():
            if hasattr(window, key):
                setattr(window, key, value)

        window.updated_at = datetime.utcnow()
        self._notify("updated", window)
        return window

    def delete(self, window_id: str) -> bool:
        """Delete a window."""
        window = self._windows.pop(window_id, None)
        if window:
            self._notify("deleted", window)
            return True
        return False

    def clear(self):
        """Clear all windows."""
        self._windows.clear()


# Global store instance
route_window_store = RouteWindowStore()
