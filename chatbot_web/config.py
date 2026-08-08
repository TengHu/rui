"""
Shared configuration constants.
"""

import os

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/home/user/workspace")
MCP_SERVER_PORT = 3000
E2B_DOMAIN = os.environ.get("E2B_DOMAIN")
E2B_DOMAINS = [E2B_DOMAIN] if E2B_DOMAIN else ["e2b.app", "e2b.dev"]

# OAuth / session
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
SESSION_SECRET_KEY = os.environ.get("SESSION_SECRET_KEY", "")
OAUTH_REDIRECT_URI = os.environ.get("OAUTH_REDIRECT_URI", "")
