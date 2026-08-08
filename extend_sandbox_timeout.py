#!/usr/bin/env python3
"""
Extend E2B sandbox timeout to extend the sandbox lifetime.

According to E2B documentation, using set_timeout() on a sandbox instance
extends the sandbox's lifetime, not just per-operation timeouts.

Usage:
    python extend_sandbox_timeout.py <sandbox_id> [hours]
    
Example:
    python extend_sandbox_timeout.py ior4kh59h2wb2fz7w9hni 24
"""

import sys
import os
import asyncio
import logging

# Try to load environment variables from .env file (optional)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv not installed, rely on environment variables being set

from e2b_code_interpreter import AsyncSandbox

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


async def extend_sandbox_timeout(sandbox_id: str, timeout_hours: int = 24) -> bool:
    """
    Extend the lifetime timeout of an existing E2B sandbox.
    
    This uses the E2B SDK's set_timeout() method which extends the sandbox's
    overall lifetime according to E2B documentation.
    
    Args:
        sandbox_id: The sandbox ID to extend
        timeout_hours: Number of hours to extend the timeout to (default: 24)
    
    Returns:
        True if successful, False otherwise
    """
    if not os.environ.get("E2B_API_KEY"):
        logger.error("E2B_API_KEY not found in environment")
        return False
    
    timeout_seconds = timeout_hours * 3600  # Convert hours to seconds
    
    try:
        logger.info(f"Connecting to sandbox {sandbox_id}...")
        sandbox = await AsyncSandbox.connect(sandbox_id=sandbox_id)
        
        logger.info(f"Extending sandbox timeout to {timeout_hours} hours ({timeout_seconds} seconds)...")
        await sandbox.set_timeout(timeout_seconds)
        
        logger.info(f"✓ Successfully extended sandbox {sandbox_id} timeout to {timeout_hours} hours")
        return True
        
    except Exception as e:
        logger.error(f"✗ Failed to extend sandbox timeout: {e}")
        return False


def main():
    """Main entry point."""
    if len(sys.argv) < 2:
        print("Usage: python extend_sandbox_timeout.py <sandbox_id> [hours]")
        print("Example: python extend_sandbox_timeout.py ior4kh59h2wb2fz7w9hni 24")
        sys.exit(1)
    
    sandbox_id = sys.argv[1]
    timeout_hours = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    
    success = asyncio.run(extend_sandbox_timeout(sandbox_id, timeout_hours))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
