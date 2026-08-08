/**
 * Panel primitive - container for layout
 *
 * Props from spec:
 * - direction: "row" | "column"
 * - gap: string (e.g., "8px", "1rem")
 * - align: "start" | "center" | "end" | "stretch"
 * - justify: "start" | "center" | "end" | "space-between"
 * - padding: string
 */

import './Primitives.css'

export function Panel({
  direction = 'column',
  gap = '8px',
  align = 'stretch',
  justify = 'start',
  padding,
  children,
}) {
  const alignMap = {
    start: 'flex-start',
    center: 'center',
    end: 'flex-end',
    stretch: 'stretch',
  }

  const justifyMap = {
    start: 'flex-start',
    center: 'center',
    end: 'flex-end',
    'space-between': 'space-between',
  }

  const style = {
    display: 'flex',
    flexDirection: direction,
    gap,
    alignItems: alignMap[align] || align,
    justifyContent: justifyMap[justify] || justify,
    padding,
  }

  return (
    <div className="spec-panel" style={style}>
      {children}
    </div>
  )
}
