import { useState, useCallback, useRef, useEffect } from 'react'
import { Rnd } from 'react-rnd'
import { useWindows } from '../../context/WindowContext'
import { useChat } from '../../context/ChatContext'
import { useAuth } from '../../context/AuthContext'
import { useStickyNotes } from '../../context/StickyNotesContext'
import { useSpecWindows } from '../../context/SpecWindowContext'
import { useRouteWindows } from '../../context/RouteWindowContext'
import { useContextMenu } from '../ContextMenu'
import Window from '../Window/Window'
import SpecWindow from '../SpecWindow/SpecWindow'
import RouteWindow from '../RouteWindow/RouteWindow'
import Taskbar from '../Taskbar/Taskbar'
import Dock from '../Dock/Dock'
import StickyNote from '../StickyNote/StickyNote'
import LoadingScreen from '../LoadingScreen/LoadingScreen'
import LandingPage from '../LandingPage/LandingPage'
import DesktopIcons from '../DesktopIcons/DesktopIcons'
import OnboardingOverlay from '../OnboardingOverlay/OnboardingOverlay'
import { WINDOW_ICONS, MIN_WINDOW_SIZE } from '../../utils/windowTypes'
import { useClipboard } from '../../hooks/useClipboard'
import { useAppRegistry } from '../../hooks/useAppRegistry'
import './Desktop.css'

// SpecWindowWrapper - renders a spec-based window with drag/resize
function SpecWindowWrapper({ windowRecord, onAction, onStateChange, onClose, zIndex, onFocus }) {
  const [position, setPosition] = useState(
    windowRecord.position || { x: 100, y: 100 }
  )
  const [size, setSize] = useState(
    windowRecord.size || { width: 400, height: 350 }
  )

  const { updatePosition, updateSize } = useSpecWindows()
  const specRndRef = useRef(null)

  const handleDrag = (e, data) => {
    if (data.y < 0 && specRndRef.current) {
      specRndRef.current.updatePosition({ x: data.x, y: 0 })
    }
  }

  const handleDragStop = (e, data) => {
    const y = Math.max(0, data.y)
    setPosition({ x: data.x, y })
    updatePosition(windowRecord.id, data.x, y)
  }

  const handleResizeStop = (e, direction, ref, delta, pos) => {
    const newSize = {
      width: parseInt(ref.style.width),
      height: parseInt(ref.style.height),
    }
    setSize(newSize)
    setPosition({ x: pos.x, y: Math.max(0, pos.y) })
    updateSize(windowRecord.id, newSize.width, newSize.height)
    updatePosition(windowRecord.id, pos.x, Math.max(0, pos.y))
  }

  const handleMouseDown = () => {
    onFocus?.(windowRecord.id)
  }

  return (
    <Rnd
      ref={specRndRef}
      default={{
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      }}
      minWidth={MIN_WINDOW_SIZE.width}
      minHeight={MIN_WINDOW_SIZE.height}
      dragHandleClassName="spec-window-titlebar"
      onDrag={handleDrag}
      onDragStop={handleDragStop}
      onResizeStop={handleResizeStop}
      style={{ zIndex: zIndex || 200 }}
      onMouseDown={handleMouseDown}
    >
      <div className="spec-window-shell">
        <div className="spec-window-titlebar">
          <div className="spec-window-title">
            <span className="spec-window-icon">
              {WINDOW_ICONS.SPEC || '🪟'}
            </span>
            <span className="spec-window-title-text">
              {windowRecord.title || 'Window'}
            </span>
          </div>
          <div className="spec-window-controls">
            <button
              className="spec-window-control-btn close"
              onClick={() => onClose(windowRecord.id)}
              title="Close"
            >
              <svg width="12" height="12" viewBox="0 0 12 12">
                <line x1="0" y1="0" x2="12" y2="12" stroke="currentColor" strokeWidth="2"/>
                <line x1="12" y1="0" x2="0" y2="12" stroke="currentColor" strokeWidth="2"/>
              </svg>
            </button>
          </div>
        </div>
        <div className="spec-window-body">
          <SpecWindow
            windowRecord={windowRecord}
            onAction={onAction}
            onStateChange={onStateChange}
          />
        </div>
      </div>
    </Rnd>
  )
}

const ZOOM_MIN = 0.5
const ZOOM_MAX = 2
const ZOOM_STEP = 0.1

// Format time remaining as MM:SS or HH:MM:SS
const formatTimeRemaining = (ms) => {
  if (ms <= 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

// Sandbox Timer Component - uses actual end time from E2B API
const SandboxTimer = ({ endAt }) => {
  const [timeRemaining, setTimeRemaining] = useState(0)

  useEffect(() => {
    if (!endAt) return

    const endTime = new Date(endAt).getTime()

    const updateTimer = () => {
      const remaining = Math.max(0, endTime - Date.now())
      setTimeRemaining(remaining)
    }

    updateTimer()
    const interval = setInterval(updateTimer, 1000)

    return () => clearInterval(interval)
  }, [endAt])

  // Don't render until we have a valid end time
  if (!endAt || timeRemaining === 0) return null

  const isLow = timeRemaining < 10 * 60 * 1000 // Less than 10 minutes
  const isCritical = timeRemaining < 5 * 60 * 1000 // Less than 5 minutes

  return (
    <div className={`sandbox-timer ${isLow ? 'low' : ''} ${isCritical ? 'critical' : ''}`}>
      <svg className="sandbox-timer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <span className="sandbox-timer-text">{formatTimeRemaining(timeRemaining)}</span>
    </div>
  )
}

const Desktop = () => {
  const { windows, minimizedWindows, clearAllWindows } = useWindows()
  const { sandboxReady, sandboxError, sandboxId, sandboxEndAt } = useChat()
  const { user, authLoading, logout } = useAuth()
  const { notes, updateNote, deleteNote, createNote } = useStickyNotes()
  const { showMenu } = useContextMenu()
  const {
    windows: specWindows,
    executeAction,
    updateLocalState,
    deleteWindow,
  } = useSpecWindows()
  const {
    windows: routeWindows,
    createWindow: createRouteWindow,
    deleteWindow: deleteRouteWindow,
    ensureApp,
  } = useRouteWindows()

  const [focusedRouteWindowId, setFocusedRouteWindowId] = useState(null)
  const [minimizedRouteWindows, setMinimizedRouteWindows] = useState([])
  const [chatResetTokens, setChatResetTokens] = useState({})
  const desktopIconWindowsRef = useRef(new Set())
  const fileInputRef = useRef(null)

  const { triggerPaste } = useClipboard({
    sandboxId,
    enabled: sandboxReady,
  })

  const { apps: appRegistry } = useAppRegistry(sandboxId)

  // Single global zIndex counter shared by all window types
  const [windowZIndex, setWindowZIndex] = useState({}) // windowId -> zIndex (regular windows)
  const [specWindowZIndex, setSpecWindowZIndex] = useState({}) // windowId -> zIndex
  const [routeWindowZIndex, setRouteWindowZIndex] = useState({}) // windowId -> zIndex
  const [nextGlobalZIndex, setNextGlobalZIndex] = useState(100)

  const [zoom, setZoom] = useState(1)
  const [zoomOrigin, setZoomOrigin] = useState(null) // null = center; {x,y} = px for pinch-to-zoom
  const [dragOver, setDragOver] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null) // null | { current, total, fileName }
  const [showOnboarding, setShowOnboarding] = useState(true)
  const zoomWrapperRef = useRef(null)

  const handleDesktopWheel = useCallback((e) => {
    // Don't zoom if clicking on buttons or UI elements
    if (e.target.closest('.create-window-buttons, .taskbar, .dock')) {
      return
    }

    // Mac trackpad pinch sends wheel with ctrlKey; also Ctrl/Cmd+scroll
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const el = zoomWrapperRef.current
      if (el) {
        const rect = el.getBoundingClientRect()
        setZoomOrigin({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      }
      setZoom((z) => {
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta))
      })
    }
  }, [])

  useEffect(() => {
    const el = zoomWrapperRef.current
    if (!el) return
    // capture: true so we get pinch over windows; passive: false so preventDefault works
    el.addEventListener('wheel', handleDesktopWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', handleDesktopWheel, { capture: true })
  }, [handleDesktopWheel])

  // Initialize zIndex for new spec windows
  useEffect(() => {
    const newWindows = specWindows.filter(w => !specWindowZIndex[w.id])
    if (newWindows.length === 0) return

    let z = nextGlobalZIndex
    const updates = {}
    newWindows.forEach((w) => {
      updates[w.id] = z++
    })
    setSpecWindowZIndex(prev => ({ ...prev, ...updates }))
    setNextGlobalZIndex(z)
  }, [specWindows.map(w => w.id).join(',')]) // Depend on window IDs

  // Initialize zIndex for new route windows
  useEffect(() => {
    const newWindows = routeWindows.filter(w => !routeWindowZIndex[w.id])
    if (newWindows.length === 0) return

    let z = nextGlobalZIndex
    const updates = {}
    newWindows.forEach((w) => {
      updates[w.id] = z++
    })
    setRouteWindowZIndex(prev => ({ ...prev, ...updates }))
    setNextGlobalZIndex(z)
  }, [routeWindows.map(w => w.id).join(',')]) // Depend on window IDs

  // Filter out minimized windows from display
  const visibleWindows = windows.filter(w => !minimizedWindows.includes(w.id))

  // Handle focus regular window - bring to front with global zIndex
  const handleFocusWindow = useCallback((windowId) => {
    setWindowZIndex(prev => ({
      ...prev,
      [windowId]: nextGlobalZIndex
    }))
    setNextGlobalZIndex(prev => prev + 1)
  }, [nextGlobalZIndex])

  // Handle focus spec window - bring to front
  const handleFocusSpecWindow = useCallback((windowId) => {
    setSpecWindowZIndex(prev => ({
      ...prev,
      [windowId]: nextGlobalZIndex
    }))
    setNextGlobalZIndex(prev => prev + 1)
  }, [nextGlobalZIndex])

  // Handle close spec window
  const handleCloseSpecWindow = useCallback(async (windowId) => {
    try {
      await deleteWindow(windowId)
      // Clean up zIndex
      setSpecWindowZIndex(prev => {
        const updated = { ...prev }
        delete updated[windowId]
        return updated
      })
    } catch (error) {
      console.error('Failed to close window:', error)
    }
  }, [deleteWindow])

  // Handle close route window
  const handleCloseRouteWindow = useCallback(async (windowId) => {
    console.log('Close button clicked for route window:', windowId)
    try {
      await deleteRouteWindow(windowId)
      console.log('Route window closed successfully:', windowId)
      // Also remove from minimized list if it was minimized
      setMinimizedRouteWindows(prev => prev.filter(id => id !== windowId))
      // Clean up zIndex
      setRouteWindowZIndex(prev => {
        const updated = { ...prev }
        delete updated[windowId]
        return updated
      })
    } catch (error) {
      console.error('Failed to close route window:', error)
      alert(`Failed to close window: ${error.message}`)
    }
  }, [deleteRouteWindow])

  // Handle minimize route window
  const handleMinimizeRouteWindow = useCallback((windowId) => {
    setMinimizedRouteWindows(prev => [...prev, windowId])
    // Unfocus if it was focused
    if (focusedRouteWindowId === windowId) {
      setFocusedRouteWindowId(null)
    }
  }, [focusedRouteWindowId])

  // Handle focus route window - bring to front
  const handleFocusRouteWindow = useCallback((windowId) => {
    setFocusedRouteWindowId(windowId)
    setRouteWindowZIndex(prev => ({
      ...prev,
      [windowId]: nextGlobalZIndex
    }))
    setNextGlobalZIndex(prev => prev + 1)
  }, [nextGlobalZIndex])

  // Handle restore route window from dock
  const handleRestoreRouteWindow = useCallback((windowId) => {
    setMinimizedRouteWindows(prev => prev.filter(id => id !== windowId))
    handleFocusRouteWindow(windowId)
    setChatResetTokens(prev => ({
      ...prev,
      [windowId]: (prev[windowId] || 0) + 1,
    }))
  }, [handleFocusRouteWindow])

  // Handle create new route window (MCP)
  const handleCreateRouteWindow = useCallback(async () => {
    try {
      const window = await createRouteWindow('New Window', {
        position: { x: 150 + routeWindows.length * 30, y: 100 + routeWindows.length * 30 },
        size: { width: 700, height: 500 },
      })
      setFocusedRouteWindowId(window.id)
    } catch (error) {
      console.error('Failed to create route window:', error)
    }
  }, [createRouteWindow, routeWindows.length])

  // Handle create new common window
  const handleCreateCommonWindow = useCallback(async () => {
    try {
      const win = await createRouteWindow('Common App', {
        windowType: 'common',
        position: { x: 200 + routeWindows.length * 30, y: 150 + routeWindows.length * 30 },
        size: { width: 700, height: 500 },
      })
      setFocusedRouteWindowId(win.id)
      ensureApp(win.id)
    } catch (error) {
      console.error('Failed to create common window:', error)
    }
  }, [createRouteWindow, routeWindows.length, ensureApp])

  // Listen for custom events from DesktopIcons (registered app double-clicks)
  useEffect(() => {
    const onFocusRouteWindow = (e) => {
      const { windowId } = e.detail
      setMinimizedRouteWindows(prev => prev.filter(id => id !== windowId))
      handleFocusRouteWindow(windowId)
    }

    const onOpenCommonApp = async (e) => {
      const { app } = e.detail
      try {
        const win = await createRouteWindow(app.title || app.name, {
          windowType: 'common',
          port: app.port,
          position: { x: 200 + routeWindows.length * 30, y: 150 + routeWindows.length * 30 },
          size: { width: 700, height: 500 },
        })
        desktopIconWindowsRef.current.add(win.id)
        setFocusedRouteWindowId(win.id)
        ensureApp(win.id)
      } catch (error) {
        console.error('Failed to open common app:', error)
      }
    }

    window.addEventListener('focus-route-window', onFocusRouteWindow)
    window.addEventListener('open-common-app', onOpenCommonApp)

    return () => {
      window.removeEventListener('focus-route-window', onFocusRouteWindow)
      window.removeEventListener('open-common-app', onOpenCommonApp)
    }
  }, [createRouteWindow, routeWindows.length, handleFocusRouteWindow, ensureApp])

  // Handle file upload
  const handleFileUpload = useCallback(async (event) => {
    const files = event.target.files
    if (!files || files.length === 0) return

    if (!sandboxId) {
      alert('Sandbox is not ready yet. Please wait.')
      return
    }

    for (const file of files) {
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('sandbox_id', sandboxId)

        const response = await fetch('/api/sandbox/upload', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        })

        const data = await response.json()

        if (!response.ok || !data.success) {
          alert(`Failed to upload ${file.name}: ${data.error || data.detail || 'Unknown error'}`)
        }
      } catch (error) {
        console.error('Error uploading file:', error)
        alert(`Error uploading ${file.name}: ${error.message}`)
      }
    }

    // Refresh desktop icons immediately
    window.dispatchEvent(new CustomEvent('desktop-files-changed'))

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [sandboxId])

  // Trigger file input click
  const handleUploadClick = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }, [])

  // Handle right-click context menu on desktop
  const handleDesktopContextMenu = useCallback((e) => {
    // Only show context menu when clicking on desktop background
    const target = e.target
    if (
      target.closest('.window') ||
      target.closest('.spec-window-shell') ||
      target.closest('.route-window') ||
      target.closest('.sticky-note') ||
      target.closest('.taskbar') ||
      target.closest('.dock') ||
      target.closest('.create-window-buttons') ||
      target.closest('.desktop-icon')
    ) {
      return // Don't show desktop context menu for these elements
    }

    e.preventDefault()

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
    const modKey = isMac ? '⌘' : 'Ctrl+'

    const menuItems = [
      {
        label: 'New Window',
        icon: '🪟',
        action: handleCreateCommonWindow,
      },
      {
        label: 'New Sticky Note',
        icon: '📝',
        action: () => createNote?.({ x: e.clientX - 100, y: e.clientY - 50 }),
      },
      { divider: true },
      {
        label: 'Upload File',
        icon: '📤',
        action: handleUploadClick,
      },
      {
        label: 'Paste',
        icon: '📋',
        shortcut: isMac ? '⌘V' : 'Ctrl+V',
        action: async () => {
          const files = await triggerPaste()
          if (files.length === 0) {
            // Could show a toast notification here
            console.log('No pasteable content in clipboard')
          }
        },
      },
      { divider: true },
      {
        label: 'Refresh',
        icon: '🔄',
        shortcut: isMac ? '⌘R' : 'F5',
        action: () => window.location.reload(),
      },
      { divider: true },
      {
        label: 'View',
        icon: '👁️',
        submenu: [
          {
            label: 'Reset Zoom',
            action: () => setZoom(1),
          },
          {
            label: 'Zoom In',
            shortcut: `${modKey}+`,
            action: () => setZoom(z => Math.min(ZOOM_MAX, z + ZOOM_STEP)),
          },
          {
            label: 'Zoom Out',
            shortcut: `${modKey}-`,
            action: () => setZoom(z => Math.max(ZOOM_MIN, z - ZOOM_STEP)),
          },
        ],
      },
      {
        label: 'Close All Windows',
        icon: '❌',
        shortcut: `${modKey}⇧W`,
        action: () => {
          clearAllWindows()
          routeWindows.forEach(w => handleCloseRouteWindow(w.id))
          specWindows.forEach(w => handleCloseSpecWindow(w.id))
        },
        disabled: windows.length === 0 && routeWindows.length === 0 && specWindows.length === 0,
      },
    ]

    showMenu(e.clientX, e.clientY, menuItems)
  }, [handleCreateCommonWindow, handleUploadClick, createNote, showMenu, clearAllWindows, windows.length, routeWindows, specWindows, handleCloseRouteWindow, handleCloseSpecWindow, triggerPaste])

  // Drag-and-drop file upload handlers
  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragEnter = useCallback((e) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e) => {
    // Only set false when leaving the desktop element itself,
    // not when entering a child element (avoids flicker)
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    setDragOver(false)

    const files = e.dataTransfer.files
    if (!files || files.length === 0) return

    if (!sandboxId) {
      alert('Sandbox is not ready yet. Please wait.')
      return
    }

    const total = files.length
    setUploadProgress({ current: 0, total, fileName: files[0].name })

    for (let i = 0; i < total; i++) {
      const file = files[i]
      setUploadProgress({ current: i, total, fileName: file.name })

      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('sandbox_id', sandboxId)

        const response = await fetch('/api/sandbox/upload', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        })

        const data = await response.json()

        if (!response.ok || !data.success) {
          alert(`Failed to upload ${file.name}: ${data.error || data.detail || 'Unknown error'}`)
        }
      } catch (error) {
        console.error('Error uploading file:', error)
        alert(`Error uploading ${file.name}: ${error.message}`)
      }
    }

    setUploadProgress({ current: total, total, fileName: '' })

    // Refresh desktop icons immediately
    window.dispatchEvent(new CustomEvent('desktop-files-changed'))

    // Brief pause so the user sees the completed bar, then dismiss
    setTimeout(() => setUploadProgress(null), 600)
  }, [sandboxId])

  // Show landing page if not authenticated
  if (authLoading) {
    return <LoadingScreen message="Checking session..." />
  }

  if (!user) {
    return <LandingPage />
  }

  // Show error screen if sandbox creation failed
  if (sandboxError) {
    return <LoadingScreen message="Failed to start virtual computer. Please refresh the page or check the server." />
  }

  // Show loading screen while sandbox is being created
  if (!sandboxReady) {
    return <LoadingScreen message="Your virtual computer is starting..." />
  }

  return (
    <div
      className="desktop"
      onContextMenu={handleDesktopContextMenu}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={zoomWrapperRef}
        className="desktop-zoom-wrapper"
        style={{
          transform: `scale(${zoom})`,
          transformOrigin: zoomOrigin ? `${zoomOrigin.x}px ${zoomOrigin.y}px` : '50% 50%',
        }}
      >
        <div className="desktop-background"></div>

        {/* Desktop Icons Layer */}
        <DesktopIcons />

        {/* Sticky Notes Layer */}
        <div className="sticky-notes-layer">
        {notes.map(note => (
          <StickyNote
            key={note.id}
            note={note}
            onUpdate={updateNote}
            onDelete={deleteNote}
          />
        ))}
      </div>

      {/* Windows Layer - existing chat-based windows */}
      <div className="windows-layer">
        {visibleWindows.map(window => (
          <Window
            key={window.id}
            window={window}
            zIndex={windowZIndex[window.id]}
            onFocus={handleFocusWindow}
          />
        ))}
      </div>

      {/* Spec Windows Layer - composable windows */}
      <div className="spec-windows-layer">
        {specWindows.map(windowRecord => (
          <SpecWindowWrapper
            key={windowRecord.id}
            windowRecord={windowRecord}
            onAction={executeAction}
            onStateChange={updateLocalState}
            onClose={handleCloseSpecWindow}
            zIndex={specWindowZIndex[windowRecord.id] || 200}
            onFocus={handleFocusSpecWindow}
          />
        ))}
      </div>

      {/* Route Windows Layer - mini browser windows */}
      <div className="route-windows-layer">
        {routeWindows
          .filter(w => !minimizedRouteWindows.includes(w.id))
          .map(windowRecord => (
            <RouteWindow
              key={windowRecord.id}
              windowRecord={windowRecord}
              isFocused={focusedRouteWindowId === windowRecord.id}
              chatResetToken={chatResetTokens[windowRecord.id] || 0}
              defaultHideChat={
                desktopIconWindowsRef.current.has(windowRecord.id) ||
                (windowRecord.window_type === 'common' && windowRecord.port &&
                  appRegistry.some(app => app.port === windowRecord.port))
              }
              onFocus={handleFocusRouteWindow}
              onClose={handleCloseRouteWindow}
              onMinimize={handleMinimizeRouteWindow}
              zIndex={routeWindowZIndex[windowRecord.id] || 300}
            />
          ))}
      </div>
      </div>


      {/* Taskbar - bottom */}
      <Taskbar />

      {/* Dock - Mac-style dock for minimized route windows */}
      <Dock
        minimizedWindows={routeWindows.filter(w => minimizedRouteWindows.includes(w.id))}
        onRestore={handleRestoreRouteWindow}
        appRegistry={appRegistry}
      />

      {/* Create Window Buttons */}
      <div className="create-window-buttons">
        {/* MCP app create button hidden
        <button
          className="create-window-btn create-route-window-btn"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            handleCreateRouteWindow()
          }}
          title="Create new MCP app window"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
        </button>
        */}
        <button
          className="create-window-btn create-common-window-btn"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            handleCreateCommonWindow()
          }}
          title="Create new common app window"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      {/* Sandbox Info Bar */}
      <div className="sandbox-info-bar">
        {user && (
          <div className="sandbox-id-indicator" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {user.picture_url && (
              <img
                src={user.picture_url}
                alt=""
                style={{ width: 20, height: 20, borderRadius: '50%' }}
              />
            )}
            <span>{user.email}</span>
            <button
              onClick={logout}
              style={{
                background: 'none',
                border: '1px solid rgba(255,255,255,0.2)',
                color: 'inherit',
                cursor: 'pointer',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '11px',
              }}
            >
              Logout
            </button>
          </div>
        )}
        {sandboxId && (
          <div className="sandbox-id-indicator">
            Running in sandbox: {sandboxId}
          </div>
        )}
        {sandboxEndAt && <SandboxTimer endAt={sandboxEndAt} />}
      </div>

      {/* Drop overlay for drag-and-drop file upload */}
      {(dragOver || uploadProgress) && (
        <div className={`desktop-drop-overlay ${uploadProgress ? 'uploading' : ''}`}>
          <div className="drop-overlay-pill">
            {uploadProgress ? (
              <>
                <svg className="drop-overlay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span className="drop-overlay-text">
                  {uploadProgress.current < uploadProgress.total
                    ? `Uploading ${uploadProgress.fileName}`
                    : 'Done'}
                </span>
                <div className="drop-overlay-progress-track">
                  <div
                    className="drop-overlay-progress-bar"
                    style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                  />
                </div>
                <span className="drop-overlay-count">
                  {uploadProgress.current} / {uploadProgress.total}
                </span>
              </>
            ) : (
              <>
                <svg className="drop-overlay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span className="drop-overlay-text">Drop files here</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Onboarding overlay — shown on first login */}
      {showOnboarding && (
        <OnboardingOverlay onComplete={() => setShowOnboarding(false)} />
      )}
    </div>
  )
}

export default Desktop
