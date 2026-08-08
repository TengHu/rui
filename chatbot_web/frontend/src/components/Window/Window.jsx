import { useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Rnd } from 'react-rnd'
import { useWindows } from '../../context/WindowContext'
import { WINDOW_ICONS, MIN_WINDOW_SIZE } from '../../utils/windowTypes'
import './Window.css'

// Snap zone configuration
const SNAP_THRESHOLD = 20 // pixels from edge to trigger snap
const TASKBAR_HEIGHT = 64 // Height of taskbar at bottom

// Snap zones: left, right, top-left, top-right, maximize (top)
const getSnapZone = (x, y, parentWidth, parentHeight) => {
  const effectiveHeight = parentHeight - TASKBAR_HEIGHT

  // Top edge (center) = maximize
  if (y < SNAP_THRESHOLD && x > SNAP_THRESHOLD && x < parentWidth - SNAP_THRESHOLD) {
    return 'maximize'
  }

  // Left edge
  if (x < SNAP_THRESHOLD) {
    // Top-left corner
    if (y < SNAP_THRESHOLD) return 'top-left'
    // Bottom-left corner
    if (y > effectiveHeight - SNAP_THRESHOLD) return 'bottom-left'
    // Left half
    return 'left'
  }

  // Right edge
  if (x > parentWidth - SNAP_THRESHOLD) {
    // Top-right corner
    if (y < SNAP_THRESHOLD) return 'top-right'
    // Bottom-right corner
    if (y > effectiveHeight - SNAP_THRESHOLD) return 'bottom-right'
    // Right half
    return 'right'
  }

  return null
}

// Get the dimensions for a snap zone
const getSnapDimensions = (zone, parentWidth, parentHeight) => {
  const effectiveHeight = parentHeight - TASKBAR_HEIGHT

  switch (zone) {
    case 'left':
      return { x: 0, y: 0, width: parentWidth / 2, height: effectiveHeight }
    case 'right':
      return { x: parentWidth / 2, y: 0, width: parentWidth / 2, height: effectiveHeight }
    case 'top-left':
      return { x: 0, y: 0, width: parentWidth / 2, height: effectiveHeight / 2 }
    case 'top-right':
      return { x: parentWidth / 2, y: 0, width: parentWidth / 2, height: effectiveHeight / 2 }
    case 'bottom-left':
      return { x: 0, y: effectiveHeight / 2, width: parentWidth / 2, height: effectiveHeight / 2 }
    case 'bottom-right':
      return { x: parentWidth / 2, y: effectiveHeight / 2, width: parentWidth / 2, height: effectiveHeight / 2 }
    case 'maximize':
      return { x: 0, y: 0, width: parentWidth, height: effectiveHeight }
    default:
      return null
  }
}

const Window = ({ window, zIndex: zIndexOverride, onFocus: onFocusProp }) => {
  const { focusWindow, closeWindow, minimizeWindow, maximizeWindow, maximizedWindows, updateWindowPosition, updateWindowSize, focusedWindowId } = useWindows()
  const windowRef = useRef(null)
  const [snapZone, setSnapZone] = useState(null)
  const [snapPreview, setSnapPreview] = useState(null)
  const [isDragging, setIsDragging] = useState(false)

  const isFocused = focusedWindowId === window.id
  const isMaximized = maximizedWindows.includes(window.id)

  // Get parent dimensions
  const getParentDimensions = useCallback(() => {
    if (windowRef.current) {
      const parent = windowRef.current.resizableElement.current?.parentElement
      if (parent) {
        return {
          width: parent.clientWidth,
          height: parent.clientHeight
        }
      }
    }
    return { width: globalThis.innerWidth, height: globalThis.innerHeight }
  }, [])

  const handleDrag = useCallback((e, data) => {
    const { width: parentWidth, height: parentHeight } = getParentDimensions()

    // Use the cursor position to detect snap zone
    const cursorX = e.clientX
    const cursorY = e.clientY

    const zone = getSnapZone(cursorX, cursorY, parentWidth, parentHeight)

    if (zone) {
      const dimensions = getSnapDimensions(zone, parentWidth, parentHeight)
      setSnapZone(zone)
      setSnapPreview(dimensions)
    } else {
      setSnapZone(null)
      setSnapPreview(null)
    }

  }, [getParentDimensions])

  const handleDragStart = useCallback(() => {
    setIsDragging(true)
  }, [])

  const handleDragStop = useCallback((e, data) => {
    setIsDragging(false)

    if (snapZone && snapPreview) {
      // Apply snap
      if (snapZone === 'maximize') {
        maximizeWindow(window.id)
      } else {
        // Snap to zone
        updateWindowPosition(window.id, { x: snapPreview.x, y: Math.max(0, snapPreview.y) })
        updateWindowSize(window.id, { width: snapPreview.width, height: snapPreview.height })
      }

      setSnapZone(null)
      setSnapPreview(null)
    } else {
      // Normal drop - clamp top boundary
      updateWindowPosition(window.id, { x: data.x, y: Math.max(0, data.y) })
    }
  }, [snapZone, snapPreview, window.id, updateWindowPosition, updateWindowSize, maximizeWindow])

  const handleResizeStop = (e, direction, ref, delta, position) => {
    updateWindowSize(window.id, {
      width: parseInt(ref.style.width),
      height: parseInt(ref.style.height)
    })
    updateWindowPosition(window.id, position)
  }

  const handleMaximize = () => {
    maximizeWindow(window.id)
  }

  const handleTitlebarDoubleClick = (e) => {
    if (e.target.closest('.window-controls')) return
    handleMaximize()
  }

  // When maximized, use full parent size
  const rndProps = isMaximized
    ? {
        position: { x: 0, y: 0 },
        size: { width: '100%', height: '100%' },
        disableDragging: true,
        enableResizing: false,
      }
    : {
        default: {
          x: window.position.x,
          y: window.position.y,
          width: window.size.width,
          height: window.size.height,
        },
        disableDragging: false,
        enableResizing: true,
      }

  // Render snap preview as a portal to escape stacking context
  const snapPreviewElement = isDragging && snapPreview && createPortal(
    <div
      className="snap-preview"
      style={{
        left: snapPreview.x,
        top: snapPreview.y,
        width: snapPreview.width,
        height: snapPreview.height,
      }}
    />,
    document.body
  )

  return (
    <>
      {/* Snap Preview Overlay - rendered via portal */}
      {snapPreviewElement}

      <Rnd
        ref={windowRef}
        {...rndProps}
        bounds="parent"
        minWidth={MIN_WINDOW_SIZE.width}
        minHeight={MIN_WINDOW_SIZE.height}
        dragHandleClassName="window-titlebar"
        onDragStart={handleDragStart}
        onDrag={handleDrag}
        onDragStop={handleDragStop}
        onResizeStop={handleResizeStop}
        style={{
          zIndex: zIndexOverride !== undefined ? zIndexOverride : window.zIndex,
          transition: isMaximized ? 'all 0.2s ease' : 'none'
        }}
        onMouseDown={() => {
          onFocusProp?.(window.id)
          if (!isFocused) focusWindow(window.id)
        }}
      >
        <div className={`window ${isFocused ? 'focused' : ''} ${isMaximized ? 'maximized' : ''}`}>
          <div className="window-titlebar" onDoubleClick={handleTitlebarDoubleClick}>
            <div className="window-title">
              <span className="window-icon">{WINDOW_ICONS[window.type]}</span>
              <span className="window-title-text">{window.title}</span>
            </div>
            <div className="window-controls">
              <button
                className="window-control-btn minimize"
                onClick={() => minimizeWindow(window.id)}
                title="Minimize"
              >
                <svg width="12" height="12" viewBox="0 0 12 12">
                  <line x1="0" y1="6" x2="12" y2="6" stroke="currentColor" strokeWidth="2"/>
                </svg>
              </button>
              <button
                className="window-control-btn maximize"
                onClick={handleMaximize}
                title={isMaximized ? "Restore" : "Maximize"}
              >
                {isMaximized ? (
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <rect x="2" y="4" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M4 4V2h6v6h-2" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                )}
              </button>
              <button
                className="window-control-btn close"
                onClick={() => closeWindow(window.id)}
                title="Close"
              >
                <svg width="12" height="12" viewBox="0 0 12 12">
                  <line x1="0" y1="0" x2="12" y2="12" stroke="currentColor" strokeWidth="2"/>
                  <line x1="12" y1="0" x2="0" y2="12" stroke="currentColor" strokeWidth="2"/>
                </svg>
              </button>
            </div>
          </div>
          <div className="window-content">
            {window.content}
          </div>
        </div>
      </Rnd>
    </>
  )
}

export default Window
