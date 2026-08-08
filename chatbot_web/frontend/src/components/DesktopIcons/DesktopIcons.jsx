import { useCallback } from 'react'
import { useWindows } from '../../context/WindowContext'
import { useChat } from '../../context/ChatContext'
import { useRouteWindows } from '../../context/RouteWindowContext'
import { useDesktopFiles } from '../../hooks/useDesktopFiles'
import { useAppRegistry } from '../../hooks/useAppRegistry'
import { WINDOW_TYPES } from '../../utils/windowTypes'
import Terminal from '../Terminal'
import FileManager from '../FileManager/FileManager'
import MCPPanel from '../MCPPanel/MCPPanel'
import './DesktopIcons.css'

// Simple placeholder for features that aren't ready yet
const ComingSoon = () => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: '18px',
    fontWeight: 600,
    color: '#888',
  }}>
    Coming soon
  </div>
)

// System shortcuts - always displayed at top
const SYSTEM_SHORTCUTS = [
  { id: 'terminal-shortcut', title: 'Terminal', icon: '⬛', type: WINDOW_TYPES.TERMINAL, component: Terminal },
  { id: 'files-shortcut', title: 'File Explorer', icon: '📁', type: WINDOW_TYPES.FILE_MANAGER, component: FileManager },
  { id: 'mcp-shortcut', title: 'MCP Panel', icon: '🔌', type: WINDOW_TYPES.MCP_PANEL, component: MCPPanel },
  { id: 'ecosystem-shortcut', title: 'App Ecosystem', icon: '🧩', type: WINDOW_TYPES.APP_ECOSYSTEM, component: ComingSoon },
  { id: 'contact-shortcut', title: 'Talk to Us', icon: '🐦', mailto: 'hu.niel92@gmail.com' },
]

const getFileIcon = (filename, isDirectory) => {
  if (isDirectory) return '📁'

  const ext = filename.split('.').pop()?.toLowerCase()

  switch (ext) {
    case 'pdf': return '📕'
    case 'doc': case 'docx': return '📘'
    case 'xls': case 'xlsx': return '📊'
    case 'ppt': case 'pptx': return '📙'
    case 'zip': case 'tar': case 'gz': case 'rar': return '📦'
    case 'js': case 'jsx': case 'ts': case 'tsx': return '📜'
    case 'py': return '🐍'
    case 'html': case 'css': return '🌐'
    case 'json': return '📋'
    case 'md': return '📝'
    case 'jpg': case 'jpeg': case 'png': case 'gif': case 'svg': case 'webp': return '🖼️'
    case 'mp4': case 'avi': case 'mov': case 'mkv': return '🎬'
    case 'mp3': case 'wav': case 'ogg': return '🎵'
    case 'txt': return '📄'
    default: return '📄'
  }
}

const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// Renders an inline SVG string safely via data URI (prevents XSS)
const AppLogo = ({ svg, size = 32 }) => {
  if (!svg) {
    return <span className="desktop-icon-emoji">{"📦"}</span>
  }
  const encoded = encodeURIComponent(svg)
  return (
    <img
      className="app-logo-svg"
      src={`data:image/svg+xml,${encoded}`}
      width={size}
      height={size}
      alt=""
    />
  )
}

const DesktopIcons = () => {
  const { openWindow, windows, focusWindow, restoreWindow, minimizedWindows } = useWindows()
  const { sandboxId } = useChat()
  const { windows: routeWindows } = useRouteWindows()
  const { files, desktopPath } = useDesktopFiles(sandboxId)
  const { apps: registeredApps } = useAppRegistry(sandboxId)

  const handleShortcutDoubleClick = useCallback((shortcut) => {
    // Handle mailto shortcuts — open email client directly
    if (shortcut.mailto) {
      window.open(`mailto:${shortcut.mailto}`, '_blank')
      return
    }

    // Check if window of this type already exists
    const existingWindow = windows.find(w => w.type === shortcut.type)

    if (existingWindow) {
      // Focus or restore existing window
      if (minimizedWindows.includes(existingWindow.id)) {
        restoreWindow(existingWindow.id)
      } else {
        focusWindow(existingWindow.id)
      }
      return
    }

    const windowId = `${shortcut.type.toLowerCase()}-${Date.now()}`
    const AppComponent = shortcut.component

    openWindow({
      id: windowId,
      title: shortcut.title,
      type: shortcut.type,
      content: shortcut.type === WINDOW_TYPES.TERMINAL
        ? <AppComponent sandboxId={sandboxId} />
        : <AppComponent />,
      size: shortcut.type === WINDOW_TYPES.TERMINAL
        ? { width: 700, height: 450 }
        : { width: 800, height: 500 }
    })
  }, [openWindow, windows, focusWindow, restoreWindow, minimizedWindows, sandboxId])

  // Handle double-click on a registered common app icon
  const handleAppDoubleClick = useCallback((app) => {
    // Find the route window that matches this app's port
    const existingRouteWindow = routeWindows.find(
      w => w.window_type === 'common' && w.port === app.port
    )

    if (existingRouteWindow) {
      // Route window already exists for this port — focus it
      // Dispatch a custom event that Desktop.jsx listens for
      window.dispatchEvent(new CustomEvent('focus-route-window', {
        detail: { windowId: existingRouteWindow.id },
      }))
      return
    }

    // No existing window — create a new common window for this app
    // Dispatch a custom event that Desktop.jsx handles
    window.dispatchEvent(new CustomEvent('open-common-app', {
      detail: { app },
    }))
  }, [routeWindows])

  const handleFileDoubleClick = useCallback((file) => {
    const filePath = `${desktopPath}/${file.name}`

    if (file.type === 'directory') {
      // Open File Manager at this directory
      const windowId = `file-manager-${Date.now()}`
      openWindow({
        id: windowId,
        title: file.name,
        type: WINDOW_TYPES.FILE_MANAGER,
        content: <FileManager initialPath={filePath} />,
        size: { width: 800, height: 500 }
      })
      return
    }

    // Determine window type based on file extension
    const ext = file.name.split('.').pop()?.toLowerCase()
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp']
    const codeExtensions = ['js', 'jsx', 'ts', 'tsx', 'py', 'html', 'css', 'json', 'md', 'txt', 'sh', 'yaml', 'yml']

    let windowType = WINDOW_TYPES.FILE_VIEWER
    if (imageExtensions.includes(ext)) {
      windowType = WINDOW_TYPES.IMAGE_VIEWER
    } else if (codeExtensions.includes(ext)) {
      windowType = WINDOW_TYPES.CODE_EDITOR
    }

    const windowId = `file-${Date.now()}`
    openWindow({
      id: windowId,
      title: file.name,
      type: windowType,
      path: filePath,
      size: { width: 700, height: 500 }
    })
  }, [openWindow, desktopPath])

  return (
    <div className="desktop-icons">
      {/* System Shortcuts */}
      {SYSTEM_SHORTCUTS.map(shortcut => (
        <div
          key={shortcut.id}
          className={`desktop-icon desktop-shortcut${shortcut.mailto ? ' contact-icon' : ''}`}
          onDoubleClick={() => handleShortcutDoubleClick(shortcut)}
          title={shortcut.title}
        >
          <div className="desktop-icon-image shortcut-icon">
            <span className="desktop-icon-emoji">{shortcut.icon}</span>
          </div>
          <div className="desktop-icon-label">{shortcut.title}</div>
        </div>
      ))}

      {/* Registered Common Apps */}
      {registeredApps.map(app => (
        <div
          key={`app-${app.name}`}
          className="desktop-icon desktop-app"
          onDoubleClick={() => handleAppDoubleClick(app)}
          title={`${app.title || app.name}\nPort: ${app.port}`}
        >
          <div className="desktop-icon-image app-icon">
            <AppLogo svg={app.logo} />
          </div>
          <div className="desktop-icon-label">{app.title || app.name}</div>
        </div>
      ))}

      {/* Files from desktop folder */}
      {files.map(file => (
        <div
          key={file.name}
          className="desktop-icon desktop-file"
          onDoubleClick={() => handleFileDoubleClick(file)}
          title={file.type === 'directory' ? file.name : `${file.name}\n${formatFileSize(file.size)}`}
        >
          <div className="desktop-icon-image file-icon">
            <span className="desktop-icon-emoji">{getFileIcon(file.name, file.type === 'directory')}</span>
          </div>
          <div className="desktop-icon-label">{file.name}</div>
        </div>
      ))}
    </div>
  )
}

export default DesktopIcons
