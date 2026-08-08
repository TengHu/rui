import { useEffect, useCallback } from 'react'
import { useWindows } from '../context/WindowContext'

/**
 * Global keyboard shortcuts for desktop window management
 *
 * Shortcuts:
 * - Cmd/Ctrl + W: Close active window
 * - Cmd/Ctrl + M: Minimize active window
 * - Cmd/Ctrl + Tab: Cycle through windows
 * - Cmd/Ctrl + Shift + W: Close all windows
 * - Cmd/Ctrl + V: Paste from clipboard (handled by useClipboard hook)
 * - Escape: Unfocus active window (deselect)
 */
export function useKeyboardShortcuts() {
  const {
    windows,
    focusedWindowId,
    minimizedWindows,
    closeWindow,
    focusWindow,
    minimizeWindow,
    clearAllWindows
  } = useWindows()

  // Get active (non-minimized) windows
  const activeWindows = windows.filter(w => !minimizedWindows.includes(w.id))

  const handleKeyDown = useCallback((e) => {
    // Detect platform
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
    const mod = isMac ? e.metaKey : e.ctrlKey

    // Skip if typing in an input/textarea/editable element
    if (
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'TEXTAREA' ||
      e.target.isContentEditable
    ) {
      return
    }

    // Close window: Cmd/Ctrl + W
    if (mod && e.key.toLowerCase() === 'w' && !e.shiftKey) {
      e.preventDefault()
      if (focusedWindowId) {
        closeWindow(focusedWindowId)
      }
      return
    }

    // Close all windows: Cmd/Ctrl + Shift + W
    if (mod && e.shiftKey && e.key.toLowerCase() === 'w') {
      e.preventDefault()
      clearAllWindows()
      return
    }

    // Minimize window: Cmd/Ctrl + M
    if (mod && e.key.toLowerCase() === 'm') {
      e.preventDefault()
      if (focusedWindowId) {
        minimizeWindow(focusedWindowId)
      }
      return
    }

    // Cycle windows: Cmd/Ctrl + Tab
    if (mod && e.key === 'Tab') {
      e.preventDefault()
      if (activeWindows.length === 0) return

      const currentIndex = activeWindows.findIndex(w => w.id === focusedWindowId)
      let nextIndex

      if (e.shiftKey) {
        // Reverse cycle: Cmd/Ctrl + Shift + Tab
        nextIndex = currentIndex <= 0 ? activeWindows.length - 1 : currentIndex - 1
      } else {
        // Forward cycle
        nextIndex = (currentIndex + 1) % activeWindows.length
      }

      const nextWindow = activeWindows[nextIndex]
      if (nextWindow) {
        focusWindow(nextWindow.id)
      }
      return
    }

    // Escape: Unfocus/deselect active window
    if (e.key === 'Escape') {
      // Don't prevent default - allow other escape handlers to work
      // This just provides a way to "deselect" the current focus
      return
    }
  }, [focusedWindowId, activeWindows, closeWindow, focusWindow, minimizeWindow, clearAllWindows])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

export default useKeyboardShortcuts
