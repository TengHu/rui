/**
 * Table primitive - displays tabular data
 *
 * Props from spec:
 * - dataKey: string (state key containing array of rows)
 * - columns: string[] (column names/headers)
 */

import './Primitives.css'

export function Table({
  dataKey = 'rows',
  columns = [],
  state,
}) {
  const rows = state?.data?.[dataKey] || state?.derived?.boundData || []

  // If no columns specified, infer from first row
  const effectiveColumns = columns.length > 0
    ? columns
    : rows.length > 0 && typeof rows[0] === 'object'
      ? Object.keys(rows[0])
      : ['Value']

  const getCellValue = (row, column) => {
    if (typeof row === 'object' && row !== null) {
      // Try column name as key (case-insensitive)
      const key = Object.keys(row).find(
        k => k.toLowerCase() === column.toLowerCase()
      )
      return key ? row[key] : ''
    }
    return String(row)
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="spec-table-empty">
        No data
      </div>
    )
  }

  return (
    <div className="spec-table-container">
      <table className="spec-table">
        <thead>
          <tr>
            {effectiveColumns.map((col, i) => (
              <th key={i}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {effectiveColumns.map((col, colIndex) => (
                <td key={colIndex}>{getCellValue(row, col)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
