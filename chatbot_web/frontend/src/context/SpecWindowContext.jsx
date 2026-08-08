/**
 * SpecWindowContext - State management for spec-based windows
 *
 * Manages the lifecycle of WindowRecords and provides:
 * - WebSocket connection for real-time updates
 * - CRUD operations for windows
 * - Action execution
 */

import { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react'
import { useAuth } from './AuthContext'
import { io } from 'socket.io-client'

const SpecWindowContext = createContext(null)

// Initial state
const initialState = {
  windows: {},        // Map of windowId -> WindowRecord
  loading: true,
  connected: false,
  error: null,
}

// Reducer for state updates
function reducer(state, action) {
  switch (action.type) {
    case 'SET_CONNECTED':
      return { ...state, connected: action.connected }

    case 'SET_LOADING':
      return { ...state, loading: action.loading }

    case 'SET_ERROR':
      return { ...state, error: action.error }

    case 'SET_SNAPSHOT':
      return {
        ...state,
        windows: Object.fromEntries(
          action.windows.map(w => [w.id, w])
        ),
        loading: false,
      }

    case 'WINDOW_CREATED':
    case 'WINDOW_UPDATED':
      return {
        ...state,
        windows: {
          ...state.windows,
          [action.window.id]: action.window,
        },
      }

    case 'WINDOW_DELETED': {
      const remaining = { ...state.windows }
      delete remaining[action.windowId]
      return { ...state, windows: remaining }
    }

    case 'UPDATE_LOCAL_STATE': {
      const window = state.windows[action.windowId]
      if (!window) return state
      return {
        ...state,
        windows: {
          ...state.windows,
          [action.windowId]: {
            ...window,
            state: {
              ...window.state,
              data: {
                ...window.state.data,
                [action.key]: action.value,
              },
            },
          },
        },
      }
    }

    default:
      return state
  }
}

export function SpecWindowProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const socketRef = useRef(null)
  const { user } = useAuth()

  // Initialize WebSocket connection
  useEffect(() => {
    // Don't connect until user is authenticated
    if (!user) {
      dispatch({ type: 'SET_LOADING', loading: false })
      return
    }

    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      path: '/socket.io',
    })

    socketRef.current = socket

    socket.on('connect', () => {
      dispatch({ type: 'SET_CONNECTED', connected: true })
    })

    socket.on('disconnect', () => {
      console.log('SpecWindow socket disconnected')
      dispatch({ type: 'SET_CONNECTED', connected: false })
    })

    socket.on('snapshot', (windows) => {
      console.log('Received snapshot:', windows.length, 'windows')
      dispatch({ type: 'SET_SNAPSHOT', windows })
    })

    socket.on('window_created', (window) => {
      console.log('Window created:', window.id)
      dispatch({ type: 'WINDOW_CREATED', window })
    })

    socket.on('window_updated', (window) => {
      console.log('Window updated:', window.id)
      dispatch({ type: 'WINDOW_UPDATED', window })
    })

    socket.on('window_deleted', ({ windowId }) => {
      console.log('Window deleted:', windowId)
      dispatch({ type: 'WINDOW_DELETED', windowId })
    })

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err)
      dispatch({ type: 'SET_ERROR', error: 'Connection failed' })
    })

    // Set loading to false after a timeout if no snapshot received
    const timeout = setTimeout(() => {
      dispatch({ type: 'SET_LOADING', loading: false })
    }, 3000)

    return () => {
      clearTimeout(timeout)
      socket.close()
      socketRef.current = null
    }
  }, [user])

  // Create a new window from prompt
  const createWindow = useCallback(async (prompt, options = {}) => {
    try {
      const response = await fetch('/api/windows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          prompt,
          useAI: options.useAI !== false,
          position: options.position,
          size: options.size,
          initialState: options.initialState,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create window')
      }

      const window = await response.json()
      // Socket will broadcast the update, but we can return it immediately
      return window
    } catch (error) {
      console.error('Create window failed:', error)
      throw error
    }
  }, [])

  // Execute an action on a window
  const executeAction = useCallback(async (windowId, actionId, payload = {}) => {
    try {
      const response = await fetch(`/api/windows/${windowId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ actionId, payload }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Action failed')
      }

      return await response.json()
    } catch (error) {
      console.error('Execute action failed:', error)
      throw error
    }
  }, [])

  // Update window state locally (for real-time input binding)
  const updateLocalState = useCallback((windowId, key, value) => {
    dispatch({ type: 'UPDATE_LOCAL_STATE', windowId, key, value })

    // Also sync to server (debounced would be better for production)
    fetch(`/api/windows/${windowId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ key, value }),
    }).catch(err => console.error('State sync failed:', err))
  }, [])

  // Delete a window
  const deleteWindow = useCallback(async (windowId) => {
    try {
      const response = await fetch(`/api/windows/${windowId}`, {
        method: 'DELETE',
        credentials: 'include',
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Delete failed')
      }

      return true
    } catch (error) {
      console.error('Delete window failed:', error)
      throw error
    }
  }, [])

  // Update window position
  const updatePosition = useCallback(async (windowId, x, y) => {
    try {
      await fetch(`/api/windows/${windowId}/position`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ x, y }),
      })
    } catch (error) {
      console.error('Position update failed:', error)
    }
  }, [])

  // Update window size
  const updateSize = useCallback(async (windowId, width, height) => {
    try {
      await fetch(`/api/windows/${windowId}/size`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ width, height }),
      })
    } catch (error) {
      console.error('Size update failed:', error)
    }
  }, [])

  const value = {
    windows: Object.values(state.windows),
    windowsById: state.windows,
    loading: state.loading,
    connected: state.connected,
    error: state.error,
    createWindow,
    executeAction,
    updateLocalState,
    deleteWindow,
    updatePosition,
    updateSize,
  }

  return (
    <SpecWindowContext.Provider value={value}>
      {children}
    </SpecWindowContext.Provider>
  )
}

export function useSpecWindows() {
  const context = useContext(SpecWindowContext)
  if (!context) {
    throw new Error('useSpecWindows must be used within SpecWindowProvider')
  }
  return context
}
