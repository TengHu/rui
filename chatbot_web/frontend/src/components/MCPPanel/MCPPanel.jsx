import { useState, useEffect, useCallback, useRef } from 'react'
import { useChat } from '../../context/ChatContext'
import { E2B_DOMAIN, E2B_FALLBACK_DOMAINS } from '../../utils/constants'
import './MCPPanel.css'

const POLL_INTERVAL = 5000

const MCPPanel = () => {
  const { sandboxId, sandboxReady } = useChat()

  const [healthData, setHealthData] = useState(null)
  const [toolDetails, setToolDetails] = useState({}) // toolName -> { description, inputSchema }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [expandedApps, setExpandedApps] = useState({})
  const [refreshing, setRefreshing] = useState(false)
  const [lastFetched, setLastFetched] = useState(null)
  const [resolvedDomain, setResolvedDomain] = useState(null)
  const pollRef = useRef(null)

  const getMcpBaseUrl = useCallback(() => {
    if (!sandboxId) return null
    const domain = resolvedDomain || E2B_DOMAIN
    return `https://3000-${sandboxId}.${domain}`
  }, [sandboxId, resolvedDomain])

  const resolveBaseUrl = useCallback(async () => {
    if (!sandboxId) return null
    for (const domain of E2B_FALLBACK_DOMAINS) {
      try {
        const baseUrl = `https://3000-${sandboxId}.${domain}`
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(3000)
        })
        if (response.ok) {
          setResolvedDomain(domain)
          return baseUrl
        }
      } catch {
        // Try next domain
      }
    }
    return getMcpBaseUrl()
  }, [sandboxId, getMcpBaseUrl])

  // Fetch health data from MCP server
  const fetchHealth = useCallback(async (showSpinner = false) => {
    const baseUrl = await resolveBaseUrl()
    if (!baseUrl) return

    if (showSpinner) setRefreshing(true)

    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`)
      }

      const data = await response.json()
      setHealthData(data)
      setError(null)
      setLastFetched(new Date())
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message)
        setHealthData(null)
      }
    } finally {
      if (showSpinner) setRefreshing(false)
      setLoading(false)
    }
  }, [getMcpBaseUrl])

  // Fetch tool details using MCP protocol's tools/list via backend proxy
  const fetchToolDetails = useCallback(async () => {
    if (!sandboxId) return

    try {
      const response = await fetch(`/api/route-windows/sandbox/${sandboxId}/mcp-tools`, {
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
      })

      if (response.ok) {
        const data = await response.json()
        const tools = data.tools || []
        const details = {}
        for (const tool of tools) {
          details[tool.name] = {
            description: tool.description || '',
            inputSchema: tool.inputSchema || null
          }
        }
        setToolDetails(details)
        setError(null) // Clear any previous errors
      } else if (response.status === 503) {
        // MCP server not started yet - this is expected before first chat
        setError('MCP server not started yet')
      } else if (response.status === 502) {
        // Bad gateway - MCP server may be unreachable
        setError('MCP server unreachable')
      } else {
        const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }))
        setError(errorData.detail || 'Failed to fetch tools')
      }
    } catch (err) {
      // Tool details are supplementary - don't fail on error
      if (err.name !== 'AbortError') {
        console.warn('Failed to fetch tool details:', err)
        setError('Connection failed')
      }
    }
  }, [sandboxId])

  // Initial load
  useEffect(() => {
    if (!sandboxReady || !sandboxId) return

    setLoading(true)
    fetchHealth()
    fetchToolDetails()
  }, [sandboxReady, sandboxId, fetchHealth, fetchToolDetails])

  // Polling
  useEffect(() => {
    if (!sandboxReady || !sandboxId) return

    pollRef.current = setInterval(() => {
      fetchHealth()
      fetchToolDetails()
    }, POLL_INTERVAL)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [sandboxReady, sandboxId, fetchHealth, fetchToolDetails])

  const handleRefresh = () => {
    fetchHealth(true)
    fetchToolDetails()
  }

  const toggleApp = (appName) => {
    setExpandedApps(prev => ({
      ...prev,
      [appName]: !prev[appName]
    }))
  }

  // Build a map of tool -> app name for the tools directory
  const toolToApp = {}
  if (healthData?.apps) {
    for (const [appName, appData] of Object.entries(healthData.apps)) {
      for (const toolName of (appData.tools || [])) {
        toolToApp[toolName] = appName
      }
    }
  }

  // Not ready state
  if (!sandboxReady || !sandboxId) {
    return (
      <div className="mcp-panel">
        <div className="mcp-empty-state">
          <div className="mcp-empty-icon">🔌</div>
          <div className="mcp-empty-text">No sandbox connected</div>
          <div className="mcp-empty-hint">
            A sandbox must be running for the MCP server to be available
          </div>
        </div>
      </div>
    )
  }

  // Loading state
  if (loading && !healthData) {
    return (
      <div className="mcp-panel">
        <div className="mcp-loading">
          <div className="mcp-loading-spinner" />
          <span>Connecting to MCP server...</span>
        </div>
      </div>
    )
  }

  const isOnline = healthData?.status === 'ok'
  const apps = healthData?.apps || {}
  const appEntries = Object.entries(apps)
  const allTools = healthData?.tools || []
  const allResources = healthData?.resources || []

  return (
    <div className="mcp-panel">
      {/* Header */}
      <div className="mcp-header">
        <div className="mcp-header-left">
          <div className={`mcp-status-badge ${isOnline ? 'online' : 'offline'}`}>
            <div className="mcp-status-dot" />
            {isOnline ? 'Online' : 'Offline'}
          </div>
          {isOnline && (
            <span className="mcp-header-info">
              port {healthData.port} &middot; {healthData.registeredApps || 0} app{(healthData.registeredApps || 0) !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button
          className={`mcp-refresh-btn ${refreshing ? 'spinning' : ''}`}
          onClick={handleRefresh}
          title="Refresh"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="mcp-body">
        {!isOnline && error ? (
          <div className="mcp-empty-state">
            <div className="mcp-empty-icon">⚠️</div>
            <div className="mcp-empty-text">Cannot reach MCP server</div>
            <div className="mcp-empty-hint">{error}</div>
          </div>
        ) : (
          <>
            {/* Apps section */}
            <div className="mcp-section-title">
              Registered Apps ({appEntries.length})
            </div>

            {appEntries.length === 0 ? (
              <div className="mcp-app-card">
                <div className="mcp-app-card-header" style={{ cursor: 'default', color: '#585b70' }}>
                  No apps registered yet
                </div>
              </div>
            ) : (
              appEntries.map(([appName, appData]) => {
                const isExpanded = expandedApps[appName]
                const hasUI = appData.resourceUri != null
                const appTools = appData.tools || []
                const registeredAt = appData.registeredAt
                  ? new Date(appData.registeredAt).toLocaleTimeString()
                  : null

                return (
                  <div key={appName} className="mcp-app-card">
                    <div className="mcp-app-card-header" onClick={() => toggleApp(appName)}>
                      <span className="mcp-app-icon">📦</span>
                      <div className="mcp-app-info">
                        <div className="mcp-app-name">{appName}</div>
                        <div className="mcp-app-meta">
                          <span className="mcp-app-badge tools">
                            🔧 {appTools.length} tool{appTools.length !== 1 ? 's' : ''}
                          </span>
                          {hasUI && (
                            <span className="mcp-app-badge ui">🎨 UI</span>
                          )}
                          {registeredAt && (
                            <span className="mcp-app-time">{registeredAt}</span>
                          )}
                        </div>
                      </div>
                      <span className={`mcp-app-expand ${isExpanded ? 'open' : ''}`}>
                        ▶
                      </span>
                    </div>

                    {isExpanded && appTools.length > 0 && (
                      <div className="mcp-app-tools">
                        {appTools.map(toolName => {
                          const detail = toolDetails[toolName]
                          return (
                            <div key={toolName} className="mcp-tool-item">
                              <span className="mcp-tool-icon">⚙</span>
                              <div className="mcp-tool-info">
                                <div className="mcp-tool-name">{toolName}</div>
                                {detail?.description && (
                                  <div className="mcp-tool-desc">{detail.description}</div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })
            )}

            {/* Tools directory */}
            {allTools.length > 0 && (
              <>
                <div className="mcp-section-title">
                  All Tools ({allTools.length})
                </div>
                <table className="mcp-tools-table">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>App</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allTools.map(toolName => {
                      const detail = toolDetails[toolName]
                      return (
                        <tr key={toolName}>
                          <td className="tool-name-cell">{toolName}</td>
                          <td className="tool-app-cell">{toolToApp[toolName] || '—'}</td>
                          <td className="tool-desc-cell">
                            {detail?.description || '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>
            )}

            {/* Resources */}
            {allResources.length > 0 && (
              <>
                <div className="mcp-section-title">
                  Resources ({allResources.length})
                </div>
                <table className="mcp-tools-table">
                  <thead>
                    <tr>
                      <th>URI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allResources.map(uri => (
                      <tr key={uri}>
                        <td className="tool-name-cell">{uri}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="mcp-footer">
        <span>
          {allTools.length} tool{allTools.length !== 1 ? 's' : ''} &middot; {allResources.length} resource{allResources.length !== 1 ? 's' : ''}
        </span>
        <span>
          {lastFetched ? `Updated ${lastFetched.toLocaleTimeString()}` : ''}
        </span>
      </div>
    </div>
  )
}

export default MCPPanel
