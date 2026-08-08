import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { useAuth } from './AuthContext'
import { getNewWindowPosition, resetWindowOffset, DEFAULT_WINDOW_SIZE } from '../utils/windowTypes'
import { APP_CONFIG } from '../utils/constants'

const WindowContext = createContext()

export const useWindows = () => {
  const context = useContext(WindowContext)
  if (!context) {
    throw new Error('useWindows must be used within WindowProvider')
  }
  return context
}

export const WindowProvider = ({ children }) => {
  const { user, authLoading } = useAuth()
  const [windows, setWindows] = useState([])
  const [focusedWindowId, setFocusedWindowId] = useState(null)
  const [minimizedWindows, setMinimizedWindows] = useState([])
  const [maximizedWindows, setMaximizedWindows] = useState([]) // Track maximized windows
  const [nextZIndex, setNextZIndex] = useState(100)

  const storageKey = user ? `desktop_windows_${user.id}` : null

  // Load windows from localStorage once auth resolves.
  // Note: Windows with component-based content (Terminal, File Manager) cannot be restored
  // because JSX elements can't be serialized. We only restore windows with serializable content.
  useEffect(() => {
    if (authLoading) return

    if (!storageKey) {
      setWindows([])
      return
    }

    const savedWindows = localStorage.getItem(storageKey)
    if (savedWindows) {
      try {
        const parsed = JSON.parse(savedWindows)
        // Filter out windows that require component content (they have no content after deserialization)
        const NON_RESTORABLE_TYPES = ['TERMINAL', 'FILE_MANAGER']
        const restorable = parsed.filter(w => !NON_RESTORABLE_TYPES.includes(w.type))

        if (restorable.length !== parsed.length) {
          // Update localStorage to remove non-restorable windows
          localStorage.setItem(storageKey, JSON.stringify(restorable))
        }

        setWindows(restorable)
        if (restorable.length > 0) {
          setFocusedWindowId(restorable[restorable.length - 1].id)
        }
      } catch (e) {
        console.error('Failed to load saved windows:', e)
      }
    }
  }, [authLoading, storageKey])

  // Save windows to localStorage when they change.
  // Note: We filter out 'content' since JSX elements can't be serialized.
  useEffect(() => {
    if (!storageKey) return
    if (windows.length > 0) {
      const windowsToSave = windows.map((window) => {
        const rest = { ...window }
        delete rest.content
        return rest
      })
      localStorage.setItem(storageKey, JSON.stringify(windowsToSave))
    }
  }, [windows, storageKey])

  const openWindow = useCallback((windowConfig) => {
    setWindows(prev => {
      // Check if we've hit the max window limit
      if (prev.length >= APP_CONFIG.MAX_OPEN_WINDOWS) {
        // Close the oldest window
        const filtered = prev.slice(1)
        return [...filtered, {
          ...windowConfig,
          position: windowConfig.position || getNewWindowPosition(),
          size: windowConfig.size || DEFAULT_WINDOW_SIZE,
          zIndex: nextZIndex
        }]
      }

      return [...prev, {
        ...windowConfig,
        position: windowConfig.position || getNewWindowPosition(),
        size: windowConfig.size || DEFAULT_WINDOW_SIZE,
        zIndex: nextZIndex
      }]
    })

    setFocusedWindowId(windowConfig.id)
    setNextZIndex(prev => prev + 1)

    // Remove from minimized if it was there
    setMinimizedWindows(prev => prev.filter(id => id !== windowConfig.id))
  }, [nextZIndex])

  const closeWindow = useCallback((windowId) => {
    setWindows(prev => prev.filter(w => w.id !== windowId))
    setMinimizedWindows(prev => prev.filter(id => id !== windowId))

    // Focus next window if the closed window was focused
    setFocusedWindowId(prevFocused => {
      if (prevFocused === windowId) {
        const remaining = windows.filter(w => w.id !== windowId)
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null
      }
      return prevFocused
    })
  }, [windows])

  const minimizeWindow = useCallback((windowId) => {
    setMinimizedWindows(prev => {
      if (!prev.includes(windowId)) {
        return [...prev, windowId]
      }
      return prev
    })

    // Focus next window
    setFocusedWindowId(prevFocused => {
      if (prevFocused === windowId) {
        const activeWindows = windows.filter(w => w.id !== windowId && !minimizedWindows.includes(w.id))
        return activeWindows.length > 0 ? activeWindows[activeWindows.length - 1].id : null
      }
      return prevFocused
    })
  }, [windows, minimizedWindows])

  const focusWindow = useCallback((windowId) => {
    setFocusedWindowId(windowId)

    // Bring window to front
    setWindows(prev => {
      const window = prev.find(w => w.id === windowId)
      if (!window) return prev

      return prev.map(w => {
        if (w.id === windowId) {
          return { ...w, zIndex: nextZIndex }
        }
        return w
      })
    })

    setNextZIndex(prev => prev + 1)
  }, [nextZIndex])

  const restoreWindow = useCallback((windowId) => {
    setMinimizedWindows(prev => prev.filter(id => id !== windowId))
    focusWindow(windowId)
  }, [focusWindow])

  const maximizeWindow = useCallback((windowId) => {
    setMaximizedWindows(prev => {
      if (prev.includes(windowId)) {
        // Already maximized, unmaximize (toggle)
        return prev.filter(id => id !== windowId)
      } else {
        // Maximize
        return [...prev, windowId]
      }
    })
    focusWindow(windowId)
  }, [focusWindow])

  const updateWindowPosition = useCallback((windowId, position) => {
    setWindows(prev => prev.map(w =>
      w.id === windowId ? { ...w, position } : w
    ))
  }, [])

  const updateWindowSize = useCallback((windowId, size) => {
    setWindows(prev => prev.map(w =>
      w.id === windowId ? { ...w, size } : w
    ))
  }, [])

  const clearAllWindows = useCallback(() => {
    setWindows([])
    setMinimizedWindows([])
    setFocusedWindowId(null)
    resetWindowOffset()
    if (storageKey) localStorage.removeItem(storageKey)
  }, [storageKey])

  const value = {
    windows,
    focusedWindowId,
    minimizedWindows,
    maximizedWindows,
    openWindow,
    closeWindow,
    minimizeWindow,
    maximizeWindow,
    restoreWindow,
    focusWindow,
    updateWindowPosition,
    updateWindowSize,
    clearAllWindows
  }

  return (
    <WindowContext.Provider value={value}>
      {children}
    </WindowContext.Provider>
  )
}
