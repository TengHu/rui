/**
 * Window Session Storage
 *
 * Stores Anthropic session_id per window in sessionStorage.
 * This is the SINGLE SOURCE OF TRUTH for conversation continuity.
 *
 * - Survives page refresh (browser sessionStorage)
 * - Scoped to tab (each browser tab has its own sessionStorage)
 * - Key format: `window_session_${windowId}`
 *
 * Flow:
 * 1. First message to window: No session_id, starts new conversation
 * 2. Claude returns session_id in response
 * 3. Frontend saves session_id to sessionStorage
 * 4. Next message: Frontend reads session_id, sends to backend
 * 5. Backend uses session_id to resume conversation
 */

const PREFIX = 'window_session_'

/**
 * Get the Anthropic session_id for a window
 * @param {string} windowId - The window ID (e.g., "rwin_abc123")
 * @returns {string|null} The session_id or null if not found
 */
export function getWindowSessionId(windowId) {
  if (!windowId) return null
  return sessionStorage.getItem(`${PREFIX}${windowId}`)
}

/**
 * Save the Anthropic session_id for a window
 * @param {string} windowId - The window ID
 * @param {string} sessionId - The Anthropic session_id to store
 */
export function setWindowSessionId(windowId, sessionId) {
  if (!windowId || !sessionId) return
  sessionStorage.setItem(`${PREFIX}${windowId}`, sessionId)
}

/**
 * Clear the session_id for a window (e.g., when window is deleted)
 * @param {string} windowId - The window ID
 */
export function clearWindowSessionId(windowId) {
  if (!windowId) return
  sessionStorage.removeItem(`${PREFIX}${windowId}`)
}

/**
 * Get all stored window sessions (for debugging)
 * @returns {Object} Map of windowId -> sessionId
 */
export function getAllWindowSessions() {
  const sessions = {}
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i)
    if (key && key.startsWith(PREFIX)) {
      const windowId = key.slice(PREFIX.length)
      sessions[windowId] = sessionStorage.getItem(key)
    }
  }
  return sessions
}

/**
 * Clear all window sessions (for debugging/reset)
 */
export function clearAllWindowSessions() {
  const keysToRemove = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i)
    if (key && key.startsWith(PREFIX)) {
      keysToRemove.push(key)
    }
  }
  keysToRemove.forEach(key => sessionStorage.removeItem(key))
}
