"""
SQLite database service for user records and sandbox mapping.

Uses aiosqlite for async operations. Database file lives at
chatbot_web/data/app.db (gitignored).
"""

import os
import logging
from typing import Optional, Dict, Any
from datetime import datetime

import aiosqlite

logger = logging.getLogger(__name__)

DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "app.db",
)

_db: Optional[aiosqlite.Connection] = None


async def init_db() -> None:
    """Create tables on startup. Safe to call multiple times."""
    global _db
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    _db = await aiosqlite.connect(DB_PATH)
    _db.row_factory = aiosqlite.Row

    await _db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            google_id     TEXT    UNIQUE NOT NULL,
            email         TEXT    NOT NULL,
            name          TEXT    NOT NULL DEFAULT '',
            picture_url   TEXT    NOT NULL DEFAULT '',
            created_at    TEXT    NOT NULL,
            last_login_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_sandboxes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            sandbox_id  TEXT    NOT NULL,
            created_at  TEXT    NOT NULL,
            expires_at  TEXT,
            is_active   INTEGER NOT NULL DEFAULT 1
        );

        CREATE INDEX IF NOT EXISTS idx_user_sandboxes_user_active
            ON user_sandboxes(user_id, is_active);
        """
    )
    await _db.commit()
    logger.info("Database initialized at %s", DB_PATH)


async def close_db() -> None:
    """Close the database connection."""
    global _db
    if _db:
        await _db.close()
        _db = None


def _get_db() -> aiosqlite.Connection:
    if _db is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    return _db


async def upsert_user(
    google_id: str,
    email: str,
    name: str = "",
    picture_url: str = "",
) -> Dict[str, Any]:
    """Insert or update a user by google_id. Returns the user row as dict."""
    db = _get_db()
    now = datetime.utcnow().isoformat()

    await db.execute(
        """
        INSERT INTO users (google_id, email, name, picture_url, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(google_id) DO UPDATE SET
            email         = excluded.email,
            name          = excluded.name,
            picture_url   = excluded.picture_url,
            last_login_at = excluded.last_login_at
        """,
        (google_id, email, name, picture_url, now, now),
    )
    await db.commit()

    cursor = await db.execute(
        "SELECT * FROM users WHERE google_id = ?", (google_id,)
    )
    row = await cursor.fetchone()
    return dict(row)


async def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    """Fetch a user by primary key."""
    db = _get_db()
    cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def get_active_sandbox(user_id: int) -> Optional[str]:
    """Return the active sandbox_id for a user, or None."""
    db = _get_db()
    cursor = await db.execute(
        """
        SELECT sandbox_id FROM user_sandboxes
        WHERE user_id = ? AND is_active = 1
        ORDER BY created_at DESC LIMIT 1
        """,
        (user_id,),
    )
    row = await cursor.fetchone()
    return row["sandbox_id"] if row else None


async def set_user_sandbox(
    user_id: int,
    sandbox_id: str,
    expires_at: Optional[str] = None,
) -> None:
    """Record a new active sandbox for a user."""
    db = _get_db()
    now = datetime.utcnow().isoformat()
    await db.execute(
        """
        INSERT INTO user_sandboxes (user_id, sandbox_id, created_at, expires_at, is_active)
        VALUES (?, ?, ?, ?, 1)
        """,
        (user_id, sandbox_id, now, expires_at),
    )
    await db.commit()


async def deactivate_sandbox(user_id: int, sandbox_id: Optional[str] = None) -> None:
    """Mark sandbox(es) as inactive for a user."""
    db = _get_db()
    if sandbox_id:
        await db.execute(
            "UPDATE user_sandboxes SET is_active = 0 WHERE user_id = ? AND sandbox_id = ?",
            (user_id, sandbox_id),
        )
    else:
        await db.execute(
            "UPDATE user_sandboxes SET is_active = 0 WHERE user_id = ?",
            (user_id,),
        )
    await db.commit()
