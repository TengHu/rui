/**
 * Button primitive - clickable button that triggers actions
 *
 * Props from spec:
 * - label: string
 * - variant: "primary" | "secondary" | "danger"
 * - actionId: string (action to trigger on click)
 */

import './Primitives.css'

export function Button({
  label = 'Button',
  variant = 'primary',
  actionId,
  onAction,
  disabled = false,
}) {
  const handleClick = () => {
    if (actionId && onAction) {
      onAction({ actionId, payload: {} })
    }
  }

  return (
    <button
      className={`spec-button spec-button-${variant}`}
      onClick={handleClick}
      disabled={disabled}
    >
      {label}
    </button>
  )
}
