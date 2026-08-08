"""
FastAPI REST API routes for window operations.

Endpoints:
- GET  /api/windows         - List all windows
- POST /api/windows         - Create window from prompt
- GET  /api/windows/:id     - Get single window
- POST /api/windows/:id/action - Execute action on window
- DELETE /api/windows/:id   - Delete window
- PATCH /api/windows/:id/position - Update window position
- PATCH /api/windows/:id/size - Update window size
- PATCH /api/windows/:id/state - Update window state
"""

import logging
from typing import Optional, Dict, Any
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from middleware.auth import get_current_user
from datetime import datetime

from models.window_spec import WindowRecord, WindowSpec, WindowBinding
from stores.window_store import window_store
from stores.action_registry import action_registry
from services.spec_generator import generate_spec
from services.binding_resolver import resolve_bindings, update_derived_windows

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/windows",
    tags=["windows"],
)


def _check_window_owner(window: WindowRecord, user_id: int) -> None:
    """Raise 403 if the window does not belong to the user."""
    if window.user_id is not None and window.user_id != user_id:
        raise HTTPException(status_code=403, detail="Forbidden")


# Pydantic models for request bodies
class CreateWindowRequest(BaseModel):
    prompt: str
    useAI: bool = True
    initialState: Optional[Dict[str, Any]] = None
    position: Optional[Dict[str, int]] = None
    size: Optional[Dict[str, int]] = None


class ActionRequest(BaseModel):
    actionId: str
    payload: Optional[Dict[str, Any]] = None


class StateUpdateRequest(BaseModel):
    key: str
    value: Any


class PositionRequest(BaseModel):
    x: int = 0
    y: int = 0


class SizeRequest(BaseModel):
    width: int = 400
    height: int = 300


@router.get("")
async def get_all_windows(user=Depends(get_current_user)):
    """
    Get all windows for the current user.

    Returns:
        JSON array of user's WindowRecords
    """
    windows = window_store.get_all_for_user(user["user_id"])
    return [w.to_client_dict() for w in windows]


@router.post("", status_code=201)
async def create_window(request: CreateWindowRequest, user=Depends(get_current_user)):
    """
    Create a new window from a natural language prompt.

    Returns:
        Created WindowRecord
    """
    prompt = request.prompt.strip()

    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    try:
        # Generate spec from prompt
        spec = generate_spec(prompt, use_ai=request.useAI)

        # Create window record
        initial_state = request.initialState or {}
        record = WindowRecord.create(spec, initial_state=initial_state)
        record.user_id = user["user_id"]

        # Set position if provided
        if request.position:
            record.position = request.position
        if request.size:
            record.size = request.size

        # Store and emit event
        window_store.create(record)

        logger.info(f"Created window {record.id}: {record.title} for user {user['user_id']}")
        return record.to_client_dict()

    except Exception as e:
        logger.exception(f"Failed to create window: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{window_id}")
async def get_window(window_id: str, user=Depends(get_current_user)):
    """
    Get a single window by ID.

    Returns:
        WindowRecord or 404
    """
    window = window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    # Resolve bindings if this is a derived window
    if window.bindings:
        bound_data = resolve_bindings(window, window_store)
        window.state.derived.update(bound_data)

    return window.to_client_dict()


@router.delete("/{window_id}")
async def delete_window(window_id: str, user=Depends(get_current_user)):
    """
    Delete a window.

    Returns:
        Success message or 404
    """
    window = window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    window_store.delete(window_id)
    logger.info(f"Deleted window {window_id}")
    return {"success": True, "id": window_id}


@router.post("/{window_id}/action")
async def execute_action(window_id: str, request: ActionRequest, user=Depends(get_current_user)):
    """
    Execute an action on a window.

    Returns:
        Updated WindowRecord
    """
    window = window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    action_id = request.actionId
    payload = request.payload or {}

    if not action_id:
        raise HTTPException(status_code=400, detail="actionId is required")

    # Get action definition from spec
    action_def = window.spec.actions.get(action_id)
    if not action_def:
        raise HTTPException(status_code=404, detail=f"Action '{action_id}' not found in window spec")

    # Check handler exists
    if not action_registry.has_handler(action_def.type):
        raise HTTPException(status_code=400, detail=f"No handler for action type '{action_def.type}'")

    try:
        # Execute action
        new_state_data = action_registry.execute(
            action_def.type,
            window,
            action_def.config,
            payload
        )

        # Update window state
        window.state.data = new_state_data
        window.updatedAt = datetime.utcnow()
        window_store.update(window_id, state=window.state)

        # Update any derived windows
        update_derived_windows(window_id, window_store)

        logger.info(f"Executed action {action_id} on window {window_id}")
        return window.to_client_dict()

    except Exception as e:
        logger.exception(f"Action execution failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{window_id}/state")
async def update_state(window_id: str, request: StateUpdateRequest, user=Depends(get_current_user)):
    """
    Directly update window state (for input binding).

    Returns:
        Updated WindowRecord
    """
    window = window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    key = request.key
    value = request.value

    if not key:
        raise HTTPException(status_code=400, detail="key is required")

    window.state.data[key] = value
    window.updatedAt = datetime.utcnow()
    window_store.update(window_id, state=window.state)

    return window.to_client_dict()


@router.patch("/{window_id}/position")
async def update_position(window_id: str, request: PositionRequest, user=Depends(get_current_user)):
    """
    Update window position (from drag).
    """
    window = window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    window.position = {"x": request.x, "y": request.y}
    window.updatedAt = datetime.utcnow()
    window_store.update(window_id, position=window.position)

    return {"success": True}


@router.patch("/{window_id}/size")
async def update_size(window_id: str, request: SizeRequest, user=Depends(get_current_user)):
    """
    Update window size (from resize).
    """
    window = window_store.get(window_id)
    if not window:
        raise HTTPException(status_code=404, detail="Window not found")
    _check_window_owner(window, user["user_id"])

    window.size = {"width": request.width, "height": request.height}
    window.updatedAt = datetime.utcnow()
    window_store.update(window_id, size=window.size)

    return {"success": True}
