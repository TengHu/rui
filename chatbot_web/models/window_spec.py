"""
WindowSpec data models for the Spatial Desktop Composable Windows system.

These Pydantic models define the core data structures:
- WindowSpec: Declarative UI definition (JSON-serializable)
- WindowState: Runtime data and user state
- WindowRecord: Full window instance with spec + state
"""

from pydantic import BaseModel, Field
from typing import List, Dict, Optional, Any, Literal
from datetime import datetime
import uuid
import hashlib
import json


# UI Element Types - the building blocks of WindowSpec
UIElementType = Literal[
    "text",
    "input",
    "button",
    "list",
    "table",
    "panel",
    "stack",
    "chart",
]


class UIElement(BaseModel):
    """A single UI element in the WindowSpec tree."""

    type: UIElementType
    id: str
    props: Dict[str, Any] = Field(default_factory=dict)
    children: Optional[List["UIElement"]] = None
    actionId: Optional[str] = None  # Reference to action in spec.actions

    class Config:
        # Allow forward references for recursive type
        arbitrary_types_allowed = True


# Rebuild model to resolve forward reference
UIElement.model_rebuild()


# Action types that can be triggered by UI events
ActionType = Literal[
    "add_item",
    "remove_item",
    "update_field",
    "clear_list",
    "spawn_window",
    "open_details",
    "custom",
]


class ActionDef(BaseModel):
    """Definition of an action that can be triggered by UI events."""

    id: str
    type: ActionType
    config: Dict[str, Any] = Field(default_factory=dict)
    # config examples:
    # - add_item: {"key": "items", "fromInput": "currentInput"}
    # - spawn_window: {"prompt": "Show details for {{selected}}"}
    # - update_field: {"key": "count", "increment": 1}


class WindowSpec(BaseModel):
    """
    Declarative window specification.

    This is the JSON-serializable recipe for rendering a window.
    It defines UI structure and available actions, but NOT runtime state.
    """

    title: str
    ui: List[UIElement]
    actions: Dict[str, ActionDef] = Field(default_factory=dict)

    def compute_hash(self) -> str:
        """Compute a hash of the spec for versioning."""
        spec_json = self.model_dump_json(exclude_none=True)
        return hashlib.sha256(spec_json.encode()).hexdigest()[:12]


class WindowState(BaseModel):
    """
    Runtime state for a window.

    Contains user data, selections, filters, and derived results.
    This is mutable and changes as users interact with the window.
    """

    data: Dict[str, Any] = Field(default_factory=dict)
    # data examples:
    # - {"items": ["feedback 1", "feedback 2"], "currentInput": ""}
    # - {"count": 42}
    # - {"rows": [...], "selectedRowId": "row_123"}

    selection: Optional[str] = None
    filters: Dict[str, Any] = Field(default_factory=dict)

    # Computed/derived data from bindings
    derived: Dict[str, Any] = Field(default_factory=dict)


class WindowBinding(BaseModel):
    """
    Binding to a source window for derived windows.

    Allows a window to reference data from another window
    without copying it.
    """

    sourceWindowId: str
    inputKey: str = "items"  # Key in source window's state.data
    transform: Optional[str] = None  # e.g., "countDuplicates", "filterNotEmpty"
    transformConfig: Dict[str, Any] = Field(default_factory=dict)


class WindowRecord(BaseModel):
    """
    Complete window instance at runtime.

    Combines the immutable spec with mutable state and metadata.
    """

    id: str
    title: str
    spec: WindowSpec
    specVersion: str = "1.0.0"
    state: WindowState = Field(default_factory=WindowState)
    bindings: Optional[WindowBinding] = None
    user_id: Optional[int] = None

    # Metadata
    createdAt: datetime
    updatedAt: datetime

    # Position/size (managed by frontend but stored for persistence)
    position: Optional[Dict[str, int]] = None  # {"x": 100, "y": 100}
    size: Optional[Dict[str, int]] = None  # {"width": 400, "height": 300}

    @classmethod
    def create(cls, spec: WindowSpec, initial_state: Optional[Dict[str, Any]] = None) -> "WindowRecord":
        """Factory method to create a new WindowRecord from a spec."""
        now = datetime.utcnow()
        window_id = f"win_{uuid.uuid4().hex[:8]}"

        state = WindowState()
        if initial_state:
            state.data = initial_state

        return cls(
            id=window_id,
            title=spec.title,
            spec=spec,
            specVersion=spec.compute_hash(),
            state=state,
            createdAt=now,
            updatedAt=now,
        )

    def update_state(self, **updates) -> "WindowRecord":
        """Update state fields and bump updatedAt."""
        for key, value in updates.items():
            if hasattr(self.state, key):
                setattr(self.state, key, value)
            else:
                self.state.data[key] = value
        self.updatedAt = datetime.utcnow()
        return self

    def to_client_dict(self) -> Dict[str, Any]:
        """Convert to dict for sending to frontend."""
        return self.model_dump(mode="json")
