"""
Binding resolver for derived windows.

Resolves window bindings to get data from source windows
and applies transforms.
"""

from typing import Dict, Any, Optional, TYPE_CHECKING
import logging

from services.transforms import apply_transform

if TYPE_CHECKING:
    from models.window_spec import WindowRecord

logger = logging.getLogger(__name__)


def resolve_bindings(
    window: "WindowRecord",
    window_store: "Any"  # Avoid circular import
) -> Dict[str, Any]:
    """
    Resolve a window's bindings to get bound data.

    Args:
        window: The window with bindings to resolve
        window_store: The window store to look up source windows

    Returns:
        Dict with "boundData" key containing resolved data
    """
    if not window.bindings:
        return {}

    binding = window.bindings

    # Get source window
    source = window_store.get(binding.sourceWindowId)
    if not source:
        logger.warning(f"Source window {binding.sourceWindowId} not found for binding")
        return {"boundData": None, "bindingError": "Source window not found"}

    # Get source data
    source_data = source.state.data.get(binding.inputKey, [])

    # Apply transform if specified
    if binding.transform:
        transformed = apply_transform(
            binding.transform,
            source_data,
            **binding.transformConfig
        )
        return {"boundData": transformed}

    return {"boundData": source_data}


def update_derived_windows(
    source_window_id: str,
    window_store: "Any"
) -> None:
    """
    Update all windows that derive from a source window.

    Called when source window's state changes.

    Args:
        source_window_id: ID of the source window that changed
        window_store: The window store
    """
    for window in window_store.get_all():
        if window.bindings and window.bindings.sourceWindowId == source_window_id:
            # Resolve new bound data
            bound_data = resolve_bindings(window, window_store)

            # Update derived window's state
            window.state.derived.update(bound_data)

            # Trigger update (the store listener will broadcast)
            window_store.update(window.id, state=window.state)
            logger.info(f"Updated derived window {window.id} from source {source_window_id}")


def get_binding_chain(
    window: "WindowRecord",
    window_store: "Any",
    max_depth: int = 10
) -> list:
    """
    Get the chain of source windows for a derived window.

    Useful for debugging and understanding data flow.

    Args:
        window: Starting window
        window_store: Window store
        max_depth: Maximum chain depth to prevent infinite loops

    Returns:
        List of window IDs in the binding chain
    """
    chain = [window.id]
    current = window
    depth = 0

    while current.bindings and depth < max_depth:
        source_id = current.bindings.sourceWindowId
        if source_id in chain:
            # Circular reference detected
            chain.append(f"{source_id} (circular)")
            break

        chain.append(source_id)
        current = window_store.get(source_id)
        if not current:
            break
        depth += 1

    return chain
