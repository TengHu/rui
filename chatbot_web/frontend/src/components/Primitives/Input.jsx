/**
 * Input primitive - text input field with state binding
 *
 * Props from spec:
 * - placeholder: string
 * - key: string (state key to bind value to)
 * - multiline: boolean (render as textarea)
 * - rows: number (for multiline)
 * - actionId: string (action to trigger on Enter)
 */

import { useState, useEffect } from 'react'
import './Primitives.css'

export function Input({
  placeholder = '',
  stateKey,
  multiline = false,
  rows = 3,
  actionId,
  state,
  onAction,
  onStateChange,
}) {
  // Initialize from state if available
  const [localValue, setLocalValue] = useState('')

  useEffect(() => {
    if (stateKey && state?.data?.[stateKey] !== undefined) {
      setLocalValue(state.data[stateKey])
    }
  }, [stateKey, state?.data])

  const handleChange = (e) => {
    const newValue = e.target.value
    setLocalValue(newValue)

    // Update state immediately for real-time binding
    if (stateKey && onStateChange) {
      onStateChange(stateKey, newValue)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !multiline && actionId && onAction) {
      e.preventDefault()
      onAction({
        actionId,
        payload: { key: stateKey, value: localValue },
      })
      // Clear input after action (for add_item type actions)
      setLocalValue('')
    }
  }

  const commonProps = {
    className: 'spec-input',
    placeholder,
    value: localValue,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
  }

  if (multiline) {
    return <textarea {...commonProps} rows={rows} />
  }

  return <input type="text" {...commonProps} />
}
