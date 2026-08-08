/**
 * RouteWindow - MCP app window component
 *
 * Unified event stream architecture:
 * - All agent output (text, tool calls, UI) comes through a single events array
 * - Frontend decides what to render based on event type
 * - AppRenderer shown when a tool_result event has UI metadata
 *
 * Two paths:
 * 1. Chat flow: User → Agent → events stream → this renderer
 * 2. Direct flow: iframe click → FastAPI → MCP Server (no agent)
 */

import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { Rnd } from 'react-rnd'
import { useRouteWindows } from '../../context/RouteWindowContext'
import { useChat } from '../../context/ChatContext'
import { AppRenderer } from '@mcp-ui/client'
import { posthog } from '../../utils/posthog'
import './RouteWindow.css'

const MIN_WINDOW_SIZE = { width: 400, height: 300 }
const IFRAME_DEVICE_ALLOW = 'camera *; microphone *; usb *; serial *; bluetooth *; hid *; midi *'

export function RouteWindow({ windowRecord, isFocused, chatResetToken, defaultHideChat, onFocus, onClose, onMinimize, zIndex }) {
  const {
    sendMessage,
    updatePosition,
    updateSize,
    preloadUiHtml,
  } = useRouteWindows()
  const { sandboxReady } = useChat()

  // Unified events array
  const events = windowRecord.events || []

  // MCP-UI pattern: tool definitions and preloaded HTML
  const mcpTools = windowRecord.mcpTools || {}
  const preloadedHtml = windowRecord.preloadedHtml || {}

  // Find the latest tool_result with UI metadata to render AppRenderer
  const latestUiEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'tool_result' && event.ui?.resourceUri) {
        return event
      }
    }
    return null
  }, [events])

  // Streaming tool input: derive partial, complete, and result states from events
  const latestToolInputPartial = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'tool_input_partial' && event.partialJson) {
        try {
          const parsed = JSON.parse(event.partialJson)
          // Meta-tool wrapper: extract inner arguments
          if (parsed && typeof parsed === 'object' && 'name' in parsed && 'arguments' in parsed) {
            return { arguments: parsed.arguments }
          }
          // Direct tool call (not through meta-tool)
          return { arguments: parsed }
        } catch {
          // Partial JSON not fully parseable yet — try extracting inner arguments
          try {
            const argMatch = event.partialJson.match(/"arguments"\s*:\s*(\{[\s\S]*)/)
            if (argMatch) {
              const innerParsed = JSON.parse(argMatch[1])
              return { arguments: innerParsed }
            }
          } catch {
            // Inner JSON also incomplete — that's fine during streaming
          }
          return undefined
        }
      }
    }
    return undefined
  }, [events])

  const latestToolInput = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'tool_use' && event.isMcp && event.input) {
        // Meta-tool wrapper: extract inner arguments
        if (event.input.name && 'arguments' in event.input) {
          return { arguments: event.input.arguments || {} }
        }
        return { arguments: event.input }
      }
    }
    return undefined
  }, [events])

  const latestToolResult = useMemo(() => {
    if (!latestUiEvent || latestUiEvent.type !== 'tool_result') return undefined
    return {
      content: [{ type: 'text', text: latestUiEvent.output || '' }],
    }
  }, [latestUiEvent])

  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)
  const [chatInput, setChatInput] = useState('')
  const [isSending, setIsSending] = useState(false)

  // MCP server URL for direct tool calls from iframe
  const mcpServerUrl = windowRecord.mcpServerUrl

  // Stateless MCP RPC URL for frontend direct calls (tools/call, resources/read)
  // Uses /mcp-rpc (stateless) instead of /mcp (session-based) to avoid initialize handshake
  const mcpRpcUrl = mcpServerUrl ? mcpServerUrl.replace(/\/mcp$/, '/mcp-rpc') : null

  // MCP RPC helper for AppRenderer callbacks
  const mcpRpc = useCallback(async (method, params) => {
    if (!mcpRpcUrl) return null
    const resp = await fetch(mcpRpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
    })
    const data = await resp.json()
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    return data.result
  }, [mcpRpcUrl])

  // MCP-UI pattern: Preload UI HTML when tools are discovered
  // This enables instant rendering when the tool is called
  // Use a ref to track fetched URIs to avoid depending on preloadedHtml (prevents infinite loop)
  const fetchedUrisRef = useRef(new Set())

  useEffect(() => {
    if (!mcpServerUrl || !mcpTools || Object.keys(mcpTools).length === 0) return

    const preloadAll = async () => {
      const entries = Object.entries(mcpTools).filter(([, meta]) => {
        const resourceUri = meta?.resourceUri
        return resourceUri && !fetchedUrisRef.current.has(resourceUri)
      })

      await Promise.allSettled(
        entries.map(async ([, meta]) => {
          const resourceUri = meta.resourceUri
          fetchedUrisRef.current.add(resourceUri)  // Mark as in-flight

          try {
            const result = await mcpRpc('resources/read', { uri: resourceUri })
            const html = result?.contents?.[0]?.text
            if (html) {
              preloadUiHtml(windowRecord.id, resourceUri, html)
            }
          } catch {
            fetchedUrisRef.current.delete(resourceUri)  // Allow retry on error
          }
        })
      )
    }

    preloadAll()
  }, [mcpServerUrl, mcpTools, windowRecord.id, preloadUiHtml, mcpRpc])

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  const [showChat, setShowChat] = useState(!defaultHideChat)
  const defaultHideChatRef = useRef(defaultHideChat)

  // Hide chat when defaultHideChat flips to true (e.g. registry loads after mount)
  useEffect(() => {
    if (defaultHideChat && !defaultHideChatRef.current) {
      setShowChat(false)
    }
    defaultHideChatRef.current = defaultHideChat
  }, [defaultHideChat])

  const [refreshToken, setRefreshToken] = useState(0)

  // Resizable panel state
  const [chatWidth, setChatWidth] = useState(240)
  const [inputHeight, setInputHeight] = useState(null) // null = auto
  const chatResizeRef = useRef(null)
  const inputResizeRef = useRef(null)
  const iframeContainerRef = useRef(null)

  useEffect(() => {
    if (chatResetToken > 0) {
      setShowChat(false)
    }
  }, [chatResetToken])

  // Ensure all iframes rendered in this window can request local device permissions.
  // AppRenderer inserts its iframe asynchronously, so we observe DOM mutations.
  useEffect(() => {
    const container = iframeContainerRef.current
    if (!container) return

    const applyAllowPermissions = () => {
      const iframes = container.querySelectorAll('iframe')
      iframes.forEach((iframe) => iframe.setAttribute('allow', IFRAME_DEVICE_ALLOW))
    }

    applyAllowPermissions()

    const observer = new MutationObserver(() => {
      applyAllowPermissions()
    })
    observer.observe(container, { childList: true, subtree: true })

    return () => observer.disconnect()
  }, [])

  // Chat panel width resize handler
  const handleChatWidthResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = chatWidth

    const onMouseMove = (moveEvent) => {
      const delta = startX - moveEvent.clientX
      const newWidth = Math.max(180, Math.min(500, startWidth + delta))
      setChatWidth(newWidth)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [chatWidth])

  // Input area height resize handler
  const handleInputHeightResize = useCallback((e) => {
    e.preventDefault()
    const startY = e.clientY
    const chatEl = e.target.closest('.route-window-chat')
    const inputArea = chatEl?.querySelector('.route-window-input-area')
    const startHeight = inputArea?.offsetHeight || 100

    const onMouseMove = (moveEvent) => {
      const delta = startY - moveEvent.clientY
      const newHeight = Math.max(50, Math.min(300, startHeight + delta))
      setInputHeight(newHeight)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const handleDragStop = (e, data) => {
    const y = Math.max(0, data.y)
    updatePosition(windowRecord.id, data.x, y)
  }

  const handleResizeStop = (e, direction, ref, delta, position) => {
    updateSize(windowRecord.id, parseInt(ref.style.width), parseInt(ref.style.height))
    updatePosition(windowRecord.id, position.x, Math.max(0, position.y))
  }

  const handleSendMessage = useCallback(async (overrideMessage) => {
    const promptText = typeof overrideMessage === 'string'
      ? overrideMessage.trim()
      : chatInput.trim()
    if (!promptText || isSending || !sandboxReady || windowRecord.is_loading) return

    setIsSending(true)
    posthog.capture('prompt_submitted', {
      window_id: windowRecord.id,
      prompt_text: promptText,
      prompt_length: promptText.length,
      window_title: windowRecord.title,
      window_type: windowRecord.window_type,
    })
    try {
      await sendMessage(windowRecord.id, promptText)
      setChatInput('')
    } catch (error) {
      console.error('Failed to send message:', error)
    } finally {
      setIsSending(false)
    }
  }, [windowRecord.id, windowRecord.is_loading, chatInput, isSending, sandboxReady, sendMessage])

  const handleChipClick = useCallback((prompt) => {
    handleSendMessage(prompt)
  }, [handleSendMessage])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  // Auto-resize textarea as content changes (only when not manually resized)
  const adjustTextareaHeight = useCallback(() => {
    if (inputHeight) return // Don't auto-resize if user has manually resized
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      const newHeight = Math.min(textarea.scrollHeight, 120) // Max 120px (about 5 lines)
      textarea.style.height = `${newHeight}px`
    }
  }, [inputHeight])

  useEffect(() => {
    adjustTextareaHeight()
  }, [chatInput, adjustTextareaHeight])

  const isCommonWindow = windowRecord.window_type === 'common'
  const commonAppUrl = isCommonWindow && windowRecord.sandbox_url
    ? `/api/sandbox-proxy?url=${encodeURIComponent(windowRecord.sandbox_url)}`
    : null

  const position = windowRecord.position || { x: 100, y: 100 }
  const size = windowRecord.size || { width: 700, height: 500 }

  // Ref to the Rnd instance so we can imperatively fix position after drag
  const rndRef = useRef(null)

  const handleDrag = useCallback((e, data) => {
    // If the window tries to go above the top, force it back to y=0
    if (data.y < 0 && rndRef.current) {
      rndRef.current.updatePosition({ x: data.x, y: 0 })
    }
  }, [])

  return (
    <Rnd
      ref={rndRef}
      default={{
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      }}
      minWidth={MIN_WINDOW_SIZE.width}
      minHeight={MIN_WINDOW_SIZE.height}
      dragHandleClassName="route-window-titlebar"
      onDrag={handleDrag}
      onDragStop={handleDragStop}
      onResizeStop={handleResizeStop}
      style={{ zIndex: zIndex || (isFocused ? 1000 : 100) }}
      onMouseDown={() => onFocus?.(windowRecord.id)}
    >
      <div className={`route-window ${isFocused ? 'focused' : ''}`}>
        {/* Title bar */}
        <div className="route-window-titlebar">
          <div className="route-window-title">
            <span className="route-window-icon">{">"}_</span>
            <span className="route-window-title-text">{windowRecord.title}</span>
            <span className="route-window-id-badge" data-window-id={windowRecord.id} data-tooltip={isCommonWindow && windowRecord.port ? `${windowRecord.id} | port ${windowRecord.port}` : windowRecord.id}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </span>
          </div>
          <div className="route-window-controls">
            <button
              className="route-window-control-btn chat-toggle"
              onClick={(e) => {
                e.stopPropagation()
                setShowChat(!showChat)
              }}
              title={showChat ? 'Hide chat' : 'Show chat'}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </button>
            <button
              className="route-window-control-btn refresh"
              onClick={(e) => {
                e.stopPropagation()
                setRefreshToken(t => t + 1)
              }}
              title="Refresh"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 4v6h-6"/>
                <path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
            <button
              className="route-window-control-btn minimize"
              onClick={(e) => {
                e.stopPropagation()
                onMinimize?.(windowRecord.id)
              }}
              title="Minimize"
            >
              <svg width="10" height="10" viewBox="0 0 12 12">
                <line x1="0" y1="6" x2="12" y2="6" stroke="currentColor" strokeWidth="2"/>
              </svg>
            </button>
            <button
              className="route-window-control-btn close"
              onClick={(e) => {
                e.stopPropagation()
                onClose?.(windowRecord.id)
              }}
              title="Close"
            >
              <svg width="10" height="10" viewBox="0 0 12 12">
                <line x1="0" y1="0" x2="12" y2="12" stroke="currentColor" strokeWidth="2"/>
                <line x1="12" y1="0" x2="0" y2="12" stroke="currentColor" strokeWidth="2"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="route-window-body">
          <div className="route-window-content" ref={iframeContainerRef}>
            {/* Focus overlay: captures clicks on iframes when window is not focused */}
            {!isFocused && (
              <div
                className="route-window-focus-overlay"
                onMouseDown={() => onFocus?.(windowRecord.id)}
              />
            )}
            {/* MCP window: render AppRenderer when tool_result has UI metadata */}
            {!isCommonWindow && latestUiEvent && mcpServerUrl ? (
              <AppRenderer
                key={refreshToken}
                toolName={latestUiEvent.name}
                sandbox={{ url: new URL('/sandbox_proxy.html?contentType=rawhtml', window.location.origin) }}
                toolResourceUri={latestUiEvent.ui.resourceUri}
                html={preloadedHtml[latestUiEvent.ui.resourceUri]}
                toolInputPartial={latestToolInputPartial}
                toolInput={latestToolInput}
                toolResult={latestToolResult}
                onReadResource={async ({ uri }) => mcpRpc('resources/read', { uri })}
                onCallTool={async (params) => mcpRpc('tools/call', params)}
                onOpenLink={async ({ url }) => { window.open(url, '_blank'); return {} }}
                onLoggingMessage={(params) => {
                  fetch(`/api/route-windows/${windowRecord.id}/log`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(params),
                  }).catch(err => console.error('[RouteWindow] Failed to forward log:', err))
                }}
                onError={(err) => console.error('[RouteWindow] AppRenderer error:', err)}
              />
            ) : isCommonWindow && commonAppUrl ? (
              /* Common window: render plain iframe pointing to the app's dedicated port */
              <iframe
                key={refreshToken}
                className="route-window-iframe"
                src={commonAppUrl}
                title={windowRecord.title}
                allow={IFRAME_DEVICE_ALLOW}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            ) : (
              <div className="route-window-placeholder">
                <div className="route-window-placeholder-text">What should this app do?</div>
                <div className="route-window-chips">
                  {[
                    { icon: '📊', label: 'CSV data explorer' },
                    { icon: '📋', label: 'Task tracker' },
                    { icon: '💰', label: 'Expense report tool' },
                    { icon: '📅', label: 'Meeting notes organizer' },
                  ].map(({ icon, label }) => (
                    <button
                      key={label}
                      className="route-window-chip"
                      onClick={() => handleChipClick(`Build a ${label}`)}
                      disabled={isSending || !sandboxReady || windowRecord.is_loading}
                    >
                      <span>{icon}</span>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {windowRecord.is_loading && (
              <div className="route-window-loading-overlay">
                <div className="route-window-spinner" />
                <div className="route-window-loading-text">Building your app...</div>
              </div>
            )}
          </div>

          {/* Chat panel - unified event stream rendering */}
          {showChat && (
            <div className="route-window-chat" style={{ width: chatWidth }}>
              {/* Resize handle for chat panel width */}
              <div
                className="route-window-resize-handle-vertical"
                onMouseDown={handleChatWidthResize}
                ref={chatResizeRef}
              />
              <div className="route-window-messages">
                {/* Render all events in order - frontend decides what to show */}
                {events.map((event, i) => {
                  // Only render events that have visual representation
                  const hasContent = ['user_message', 'text', 'tool_use', 'tool_end', 'tool_result', 'status'].includes(event.type)
                  if (!hasContent) return null

                  // Skip empty text events (from early streaming deltas)
                  if (event.type === 'text' && !event.content?.trim()) return null

                  return (
                    <div key={i} className={`route-window-event ${event.type}`}>
                      {/* User message */}
                      {event.type === 'user_message' && (
                        <div className="route-window-message user">
                          <div className="route-window-message-content">{event.content}</div>
                        </div>
                      )}

                      {/* Agent text response */}
                      {event.type === 'text' && (
                        <div className="route-window-message assistant">
                          <div className="route-window-message-content">
                            {event.content}
                          </div>
                        </div>
                      )}

                      {/* Tool being called */}
                      {event.type === 'tool_use' && (
                        <div className="route-window-event-tool">
                          <span className="route-window-tool-icon">🔧</span>
                          <span className="route-window-tool-name">{event.name}</span>
                        </div>
                      )}

                      {/* Tool completed */}
                      {event.type === 'tool_end' && (
                        <div className="route-window-event-tool">
                          <span className="route-window-tool-icon">✅</span>
                          <span className="route-window-tool-name">Tool call complete</span>
                        </div>
                      )}

                      {/* Tool result - show differently if it has UI */}
                      {event.type === 'tool_result' && (
                        <div className="route-window-event-result">
                          <span className="route-window-result-icon">{event.ui ? '🖼️' : '✓'}</span>
                          <span className="route-window-result-text">
                            {event.ui
                              ? `App ready: ${event.name}`
                              : typeof event.output === 'string'
                                ? event.output.slice(0, 100) + (event.output.length > 100 ? '...' : '')
                                : 'Done'}
                          </span>
                        </div>
                      )}

                      {/* Status message */}
                      {event.type === 'status' && (
                        <div className="route-window-event-status">{event.message}</div>
                      )}
                    </div>
                  )
                })}

                {/* Loading indicator when no events yet */}
                {windowRecord.is_loading && events.length === 0 && (
                  <div className="route-window-message assistant">
                    <div className="route-window-message-content">
                      <span className="route-window-typing">Building...</span>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Resize handle for input area height */}
              <div
                className="route-window-resize-handle-horizontal"
                onMouseDown={handleInputHeightResize}
                ref={inputResizeRef}
              />

              {/* Input area */}
              <div className="route-window-input-area" style={inputHeight ? { height: inputHeight, minHeight: inputHeight } : {}}>
                <textarea
                  ref={textareaRef}
                  className="route-window-input"
                  placeholder={sandboxReady ? 'Describe what to build...' : 'Setting up your virtual computer...'}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isSending || !sandboxReady || windowRecord.is_loading}
                  rows={1}
                />
                <button
                  className="route-window-send-btn"
                  onClick={handleSendMessage}
                  disabled={!chatInput.trim() || isSending || !sandboxReady || windowRecord.is_loading}
                >
                  {isSending ? '...' : 'Send'}
                </button>
              </div>
            </div>
          )}
        </div>

      </div>
    </Rnd>
  )
}

export default RouteWindow
