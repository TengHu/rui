/**
 * RouteWindowContext - State management for RouteWindow MCP apps
 *
 * Each RouteWindow hosts an MCP app rendered via AppRenderer.
 * The agent creates apps, registers them with the shared MCP server (port 3000),
 * and the frontend renders them using @mcp-ui/client.
 *
 * Provides:
 * - WebSocket connection for real-time window state updates
 * - SSE subscription for streaming agent events to chat panel
 * - CRUD operations for windows
 * - Chat functionality to trigger agent builds
 */

import { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react'
import { useChat } from './ChatContext'
import { useAuth } from './AuthContext'
import { io } from 'socket.io-client'
import { getWindowSessionId, setWindowSessionId, clearWindowSessionId } from '../utils/windowSessionStorage'

const RouteWindowContext = createContext(null)

// Initial state
const initialState = {
  windows: {},        // Map of windowId -> RouteWindowRecord (includes events array)
  fileChangeTimestamp: null,  // Timestamp of last file change (triggers iframe reload)
  loading: true,
  connected: false,
  error: null,
}

// Reducer for state updates
// Unified event stream: all agent output goes through ADD_EVENT
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
        windows: Object.fromEntries(action.windows.map(w => {
          const existingWindow = state.windows[w.id]
          return [w.id, {
            ...existingWindow,
            ...w,
            // Frontend is source of truth for events - never overwrite from server
            events: existingWindow?.events || [],
            // Preserve sandbox_url from frontend if server doesn't have it
            sandbox_url: w.sandbox_url || existingWindow?.sandbox_url || null,
            // MCP server URL still needed for direct tool calls from iframe
            mcpServerUrl: w.mcpServerUrl || w.mcp_server_url || existingWindow?.mcpServerUrl || null,
          }]
        })),
        loading: false,
      }

    case 'ROUTE_WINDOW_CREATED': {
      const w = action.window
      const existingWindow = state.windows[w.id]
      return {
        ...state,
        windows: {
          ...state.windows,
          [w.id]: {
            ...existingWindow,
            ...w,
            events: existingWindow?.events || [],
            sandbox_url: w.sandbox_url || existingWindow?.sandbox_url || null,
            mcpServerUrl: w.mcpServerUrl || w.mcp_server_url || existingWindow?.mcpServerUrl || null,
          },
        },
      }
    }

    case 'ROUTE_WINDOW_UPDATED': {
      const w = action.window
      const existingWindow = state.windows[w.id]
      return {
        ...state,
        windows: {
          ...state.windows,
          [w.id]: {
            ...existingWindow,
            ...w,
            events: existingWindow?.events || [],
            sandbox_url: w.sandbox_url || existingWindow?.sandbox_url || null,
            mcpServerUrl: w.mcpServerUrl || w.mcp_server_url || existingWindow?.mcpServerUrl || null,
          },
        },
      }
    }

    case 'ROUTE_WINDOW_DELETED': {
      const remaining = { ...state.windows }
      delete remaining[action.windowId]
      return { ...state, windows: remaining }
    }

    case 'SET_WINDOW_LOADING': {
      const win = state.windows[action.windowId]
      if (!win) return state
      return {
        ...state,
        windows: {
          ...state.windows,
          [action.windowId]: { ...win, is_loading: action.loading },
        },
      }
    }

    case 'SET_SANDBOX_URL': {
      const window = state.windows[action.windowId]
      if (!window) return state
      return {
        ...state,
        windows: {
          ...state.windows,
          [action.windowId]: {
            ...window,
            sandbox_url: action.sandboxUrl,
            sandbox_id: action.sandboxId,
          },
        },
      }
    }

    // Unified event stream: single action for all agent output
    case 'ADD_EVENT': {
      const w = state.windows[action.windowId]
      if (!w) return state

      const events = w.events || []
      const newEvent = { ...action.event, timestamp: Date.now() }

      // For text_delta, accumulate into the last text event if exists
      if (newEvent.type === 'text' && newEvent.streaming) {
        const lastEvent = events[events.length - 1]
        if (lastEvent?.type === 'text' && lastEvent.streaming) {
          return {
            ...state,
            windows: {
              ...state.windows,
              [action.windowId]: {
                ...w,
                events: [
                  ...events.slice(0, -1),
                  { ...lastEvent, content: (lastEvent.content || '') + (newEvent.content || '') },
                ],
              },
            },
          }
        }
      }

      return {
        ...state,
        windows: {
          ...state.windows,
          [action.windowId]: {
            ...w,
            events: [...events, newEvent],
            // If this is a tool_result with UI, also set mcpServerUrl for direct calls
            ...(newEvent.type === 'tool_result' && newEvent.ui ? {
              mcpServerUrl: newEvent.mcpServerUrl || w.mcpServerUrl,
            } : {}),
          },
        },
      }
    }

    // Finalize streaming text (convert streaming: true to streaming: false)
    case 'FINALIZE_STREAMING_TEXT': {
      const w = state.windows[action.windowId]
      if (!w) return state
      const events = w.events || []
      // Find ALL streaming text events and finalize them (not just the last one)
      const hasStreamingText = events.some(e => e.type === 'text' && e.streaming)
      if (hasStreamingText) {
        return {
          ...state,
          windows: {
            ...state.windows,
            [action.windowId]: {
              ...w,
              events: events.map(e =>
                e.type === 'text' && e.streaming
                  ? { ...e, streaming: false }
                  : e
              ),
            },
          },
        }
      }
      return state
    }

    case 'CLEAR_EVENTS': {
      const w = state.windows[action.windowId]
      if (!w) return state
      return {
        ...state,
        windows: {
          ...state.windows,
          [action.windowId]: { ...w, events: [] },
        },
      }
    }

    case 'FILE_CHANGED':
      return { ...state, fileChangeTimestamp: action.timestamp }

    case 'SET_MCP_SERVER_URL': {
      const mcpWin = state.windows[action.windowId]
      if (!mcpWin) return state
      return {
        ...state,
        windows: {
          ...state.windows,
          [action.windowId]: { ...mcpWin, mcpServerUrl: action.mcpServerUrl },
        },
      }
    }

    // MCP-UI pattern: store tool definitions for UI preloading
    case 'SET_MCP_TOOLS': {
      const w = state.windows[action.windowId]
      if (!w) return state
      return {
        ...state,
        windows: {
          ...state.windows,
          [action.windowId]: {
            ...w,
            mcpTools: action.tools,  // { toolName: { resourceUri, inputSchema } }
          },
        },
      }
    }

    // MCP-UI pattern: cache preloaded UI HTML for instant rendering
    case 'SET_PRELOADED_HTML': {
      const w = state.windows[action.windowId]
      if (!w) return state
      return {
        ...state,
        windows: {
          ...state.windows,
          [action.windowId]: {
            ...w,
            preloadedHtml: {
              ...(w.preloadedHtml || {}),
              [action.resourceUri]: action.html,
            },
          },
        },
      }
    }

    default:
      return state
  }
}

export function RouteWindowProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const socketRef = useRef(null)
  const eventSourcesRef = useRef({}) // windowId -> EventSource
  const { sandboxId, sandboxReady } = useChat()
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

      // Fetch initial state
      fetch('/api/route-windows', { credentials: 'include' })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        })
        .then(windows => {
          dispatch({ type: 'SET_SNAPSHOT', windows })
        })
        .catch(() => {
          dispatch({ type: 'SET_LOADING', loading: false })
        })
    })

    socket.on('disconnect', () => {
      console.log('RouteWindow socket disconnected')
      dispatch({ type: 'SET_CONNECTED', connected: false })
    })

    socket.on('route_window_created', (window) => {
      console.log('Route window created:', window.id)
      dispatch({ type: 'ROUTE_WINDOW_CREATED', window })
    })

    socket.on('route_window_updated', (window) => {
      console.log('Route window updated:', window.id)
      dispatch({ type: 'ROUTE_WINDOW_UPDATED', window })
    })

    socket.on('route_window_deleted', (window) => {
      console.log('Route window deleted:', window.id)
      dispatch({ type: 'ROUTE_WINDOW_DELETED', windowId: window.id })
    })

    // Listen for file changes to trigger iframe reloads
    socket.on('file_changed', (data) => {
      console.log('File changed:', data.path, data.change_type)
      dispatch({ type: 'FILE_CHANGED', timestamp: data.timestamp })
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
      // Close all SSE connections
      Object.values(eventSourcesRef.current).forEach(es => es.close())
    }
  }, [user])

  // Subscribe to SSE events for a window (for streaming during chat)
  // Unified event stream: all events go through ADD_EVENT
  const subscribeToWindowEvents = useCallback((windowId) => {
    // Close existing connection if any
    if (eventSourcesRef.current[windowId]) {
      eventSourcesRef.current[windowId].close()
    }

    const eventSource = new EventSource(`/api/route-windows/${windowId}/events`)
    eventSourcesRef.current[windowId] = eventSource

    eventSource.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data)

        // Unified event handling - frontend decides what to render based on type
        switch (data.type) {
          case 'text_delta':
            // Streaming text - accumulates into single text event
            dispatch({
              type: 'ADD_EVENT',
              windowId,
              event: { type: 'text', content: data.data?.text || '', streaming: true },
            })
            break

          case 'tool_use':
            // Tool being called
            dispatch({
              type: 'ADD_EVENT',
              windowId,
              event: { type: 'tool_use', name: data.data?.name, input: data.data?.input },
            })
            break

          case 'tool_result':
            // Tool result - may include UI metadata for rendering AppRenderer
            dispatch({
              type: 'ADD_EVENT',
              windowId,
              event: {
                type: 'tool_result',
                name: data.data?.name,
                output: data.data?.output,
                // UI metadata - if present, frontend will render AppRenderer
                ui: data.data?.ui || null,
                mcpServerUrl: data.data?.mcpServerUrl || null,
              },
            })
            break

          case 'status':
            dispatch({
              type: 'ADD_EVENT',
              windowId,
              event: { type: 'status', message: data.data?.message },
            })
            break

          case 'mcp_tools_discovered':
            // MCP server emits this on POST /register — enables preloading before tool_result
            if (data.data?.tools) {
              dispatch({ type: 'SET_MCP_TOOLS', windowId, tools: data.data.tools })
            }
            if (data.data?.mcpServerUrl) {
              dispatch({ type: 'SET_MCP_SERVER_URL', windowId, mcpServerUrl: data.data.mcpServerUrl })
            }
            break

          case 'mcp_tool_start':
            // MCP server emits this when a tool handler begins
            dispatch({
              type: 'ADD_EVENT',
              windowId,
              event: {
                type: 'tool_use',
                name: data.data?.name,
                input: data.data?.input,
                isMcp: true,
              },
            })
            break

          case 'tool_start':
            // Agent tool invocation (from sandbox event file)
            dispatch({
              type: 'ADD_EVENT',
              windowId,
              event: {
                type: 'tool_use',
                name: data.data?.tool,
                input: data.data?.input,
                toolId: data.data?.id,
              },
            })
            break

          case 'tool_end':
            // Agent tool completed (from sandbox event file)
            dispatch({
              type: 'ADD_EVENT',
              windowId,
              event: {
                type: 'tool_end',
                toolId: data.data?.id,
                error: data.data?.error || null,
              },
            })
            break

          case 'tool_input_partial':
            // Streaming tool input (partial JSON chunks)
            dispatch({
              type: 'ADD_EVENT',
              windowId,
              event: {
                type: 'tool_input_partial',
                toolName: data.data?.tool_name,
                toolUseId: data.data?.tool_use_id,
                partialJson: data.data?.partial_json,
              },
            })
            break

          case 'agent_end':
            // Finalize any streaming text
            dispatch({ type: 'FINALIZE_STREAMING_TEXT', windowId })
            dispatch({ type: 'SET_WINDOW_LOADING', windowId, loading: false })
            break

          default:
            // Pass through unknown events
            dispatch({ type: 'ADD_EVENT', windowId, event: data })
        }
      } catch (err) {
        console.error('Error processing SSE event:', err)
      }
    }

    eventSource.onerror = (err) => {
      console.error('SSE error for window', windowId, err)
    }

    return eventSource
  }, [])

  // Unsubscribe from SSE events
  const unsubscribeFromWindowEvents = useCallback((windowId) => {
    if (eventSourcesRef.current[windowId]) {
      eventSourcesRef.current[windowId].close()
      delete eventSourcesRef.current[windowId]
    }
  }, [])

  // Create a new route window
  const createWindow = useCallback(async (title = 'New Window', options = {}) => {
    try {
      const body = {
        title,
        window_type: options.windowType || 'mcp',
        additional_prompt: options.additionalPrompt,
        position: options.position,
        size: options.size,
      }
      if (options.port != null) {
        body.port = options.port
      }
      const response = await fetch('/api/route-windows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create window')
      }

      const window = await response.json()
      // Optimistically add to state immediately (don't wait for Socket.IO)
      // The Socket.IO event will be a no-op since the window already exists
      dispatch({ type: 'ROUTE_WINDOW_CREATED', window })
      return window
    } catch (error) {
      console.error('Create route window failed:', error)
      throw error
    }
  }, [])

  // Send a chat message to a window's agent
  // Unified event stream: all output (text, tool calls, UI) comes through SSE as events
  const sendMessage = useCallback(async (windowId, message) => {
    try {
      if (!sandboxReady || !sandboxId) {
        throw new Error('Sandbox is not ready yet')
      }

      // Add user message as an event
      dispatch({
        type: 'ADD_EVENT',
        windowId,
        event: { type: 'user_message', content: message },
      })
      dispatch({ type: 'SET_WINDOW_LOADING', windowId, loading: true })

      // Subscribe to SSE for streaming events BEFORE making the chat request
      subscribeToWindowEvents(windowId)

      // Get session_id from sessionStorage for conversation continuity
      const sessionId = getWindowSessionId(windowId)

      const response = await fetch(`/api/route-windows/${windowId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message,
          sandbox_id: sandboxId,
          session_id: sessionId,
        }),
      })

      const data = await response.json()

      // Unsubscribe from SSE after chat completes
      unsubscribeFromWindowEvents(windowId)

      // Save new session_id for conversation continuity
      if (data.session_id) {
        setWindowSessionId(windowId, data.session_id)
      }

      // Update sandbox URL if provided
      if (data.sandbox_url) {
        dispatch({
          type: 'SET_SANDBOX_URL',
          windowId,
          sandboxUrl: data.sandbox_url,
          sandboxId: data.sandbox_id,
        })
      }

      // Store MCP server URL for direct tool calls from iframe
      if (data.mcp_server_url) {
        dispatch({
          type: 'SET_MCP_SERVER_URL',
          windowId,
          mcpServerUrl: data.mcp_server_url,
        })
      }

      // Store MCP tool definitions for UI preloading (mcp-ui pattern)
      if (data.mcp_tools) {
        dispatch({
          type: 'SET_MCP_TOOLS',
          windowId,
          tools: data.mcp_tools,
        })
      }

      dispatch({ type: 'SET_WINDOW_LOADING', windowId, loading: false })

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send message')
      }

      return data
    } catch (error) {
      console.error('Send message failed:', error)
      unsubscribeFromWindowEvents(windowId)
      dispatch({ type: 'SET_WINDOW_LOADING', windowId, loading: false })
      throw error
    }
  }, [sandboxId, sandboxReady, subscribeToWindowEvents, unsubscribeFromWindowEvents])

  // Delete a window
  const deleteWindow = useCallback(async (windowId) => {
    console.log('Deleting route window:', windowId)
    try {
      // Clean up SSE connection first
      unsubscribeFromWindowEvents(windowId)

      // Clear session_id from sessionStorage
      clearWindowSessionId(windowId)

      // Optimistically remove from local state
      dispatch({ type: 'ROUTE_WINDOW_DELETED', windowId })

      // Call backend to delete
      const response = await fetch(`/api/route-windows/${windowId}`, {
        method: 'DELETE',
        credentials: 'include',
      })

      if (!response.ok) {
        const error = await response.json()
        console.error('Delete route window failed:', error)
        throw new Error(error.error || 'Delete failed')
      }

      console.log('Route window deleted successfully:', windowId)
      return true
    } catch (error) {
      console.error('Delete route window failed:', error)
      // Re-fetch windows on error to sync state
      try {
        const response = await fetch('/api/route-windows', { credentials: 'include' })
        const windows = await response.json()
        dispatch({ type: 'SET_SNAPSHOT', windows })
      } catch (e) {
        console.error('Failed to re-sync windows:', e)
      }
      throw error
    }
  }, [unsubscribeFromWindowEvents])

  // Update window position
  const updatePosition = useCallback(async (windowId, x, y) => {
    try {
      await fetch(`/api/route-windows/${windowId}/position`, {
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
      await fetch(`/api/route-windows/${windowId}/size`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ width, height }),
      })
    } catch (error) {
      console.error('Size update failed:', error)
    }
  }, [])

  // Refresh a window's sandbox URL
  const refreshSandboxUrl = useCallback(async (windowId) => {
    try {
      const response = await fetch(`/api/route-windows/${windowId}/sandbox-url`, { credentials: 'include' })
      const data = await response.json()

      if (data.url) {
        dispatch({
          type: 'SET_SANDBOX_URL',
          windowId,
          sandboxUrl: data.url,
          sandboxId: data.sandbox_id,
        })
      }

      return data
    } catch (error) {
      console.error('Failed to refresh sandbox URL:', error)
      throw error
    }
  }, [])

  // Preload UI HTML for instant rendering (mcp-ui pattern)
  const preloadUiHtml = useCallback((windowId, resourceUri, html) => {
    dispatch({
      type: 'SET_PRELOADED_HTML',
      windowId,
      resourceUri,
      html,
    })
  }, [])

  // Ensure a common app is running: check port, start from registry if needed
  const ensureApp = useCallback(async (windowId) => {
    if (!sandboxReady || !sandboxId) return null

    try {
      const response = await fetch(`/api/route-windows/${windowId}/ensure-app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sandbox_id: sandboxId }),
      })

      if (!response.ok) return null

      const data = await response.json()

      if (data.started && data.sandbox_url) {
        dispatch({
          type: 'SET_SANDBOX_URL',
          windowId,
          sandboxUrl: data.sandbox_url,
          sandboxId: data.sandbox_id,
        })
      }

      return data
    } catch (error) {
      console.error('ensureApp failed:', error)
      return null
    }
  }, [sandboxId, sandboxReady])

  const value = {
    windows: Object.values(state.windows),
    windowsById: state.windows,
    fileChangeTimestamp: state.fileChangeTimestamp,
    loading: state.loading,
    connected: state.connected,
    error: state.error,
    createWindow,
    sendMessage,
    deleteWindow,
    updatePosition,
    updateSize,
    refreshSandboxUrl,
    preloadUiHtml,  // For UI preloading (mcp-ui pattern)
    ensureApp,      // Auto-start common apps from registry
  }

  return (
    <RouteWindowContext.Provider value={value}>
      {children}
    </RouteWindowContext.Provider>
  )
}

export function useRouteWindows() {
  const context = useContext(RouteWindowContext)
  if (!context) {
    throw new Error('useRouteWindows must be used within RouteWindowProvider')
  }
  return context
}
