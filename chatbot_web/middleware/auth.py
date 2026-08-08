"""
JWT-based auth middleware for FastAPI.

Reads a session cookie containing a JWT (HS256), decodes it, and
provides the current user info as a FastAPI dependency.
"""

import os
import logging
from typing import Optional, Dict, Any
from datetime import datetime, timedelta

from fastapi import Request, HTTPException
from jose import jwt, JWTError

logger = logging.getLogger(__name__)

ALGORITHM = "HS256"


def _get_secret() -> str:
    secret = os.environ.get("SESSION_SECRET_KEY", "")
    if not secret:
        raise RuntimeError("SESSION_SECRET_KEY is not configured")
    return secret


def _decode_token(token: str) -> Dict[str, Any]:
    """Decode and verify a JWT. Raises JWTError on failure."""
    return jwt.decode(token, _get_secret(), algorithms=[ALGORITHM])


def create_session_token(user_id: int, email: str) -> str:
    """Create a signed JWT for the session cookie (7 day expiry)."""
    payload = {
        "user_id": user_id,
        "email": email,
        "exp": datetime.utcnow() + timedelta(days=7),
    }
    return jwt.encode(payload, _get_secret(), algorithm=ALGORITHM)


async def get_current_user(request: Request) -> Dict[str, Any]:
    """
    FastAPI dependency: extract and verify user from session cookie.
    Raises 401 if missing or invalid.
    """
    token = request.cookies.get("session")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        payload = _decode_token(token)
    except JWTError as exc:
        logger.warning("Invalid session token: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid session")

    user_id = payload.get("user_id")
    email = payload.get("email")
    if not user_id or not email:
        raise HTTPException(status_code=401, detail="Invalid session payload")

    return {"user_id": user_id, "email": email}


async def get_optional_user(request: Request) -> Optional[Dict[str, Any]]:
    """
    Same as get_current_user but returns None instead of 401 when
    the session is missing or invalid.
    """
    token = request.cookies.get("session")
    if not token:
        return None

    try:
        payload = _decode_token(token)
    except JWTError:
        return None

    user_id = payload.get("user_id")
    email = payload.get("email")
    if not user_id or not email:
        return None

    return {"user_id": user_id, "email": email}
