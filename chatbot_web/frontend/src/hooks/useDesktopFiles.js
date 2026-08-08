import { useState, useEffect, useCallback } from 'react'

const DESKTOP_PATH = '/home/user/workspace/desktop'
const POLL_INTERVAL = 3000 // 3 seconds

export const useDesktopFiles = (sandboxId) => {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchDesktopFiles = useCallback(async () => {
    if (!sandboxId) {
      setLoading(false)
      return
    }

    try {
      const response = await fetch(`/api/fs/list?path=${encodeURIComponent(DESKTOP_PATH)}&sandbox_id=${sandboxId}`, {
        credentials: 'include',
      })

      if (!response.ok) {
        // Desktop folder might not exist yet
        if (response.status === 404) {
          setFiles([])
          setError(null)
          setLoading(false)
          return
        }
        throw new Error(`Failed to fetch desktop files: ${response.status}`)
      }

      const data = await response.json()
      setFiles(data.files || [])
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [sandboxId])

  // Initial fetch and polling
  useEffect(() => {
    fetchDesktopFiles()

    const intervalId = setInterval(fetchDesktopFiles, POLL_INTERVAL)
    return () => clearInterval(intervalId)
  }, [fetchDesktopFiles])

  // Listen for immediate refresh requests (e.g. after file upload)
  useEffect(() => {
    const onChanged = () => fetchDesktopFiles()
    window.addEventListener('desktop-files-changed', onChanged)
    return () => window.removeEventListener('desktop-files-changed', onChanged)
  }, [fetchDesktopFiles])

  const refresh = useCallback(() => {
    fetchDesktopFiles()
  }, [fetchDesktopFiles])

  return { files, loading, error, refresh, desktopPath: DESKTOP_PATH }
}

export default useDesktopFiles
