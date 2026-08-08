import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './Terminal.css'

const Terminal = ({ sandboxId }) => {
  const containerRef = useRef(null)
  const terminalRef = useRef(null)
  const fitAddonRef = useRef(null)
  const wsRef = useRef(null)
  const isInitializedRef = useRef(false)
  const sandboxIdRef = useRef(sandboxId)
  const [status, setStatus] = useState('connecting')

  // Keep sandboxId ref updated
  sandboxIdRef.current = sandboxId

  // Handle WebSocket connection
  const connectWebSocket = useCallback(() => {
    // Prevent multiple simultaneous connections
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING) {
      return
    }

    // Build WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    let url = `${protocol}//${host}/api/terminal/ws`
    if (sandboxIdRef.current) {
      url += `?sandbox_id=${encodeURIComponent(sandboxIdRef.current)}`
    }

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('Terminal WebSocket connected')
      setStatus('connected')
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)

        switch (message.type) {
          case 'ready':
            setStatus('ready')
            // Auto-focus with a slight delay to ensure DOM is ready
            setTimeout(() => {
              if (terminalRef.current) {
                terminalRef.current.focus()
              }
            }, 100)
            break

          case 'output':
            if (terminalRef.current && message.data) {
              terminalRef.current.write(message.data)
            }
            break

          case 'error':
            setStatus('error')
            if (terminalRef.current) {
              terminalRef.current.write(`\r\n\x1b[31mError: ${message.message}\x1b[0m\r\n`)
            }
            break

          case 'pong':
            // Keepalive response, ignore
            break

          default:
            console.log('Unknown terminal message:', message)
        }
      } catch (e) {
        console.error('Failed to parse terminal message:', e)
      }
    }

    ws.onerror = (error) => {
      console.error('Terminal WebSocket error:', error)
      setStatus('error')
    }

    ws.onclose = () => {
      console.log('Terminal WebSocket closed')
      setStatus('disconnected')
      wsRef.current = null
    }
  }, []) // No dependencies - uses refs instead

  // Send input to terminal
  const sendInput = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'input',
        data: data
      }))
    }
  }, [])

  // Send resize to terminal
  const sendResize = useCallback((cols, rows) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'resize',
        cols: cols,
        rows: rows
      }))
    }
  }, [])

  // Initialize terminal - runs once on mount
  useEffect(() => {
    // Prevent double initialization in React Strict Mode
    if (isInitializedRef.current || !containerRef.current) return
    isInitializedRef.current = true

    // Create terminal instance
    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: '#45475a',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
      allowTransparency: true,
      scrollback: 10000,
    })

    // Create fit addon
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    // Open terminal in container
    terminal.open(containerRef.current)

    // Fit terminal to container
    setTimeout(() => {
      fitAddon.fit()
    }, 0)

    // Store refs
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Handle user input
    terminal.onData((data) => {
      sendInput(data)
    })

    // Connect WebSocket
    connectWebSocket()

    // Handle resize
    const handleResize = () => {
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit()
        sendResize(terminalRef.current.cols, terminalRef.current.rows)
      }
    }

    // Use ResizeObserver for container resize
    const resizeObserver = new ResizeObserver(() => {
      handleResize()
    })
    resizeObserver.observe(containerRef.current)

    // Also handle window resize
    window.addEventListener('resize', handleResize)

    // Cleanup
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)

      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }

      if (terminalRef.current) {
        terminalRef.current.dispose()
        terminalRef.current = null
      }

      isInitializedRef.current = false
    }
  }, []) // Empty deps - initialization runs once, uses refs for current values

  // Reconnect button handler
  const handleReconnect = () => {
    setStatus('connecting')
    if (terminalRef.current) {
      terminalRef.current.clear()
    }
    connectWebSocket()
  }

  return (
    <div className="terminal-wrapper">
      {status === 'connecting' && (
        <div className="terminal-status">Connecting to sandbox...</div>
      )}
      {status === 'error' && (
        <div className="terminal-status error">
          Connection failed.{' '}
          <button onClick={handleReconnect}>Reconnect</button>
        </div>
      )}
      {status === 'disconnected' && (
        <div className="terminal-status">
          Disconnected.{' '}
          <button onClick={handleReconnect}>Reconnect</button>
        </div>
      )}
      <div
        ref={containerRef}
        className="terminal-container"
        tabIndex={0}
        onClick={() => {
          if (terminalRef.current) {
            terminalRef.current.focus()
          }
        }}
        onFocus={() => {
          if (terminalRef.current) {
            terminalRef.current.focus()
          }
        }}
      />
    </div>
  )
}

export default Terminal
