/**
 * SelectionContext - Cross-window postMessage relay
 *
 * Relays postMessage events between iframes (RouteWindows).
 * When one iframe broadcasts a SELECTION, all other iframes receive SELECTION_BROADCAST.
 *
 * This enables windows to communicate without knowing about each other.
 * The AI generates apps that emit/listen to these events based on user prompts.
 *
 * Features:
 * - Origin validation (only accepts messages from same origin)
 * - Ready state tracking (only broadcasts to ready iframes)
 * - Window ready protocol (iframes send WINDOW_READY when loaded)
 */

import { createContext, useContext, useEffect, useCallback, useRef, useState } from 'react'

// Message types for window communication protocol
export const MessageTypes = {
  SELECTION: 'SELECTION',
  SELECTION_BROADCAST: 'SELECTION_BROADCAST',
  WINDOW_READY: 'WINDOW_READY',
}

const SelectionContext = createContext(null)

export function SelectionProvider({ children }) {
  // windowId -> { iframe: HTMLIFrameElement, ready: boolean }
  const iframeRefsRef = useRef(new Map())
  const [currentSelection, setCurrentSelection] = useState(null)

  // Listen for postMessage from iframes and relay to all other iframes
  useEffect(() => {
    const handleMessage = (event) => {
      // Security: Validate origin (only accept from same origin or sandbox URLs)
      const isSameOrigin = event.origin === window.location.origin
      let isSandboxOrigin = false
      try {
        const { hostname } = new URL(event.origin)
        isSandboxOrigin = hostname.endsWith('.e2b.app') || hostname.endsWith('.e2b.dev')
      } catch {
        isSandboxOrigin = false
      }

      if (!isSameOrigin && !isSandboxOrigin) {
        // Silently ignore messages from unknown origins
        return
      }

      // Validate message structure
      if (!event.data || typeof event.data !== 'object') return

      const { type } = event.data

      // Handle WINDOW_READY message from iframe
      if (type === MessageTypes.WINDOW_READY) {
        const { windowId } = event.data
        if (windowId) {
          const entry = iframeRefsRef.current.get(windowId)
          if (entry) {
            entry.ready = true
            console.log(`[SelectionContext] Window ${windowId} is ready to receive broadcasts`)
          }
        }
        return
      }

      // Handle SELECTION message
      if (type !== MessageTypes.SELECTION) return

      const selection = event.data.selection
      if (!selection) return

      console.log('[SelectionContext] Received selection from iframe:', selection)

      // Add timestamp and update current selection
      const enrichedSelection = {
        ...selection,
        timestamp: selection.timestamp || Date.now(),
      }
      setCurrentSelection(enrichedSelection)

      // Broadcast to all OTHER ready iframes (not the sender)
      let broadcastCount = 0
      let skippedNotReady = 0

      iframeRefsRef.current.forEach((entry, windowId) => {
        const { iframe, ready } = entry

        // Skip iframes that haven't signaled ready
        if (!ready) {
          skippedNotReady++
          return
        }

        // Skip the sender
        if (iframe?.contentWindow && event.source !== iframe.contentWindow) {
          try {
            // Use specific origin for security (sandbox URLs or same origin)
            const targetOrigin = window.location.origin
            iframe.contentWindow.postMessage({
              type: MessageTypes.SELECTION_BROADCAST,
              selection: enrichedSelection,
            }, targetOrigin)
            broadcastCount++
          } catch (err) {
            console.warn(`[SelectionContext] Failed to post message to window ${windowId}:`, err)
          }
        }
      })

      console.log(`[SelectionContext] Broadcast to ${broadcastCount} windows (${skippedNotReady} not ready)`)
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Register an iframe for receiving selection broadcasts
  const registerIframe = useCallback((windowId, iframeElement) => {
    if (iframeElement) {
      iframeRefsRef.current.set(windowId, {
        iframe: iframeElement,
        ready: false, // Start as not ready, wait for WINDOW_READY message
      })
      console.log(`[SelectionContext] Registered iframe for window ${windowId} (waiting for ready signal)`)
    }
    return () => {
      iframeRefsRef.current.delete(windowId)
      console.log(`[SelectionContext] Unregistered iframe for window ${windowId}`)
    }
  }, [])

  // Manually mark a window as ready (useful for windows that don't send WINDOW_READY)
  const markWindowReady = useCallback((windowId) => {
    const entry = iframeRefsRef.current.get(windowId)
    if (entry) {
      entry.ready = true
      console.log(`[SelectionContext] Manually marked window ${windowId} as ready`)
    }
  }, [])

  // Clear current selection
  const clearSelection = useCallback(() => {
    setCurrentSelection(null)
  }, [])

  // Get ready state of all windows (for debugging)
  const getWindowStates = useCallback(() => {
    const states = {}
    iframeRefsRef.current.forEach((entry, windowId) => {
      states[windowId] = { ready: entry.ready }
    })
    return states
  }, [])

  const value = {
    registerIframe,
    markWindowReady,
    currentSelection,
    clearSelection,
    getWindowStates,
  }

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  )
}

export function useSelection() {
  const context = useContext(SelectionContext)
  if (!context) {
    throw new Error('useSelection must be used within SelectionProvider')
  }
  return context
}
