"""
Action registry for handling window actions.

Actions are triggered by UI events (button clicks, form submits, etc.)
and modify window state. This registry provides stable action handlers
that specs reference by ID.
"""

from typing import Dict, Callable, Any, Optional
from models.window_spec import WindowRecord, WindowState


# Type for action handlers
# Takes: window record, action config, payload from UI
# Returns: updated state data dict
ActionHandler = Callable[[WindowRecord, Dict[str, Any], Dict[str, Any]], Dict[str, Any]]


class ActionRegistry:
    """Registry of action handlers."""

    def __init__(self):
        self._handlers: Dict[str, ActionHandler] = {}
        self._register_defaults()

    def _register_defaults(self):
        """Register built-in action handlers."""
        self.register("add_item", self._add_item)
        self.register("remove_item", self._remove_item)
        self.register("update_field", self._update_field)
        self.register("clear_list", self._clear_list)
        self.register("toggle_item", self._toggle_item)
        self.register("set_selection", self._set_selection)

    def register(self, action_type: str, handler: ActionHandler):
        """Register a new action handler."""
        self._handlers[action_type] = handler

    def execute(
        self,
        action_type: str,
        window: WindowRecord,
        config: Dict[str, Any],
        payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Execute an action and return the updated state data.

        Args:
            action_type: The type of action (e.g., "add_item")
            window: The window record
            config: Action configuration from the spec
            payload: Payload from the UI event

        Returns:
            Updated state.data dict
        """
        handler = self._handlers.get(action_type)
        if not handler:
            raise ValueError(f"Unknown action type: {action_type}")

        return handler(window, config, payload)

    def has_handler(self, action_type: str) -> bool:
        """Check if a handler exists for an action type."""
        return action_type in self._handlers

    # ==================
    # Default Handlers
    # ==================

    def _add_item(
        self,
        window: WindowRecord,
        config: Dict[str, Any],
        payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Add an item to a list in state.

        Config:
            - key: The state key for the list (default: "items")
            - fromInput: Optional state key to get value from

        Payload:
            - value: The value to add (if not using fromInput)
        """
        key = config.get("key", "items")
        from_input = config.get("fromInput")

        # Get value from payload first, then try fromInput state key
        value = payload.get("value")
        if not value and from_input:
            value = window.state.data.get(from_input, "")
            # Clear the input after adding
            window.state.data[from_input] = ""

        if not value:
            return window.state.data

        # Add to list
        items = window.state.data.get(key, [])
        if not isinstance(items, list):
            items = []

        items.append(value)
        window.state.data[key] = items

        return window.state.data

    def _remove_item(
        self,
        window: WindowRecord,
        config: Dict[str, Any],
        payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Remove an item from a list by index.

        Config:
            - key: The state key for the list (default: "items")

        Payload:
            - index: The index to remove
        """
        key = config.get("key", "items")
        index = payload.get("index")

        if index is None:
            return window.state.data

        items = window.state.data.get(key, [])
        if isinstance(items, list) and 0 <= index < len(items):
            items.pop(index)
            window.state.data[key] = items

        return window.state.data

    def _update_field(
        self,
        window: WindowRecord,
        config: Dict[str, Any],
        payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Update a field in state.

        Config:
            - key: The state key to update
            - increment: Optional number to increment by

        Payload:
            - value: The new value (if not incrementing)
        """
        key = config.get("key")
        if not key:
            return window.state.data

        increment = config.get("increment")
        if increment is not None:
            current = window.state.data.get(key, 0)
            window.state.data[key] = current + increment
        else:
            value = payload.get("value")
            window.state.data[key] = value

        return window.state.data

    def _clear_list(
        self,
        window: WindowRecord,
        config: Dict[str, Any],
        payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Clear a list in state.

        Config:
            - key: The state key for the list (default: "items")
        """
        key = config.get("key", "items")
        window.state.data[key] = []
        return window.state.data

    def _toggle_item(
        self,
        window: WindowRecord,
        config: Dict[str, Any],
        payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Toggle a boolean field.

        Config:
            - key: The state key to toggle
        """
        key = config.get("key")
        if not key:
            return window.state.data

        current = window.state.data.get(key, False)
        window.state.data[key] = not current
        return window.state.data

    def _set_selection(
        self,
        window: WindowRecord,
        config: Dict[str, Any],
        payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Set the current selection.

        Payload:
            - value: The selected value/id
        """
        window.state.selection = payload.get("value")
        return window.state.data


# Singleton instance
action_registry = ActionRegistry()
