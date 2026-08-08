/**
 * Text primitive - displays text with optional interpolation
 *
 * Props from spec:
 * - content: string (supports {{key}} interpolation from state)
 * - fontSize: string (e.g., "16px", "1.2em")
 * - fontWeight: string (e.g., "bold", "normal", "600")
 * - color: string (e.g., "#333", "red")
 */

import './Primitives.css'

export function Text({ content = '', fontSize, fontWeight, color, state }) {
  // Handle template interpolation {{key}}
  const rendered = content.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    // Check state.data first, then state.derived
    if (state?.data?.[key] !== undefined) {
      return String(state.data[key])
    }
    if (state?.derived?.[key] !== undefined) {
      return String(state.derived[key])
    }
    return '0' // Default for missing values
  })

  const style = {
    fontSize,
    fontWeight,
    color,
  }

  return (
    <span className="spec-text" style={style}>
      {rendered}
    </span>
  )
}
