"""
In-memory window store for the Spatial Desktop system.

This is the source of truth for all window state during a session.
No database - everything lives in memory and resets on restart.
"""

from typing import Dict, Optional, List, Callable
from datetime import datetime
import threading
from models.window_spec import WindowRecord


class WindowStore:
    """Thread-safe in-memory store for WindowRecords."""

    def __init__(self):
        self._windows: Dict[str, WindowRecord] = {}
        self._lock = threading.RLock()
        self._listeners: List[Callable[[str, WindowRecord], None]] = []

    def get(self, window_id: str) -> Optional[WindowRecord]:
        """Get a window by ID."""
        with self._lock:
            return self._windows.get(window_id)

    def get_all(self) -> List[WindowRecord]:
        """Get all windows."""
        with self._lock:
            return list(self._windows.values())

    def get_all_for_user(self, user_id: int) -> List[WindowRecord]:
        """Get all windows belonging to a specific user."""
        with self._lock:
            return [w for w in self._windows.values() if w.user_id == user_id]

    def create(self, record: WindowRecord) -> WindowRecord:
        """Add a new window to the store."""
        with self._lock:
            self._windows[record.id] = record
            self._notify("created", record)
        return record

    def update(self, window_id: str, **updates) -> Optional[WindowRecord]:
        """Update a window's fields."""
        with self._lock:
            record = self._windows.get(window_id)
            if not record:
                return None

            for key, value in updates.items():
                if hasattr(record, key):
                    setattr(record, key, value)

            record.updatedAt = datetime.utcnow()
            self._notify("updated", record)
            return record

    def update_state(self, window_id: str, state_updates: Dict) -> Optional[WindowRecord]:
        """Update a window's state.data."""
        with self._lock:
            record = self._windows.get(window_id)
            if not record:
                return None

            record.state.data.update(state_updates)
            record.updatedAt = datetime.utcnow()
            self._notify("updated", record)
            return record

    def delete(self, window_id: str) -> bool:
        """Remove a window from the store."""
        with self._lock:
            if window_id in self._windows:
                record = self._windows.pop(window_id)
                self._notify("deleted", record)
                return True
            return False

    def clear(self):
        """Clear all windows (for testing/reset)."""
        with self._lock:
            self._windows.clear()

    def add_listener(self, callback: Callable[[str, WindowRecord], None]):
        """Add a listener for window changes."""
        self._listeners.append(callback)

    def remove_listener(self, callback: Callable[[str, WindowRecord], None]):
        """Remove a listener."""
        if callback in self._listeners:
            self._listeners.remove(callback)

    def _notify(self, event_type: str, record: WindowRecord):
        """Notify all listeners of a change."""
        for listener in self._listeners:
            try:
                listener(event_type, record)
            except Exception as e:
                print(f"Error notifying listener: {e}")


# Singleton instance
window_store = WindowStore()
