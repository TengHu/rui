import { useState, useEffect, useCallback } from 'react'

const POLL_INTERVAL = 5000 // 5 seconds

export const useAppRegistry = (sandboxId) => {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchRegistry = useCallback(async () => {
    if (!sandboxId) {
      setLoading(false)
      return
    }

    try {
      const response = await fetch(
        `/api/common-app-registry?sandbox_id=${encodeURIComponent(sandboxId)}`,
        { credentials: 'include' }
      )

      if (!response.ok) {
        setLoading(false)
        return
      }

      const data = await response.json()
      if (data.success) {
        setApps(data.apps || [])
      }
    } catch {
      // Silently ignore fetch errors — registry may not exist yet
    } finally {
      setLoading(false)
    }
  }, [sandboxId])

  useEffect(() => {
    if (!sandboxId) {
      setLoading(false)
      return
    }

    fetchRegistry()

    const intervalId = setInterval(fetchRegistry, POLL_INTERVAL)
    return () => clearInterval(intervalId)
  }, [sandboxId, fetchRegistry])

  const refresh = useCallback(() => {
    fetchRegistry()
  }, [fetchRegistry])

  return { apps, loading, refresh }
}

export default useAppRegistry
