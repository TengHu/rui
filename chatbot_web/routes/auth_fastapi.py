"""
Google OAuth2 authentication routes.

Endpoints:
- GET  /api/auth/login      - Redirects to Google OAuth
- GET  /api/auth/callback    - OAuth callback, sets session cookie
- GET  /api/auth/me          - Returns current user from JWT cookie
- POST /api/auth/logout      - Clears session cookie
"""

import os
import logging

from fastapi import APIRouter, Request, HTTPException, Depends
from fastapi.responses import RedirectResponse, JSONResponse
from authlib.integrations.starlette_client import OAuth

from middleware.auth import get_current_user, get_optional_user, create_session_token
from services.database import upsert_user

_COOKIE_SECURE_ENV = os.environ.get("COOKIE_SECURE", "")  # "" = auto-detect from request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

oauth = OAuth()
oauth.register(
    name="google",
    client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


def _get_request_scheme(request: Request) -> str:
    """Return the effective scheme, respecting X-Forwarded-Proto from reverse proxies."""
    return request.headers.get("x-forwarded-proto", request.url.scheme)


def _get_request_host(request: Request) -> str:
    """Return the effective host, respecting X-Forwarded-Host from reverse proxies."""
    return request.headers.get("x-forwarded-host", request.headers.get("host", "localhost"))


def _is_cookie_secure(request: Request) -> bool:
    """Determine if session cookie should be secure. Auto-detects from scheme if not configured."""
    if _COOKIE_SECURE_ENV:
        return _COOKIE_SECURE_ENV.lower() == "true"
    return _get_request_scheme(request) == "https"


def _get_redirect_uri(request: Request) -> str:
    """Resolve the OAuth redirect URI.

    Priority: OAUTH_REDIRECT_URI env var > auto-detect from request headers.
    Auto-detect respects X-Forwarded-Proto and X-Forwarded-Host so it works
    behind reverse proxies (production) and directly (local dev).
    """
    configured = os.environ.get("OAUTH_REDIRECT_URI", "")
    if configured:
        return configured
    scheme = _get_request_scheme(request)
    host = _get_request_host(request)
    return f"{scheme}://{host}/api/auth/callback"


@router.get("/login")
async def login(request: Request):
    """Redirect the browser to Google OAuth consent screen.

    authlib stores the CSRF state in request.session (via SessionMiddleware)
    so the callback can verify it.
    """
    # Store the frontend origin so the callback redirects back to it
    return_to = request.query_params.get("return_to", "")
    if return_to:
        request.session["return_to"] = return_to

    redirect_uri = _get_redirect_uri(request)
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get("/callback", name="auth_callback")
async def auth_callback(request: Request):
    """Exchange the authorization code for tokens, upsert user, set session cookie."""
    try:
        token = await oauth.google.authorize_access_token(request)
    except Exception as exc:
        logger.error("OAuth token exchange failed: %s", exc)
        raise HTTPException(status_code=400, detail="OAuth authentication failed")

    userinfo = token.get("userinfo")
    if not userinfo:
        raise HTTPException(status_code=400, detail="Could not retrieve user info from Google")

    google_id = userinfo.get("sub", "")
    email = userinfo.get("email", "")
    name = userinfo.get("name", "")
    picture = userinfo.get("picture", "")

    if not google_id or not email:
        raise HTTPException(status_code=400, detail="Incomplete user info from Google")

    user = await upsert_user(
        google_id=google_id,
        email=email,
        name=name,
        picture_url=picture,
    )

    session_token = create_session_token(user["id"], user["email"])

    # Redirect back to the frontend origin (e.g. Vite dev server on :5173)
    return_to = request.session.pop("return_to", None)
    frontend_url = return_to or os.environ.get("FRONTEND_URL", "/")
    response = RedirectResponse(url=frontend_url, status_code=302)
    response.set_cookie(
        "session",
        session_token,
        httponly=True,
        secure=_is_cookie_secure(request),
        samesite="lax",
        max_age=60 * 60 * 24 * 7,  # 7 days
    )
    return response


@router.get("/me")
async def me(user=Depends(get_optional_user)):
    """Return current user info from JWT cookie. Returns null user if not authenticated."""
    if not user:
        return {"user": None}

    from services.database import get_user_by_id

    db_user = await get_user_by_id(user["user_id"])
    if not db_user:
        return {"user": None}

    return {
        "user": {
            "id": db_user["id"],
            "email": db_user["email"],
            "name": db_user["name"],
            "picture_url": db_user["picture_url"],
        }
    }


@router.post("/logout")
async def logout():
    """Clear the session cookie."""
    response = JSONResponse({"success": True})
    response.delete_cookie("session")
    return response
