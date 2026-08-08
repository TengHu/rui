/**
 * SpecWindow - Wrapper component for spec-based windows
 *
 * This component wraps the SpecRenderer and handles:
 * - Action execution via API
 * - State updates
 */

import { useCallback, useState } from 'react'
import SpecRenderer from '../SpecRenderer/SpecRenderer'
import './SpecWindow.css'

export function SpecWindow({
  windowRecord,
  onAction,
  onStateChange,
}) {
  const [isLoading, setIsLoading] = useState(false)

  const handleAction = useCallback(async ({ actionId, payload = {} }) => {
    if (!actionId) return

    setIsLoading(true)
    try {
      await onAction?.(windowRecord.id, actionId, payload)
    } catch (error) {
      console.error('Action failed:', error)
    } finally {
      setIsLoading(false)
    }
  }, [windowRecord.id, onAction])

  const handleStateChange = useCallback((key, value) => {
    onStateChange?.(windowRecord.id, key, value)
  }, [windowRecord.id, onStateChange])

  return (
    <div className={`spec-window ${isLoading ? 'loading' : ''}`}>
      <SpecRenderer
        spec={windowRecord.spec}
        state={windowRecord.state}
        onAction={handleAction}
        onStateChange={handleStateChange}
      />

      {isLoading && (
        <div className="spec-window-loading">
          <div className="spec-window-spinner" />
        </div>
      )}
    </div>
  )
}

export default SpecWindow
