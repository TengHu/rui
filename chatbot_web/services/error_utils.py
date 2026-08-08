"""
User-friendly error message sanitization.
"""


def sanitize_error(error: str) -> str:
    """Convert technical errors to user-friendly messages."""
    if not error:
        return "Something went wrong. Please try again."

    error_lower = error.lower()

    if "exit code -15" in error_lower or "sigterm" in error_lower:
        return "The operation was interrupted. Please try again."
    if "exit code -9" in error_lower or "sigkill" in error_lower:
        return "The operation ran out of resources. Please try a simpler request."
    if "timeout" in error_lower:
        return "The operation timed out. Please try again."
    if "connection" in error_lower and ("refused" in error_lower or "error" in error_lower):
        return "Connection error. Please try again."

    if "Traceback" in error:
        lines = error.strip().split('\n')
        for line in reversed(lines):
            line = line.strip()
            if line and not line.startswith(('File ', 'at ', '  ')):
                clean = line[:150] + "..." if len(line) > 150 else line
                return f"Error: {clean}. Please try again."
        return "An error occurred. Please try again."

    if len(error) > 200:
        return error[:150] + "... Please try again."

    return error
