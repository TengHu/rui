/**
 * FileManager - Browse and manage files in E2B sandbox
 *
 * Features:
 * - Sidebar with favorites (Desktop)
 * - List directory contents
 * - Navigate folders (double-click)
 * - Breadcrumb navigation
 * - Go up/back/forward
 * - Create new folder
 * - Delete files/folders
 * - Rename files/folders
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useChat } from '../../context/ChatContext'
import './FileManager.css'

const DEFAULT_PATH = '/home/user/workspace/desktop'
const WORKSPACE_PATH = '/home/user/workspace'

// Sidebar favorites
const FAVORITES = [
  { id: 'desktop', name: 'Desktop', path: '/home/user/workspace/desktop', icon: '🖥️' },
]

// File type icons
const getFileIcon = (file) => {
  if (file.type === 'directory') return '\ud83d\udcc1'

  // Get extension
  const ext = file.name.split('.').pop().toLowerCase()

  const iconMap = {
    js: '\ud83d\udcdc',
    jsx: '\ud83d\udcdc',
    ts: '\ud83d\udcdc',
    tsx: '\ud83d\udcdc',
    py: '\ud83d\udc0d',
    json: '\ud83d\udccb',
    html: '\ud83c\udf10',
    css: '\ud83c\udfa8',
    md: '\ud83d\udcd6',
    txt: '\ud83d\udcc4',
    png: '\ud83d\uddbc\ufe0f',
    jpg: '\ud83d\uddbc\ufe0f',
    jpeg: '\ud83d\uddbc\ufe0f',
    gif: '\ud83d\uddbc\ufe0f',
    svg: '\ud83d\uddbc\ufe0f',
    pdf: '\ud83d\udcc4',
  }

  return iconMap[ext] || '\ud83d\udcc4'
}

// Format file size
const formatSize = (bytes) => {
  if (bytes === 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function FileManager() {
  const { sandboxId, sandboxReady } = useChat()
  const [path, setPath] = useState(DEFAULT_PATH)
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [renaming, setRenaming] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [history, setHistory] = useState([DEFAULT_PATH])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [pasting, setPasting] = useState(false)
  const containerRef = useRef(null)

  // Navigate to path and update history
  const navigateTo = useCallback((newPath, addToHistory = true) => {
    if (addToHistory && newPath !== path) {
      const newHistory = history.slice(0, historyIndex + 1)
      newHistory.push(newPath)
      setHistory(newHistory)
      setHistoryIndex(newHistory.length - 1)
    }
    setPath(newPath)
  }, [path, history, historyIndex])

  // Go back in history
  const handleGoBack = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1)
      setPath(history[historyIndex - 1])
    }
  }

  // Go forward in history
  const handleGoForward = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1)
      setPath(history[historyIndex + 1])
    }
  }

  // Get breadcrumb parts from path
  const getBreadcrumbs = () => {
    const parts = path.split('/').filter(Boolean)
    const breadcrumbs = []
    let currentPath = ''

    for (const part of parts) {
      currentPath += '/' + part
      breadcrumbs.push({ name: part, path: currentPath })
    }

    return breadcrumbs
  }

  // Load files from API
  const loadFiles = useCallback(async (dirPath) => {
    if (!sandboxReady || !sandboxId) {
      setLoading(false)
      setError('Sandbox not ready')
      return
    }

    setLoading(true)
    setError(null)
    setSelectedFile(null)

    try {
      const response = await fetch(
        `/api/fs/list?path=${encodeURIComponent(dirPath)}&sandbox_id=${sandboxId}`,
        { credentials: 'include' }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.detail || 'Failed to load files')
      }

      const data = await response.json()

      // Sort: directories first, then alphabetically
      const sorted = [...data.files].sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      })

      setFiles(sorted)
    } catch (err) {
      console.error('Failed to load files:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [sandboxId, sandboxReady])

  // Load files on path change
  useEffect(() => {
    loadFiles(path)
  }, [path, loadFiles])

  // Handle double-click on file/folder
  const handleDoubleClick = (file) => {
    if (file.type === 'directory') {
      navigateTo(file.path)
    } else {
      // TODO: Open file in editor
      console.log('Open file:', file.path)
    }
  }

  // Go up to parent directory
  const handleGoUp = () => {
    if (path === '/') return
    const parent = path.split('/').slice(0, -1).join('/') || '/'
    navigateTo(parent)
  }

  // Create new folder
  const handleCreateFolder = async () => {
    const name = prompt('Folder name:')
    if (!name || !name.trim()) return

    try {
      const response = await fetch(`/api/fs/mkdir?sandbox_id=${sandboxId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ path: `${path}/${name}` }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.detail || 'Failed to create folder')
      }

      loadFiles(path)
    } catch (err) {
      alert(`Error: ${err.message}`)
    }
  }

  // Delete file/folder
  const handleDelete = async (file, e) => {
    e.stopPropagation()

    if (!confirm(`Delete "${file.name}"?`)) return

    try {
      const response = await fetch(
        `/api/fs/delete?path=${encodeURIComponent(file.path)}&sandbox_id=${sandboxId}`,
        { method: 'DELETE', credentials: 'include' }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.detail || 'Failed to delete')
      }

      loadFiles(path)
    } catch (err) {
      alert(`Error: ${err.message}`)
    }
  }

  // Start renaming
  const handleStartRename = (file, e) => {
    e.stopPropagation()
    setRenaming(file.path)
    setRenameValue(file.name)
  }

  // Submit rename
  const handleRename = async (file) => {
    if (!renameValue || renameValue === file.name) {
      setRenaming(null)
      return
    }

    const newPath = path + '/' + renameValue

    try {
      const response = await fetch(`/api/fs/rename?sandbox_id=${sandboxId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          old_path: file.path,
          new_path: newPath,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.detail || 'Failed to rename')
      }

      loadFiles(path)
    } catch (err) {
      alert(`Error: ${err.message}`)
    } finally {
      setRenaming(null)
    }
  }

  // Handle keyboard in rename input
  const handleRenameKeyDown = (e, file) => {
    if (e.key === 'Enter') {
      handleRename(file)
    } else if (e.key === 'Escape') {
      setRenaming(null)
    }
  }

  // Refresh
  const handleRefresh = () => {
    loadFiles(path)
  }

  // Handle paste from clipboard
  const handlePaste = useCallback(async (e) => {
    if (!sandboxReady || !sandboxId || pasting) return

    // Get clipboard data
    const clipboardData = e?.clipboardData || window.clipboardData
    if (!clipboardData) {
      // Try using clipboard API
      await handlePasteFromAPI()
      return
    }

    // Check for files
    if (clipboardData.files && clipboardData.files.length > 0) {
      e?.preventDefault?.()
      setPasting(true)

      try {
        for (const file of clipboardData.files) {
          let fileName = file.name
          if (!fileName || fileName === 'image.png' || fileName === 'blob') {
            const ext = file.type.split('/')[1] || 'png'
            fileName = `pasted-${Date.now()}.${ext}`
          }

          // Read file as base64
          const reader = new FileReader()
          const content = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result.split(',')[1])
            reader.onerror = reject
            reader.readAsDataURL(file)
          })

          // Write to current directory
          const filePath = `${path}/${fileName}`
          await fetch(`/api/fs/write?sandbox_id=${sandboxId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ path: filePath, content, encoding: 'base64' }),
          })
        }
        loadFiles(path)
      } catch (err) {
        console.error('Paste error:', err)
        alert(`Paste failed: ${err.message}`)
      } finally {
        setPasting(false)
      }
      return
    }

    // Check for images in items
    for (const item of clipboardData.items || []) {
      if (item.type.startsWith('image/')) {
        e?.preventDefault?.()
        const blob = item.getAsFile()
        if (blob) {
          setPasting(true)
          try {
            const ext = item.type.split('/')[1] || 'png'
            const fileName = `pasted-${Date.now()}.${ext}`

            const reader = new FileReader()
            const content = await new Promise((resolve, reject) => {
              reader.onload = () => resolve(reader.result.split(',')[1])
              reader.onerror = reject
              reader.readAsDataURL(blob)
            })

            const filePath = `${path}/${fileName}`
            await fetch(`/api/fs/write?sandbox_id=${sandboxId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: filePath, content, encoding: 'base64' }),
            })
            loadFiles(path)
          } catch (err) {
            console.error('Paste error:', err)
            alert(`Paste failed: ${err.message}`)
          } finally {
            setPasting(false)
          }
        }
        return
      }
    }
  }, [sandboxReady, sandboxId, pasting, path, loadFiles])

  // Handle paste using Clipboard API (for context menu/button click)
  const handlePasteFromAPI = useCallback(async () => {
    if (!sandboxReady || !sandboxId || pasting) return

    setPasting(true)
    try {
      const clipboardItems = await navigator.clipboard.read()

      for (const item of clipboardItems) {
        // Check for image types
        const imageType = item.types.find(t => t.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          const ext = imageType.split('/')[1] || 'png'
          const fileName = `pasted-${Date.now()}.${ext}`

          const reader = new FileReader()
          const content = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result.split(',')[1])
            reader.onerror = reject
            reader.readAsDataURL(blob)
          })

          const filePath = `${path}/${fileName}`
          await fetch(`/api/fs/write?sandbox_id=${sandboxId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ path: filePath, content, encoding: 'base64' }),
          })
          loadFiles(path)
          return
        }

        // Check for text
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain')
          const text = await blob.text()
          if (text.trim()) {
            const fileName = `pasted-text-${Date.now()}.txt`
            const filePath = `${path}/${fileName}`
            await fetch(`/api/fs/write?sandbox_id=${sandboxId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ path: filePath, content: text }),
            })
            loadFiles(path)
            return
          }
        }
      }
    } catch (err) {
      console.warn('Clipboard API not available:', err.message)
    } finally {
      setPasting(false)
    }
  }, [sandboxReady, sandboxId, pasting, path, loadFiles])

  // Listen for paste events when FileManager is focused
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onPaste = (e) => handlePaste(e)
    container.addEventListener('paste', onPaste)
    return () => container.removeEventListener('paste', onPaste)
  }, [handlePaste])

  if (!sandboxReady) {
    return (
      <div className="file-manager">
        <div className="fm-message">Waiting for sandbox...</div>
      </div>
    )
  }

  const breadcrumbs = getBreadcrumbs()

  return (
    <div className="file-manager" ref={containerRef} tabIndex={-1}>
      {/* Sidebar */}
      <div className="fm-sidebar">
        <div className="fm-sidebar-section">
          <div className="fm-sidebar-title">Favorites</div>
          {FAVORITES.map((fav) => (
            <button
              key={fav.id}
              className={`fm-sidebar-item ${path.startsWith(fav.path) ? 'active' : ''}`}
              onClick={() => navigateTo(fav.path)}
            >
              <span className="fm-sidebar-icon">{fav.icon}</span>
              <span className="fm-sidebar-name">{fav.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="fm-main">
        {/* Toolbar */}
        <div className="fm-toolbar">
          <button
            className="fm-btn"
            onClick={handleGoBack}
            disabled={historyIndex <= 0}
            title="Back"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            className="fm-btn"
            onClick={handleGoForward}
            disabled={historyIndex >= history.length - 1}
            title="Forward"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
          <button
            className="fm-btn"
            onClick={handleGoUp}
            disabled={path === '/'}
            title="Go up"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </button>

          {/* Breadcrumb */}
          <div className="fm-breadcrumb">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.path} className="fm-breadcrumb-item">
                {index > 0 && <span className="fm-breadcrumb-sep">▸</span>}
                <button
                  className="fm-breadcrumb-btn"
                  onClick={() => navigateTo(crumb.path)}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>

          <button className="fm-btn fm-btn-primary" onClick={handleCreateFolder} title="New Folder">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>
          <button
            className="fm-btn"
            onClick={handlePasteFromAPI}
            disabled={pasting}
            title="Paste (Ctrl+V)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
          </button>
          <button className="fm-btn" onClick={handleRefresh} title="Refresh">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>

        {/* File list */}
        <div className="fm-list">
          {loading ? (
            <div className="fm-message">Loading...</div>
          ) : error ? (
            <div className="fm-message fm-error">{error}</div>
          ) : files.length === 0 ? (
            <div className="fm-message">This folder is empty</div>
          ) : (
            files.map((file) => (
              <div
                key={file.path}
                className={`fm-item ${file.type} ${selectedFile === file.path ? 'selected' : ''}`}
                onClick={() => setSelectedFile(file.path)}
                onDoubleClick={() => handleDoubleClick(file)}
              >
                <span className="fm-icon">{getFileIcon(file)}</span>

                {renaming === file.path ? (
                  <input
                    className="fm-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => handleRename(file)}
                    onKeyDown={(e) => handleRenameKeyDown(e, file)}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="fm-name">{file.name}</span>
                )}

                <span className="fm-size">
                  {file.type === 'file' ? formatSize(file.size) : ''}
                </span>

                <div className="fm-actions">
                  <button
                    className="fm-action-btn"
                    onClick={(e) => handleStartRename(file, e)}
                    title="Rename"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="fm-action-btn fm-delete-btn"
                    onClick={(e) => handleDelete(file, e)}
                    title="Delete"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3,6 5,6 21,6" />
                      <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Status bar */}
        <div className="fm-statusbar">
          {files.length} items
          {selectedFile && ` - ${files.find(f => f.path === selectedFile)?.name || ''}`}
        </div>
      </div>
    </div>
  )
}
