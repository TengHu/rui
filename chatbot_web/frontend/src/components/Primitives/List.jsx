/**
 * List primitive - displays a list of items from state
 *
 * Props from spec:
 * - itemsKey: string (state key containing the array)
 * - itemTemplate: "default" | "checkbox" | "count" (how to render items)
 */

import './Primitives.css'

export function List({
  itemsKey = 'items',
  itemTemplate = 'default',
  state,
  onAction,
}) {
  // Get items from state.data or state.derived (for bound data)
  const items = state?.data?.[itemsKey] || state?.derived?.boundData || []

  const handleRemove = (index) => {
    if (onAction) {
      onAction({
        actionId: 'remove_item',
        payload: { key: itemsKey, index },
      })
    }
  }

  const renderItem = (item, index) => {
    // Handle different item shapes
    const isObject = typeof item === 'object' && item !== null

    switch (itemTemplate) {
      case 'checkbox':
        return (
          <li key={index} className="spec-list-item spec-list-item-checkbox">
            <input type="checkbox" className="spec-checkbox" />
            <span className="spec-list-item-text">
              {isObject ? item.text || item.name || JSON.stringify(item) : String(item)}
            </span>
            <button
              className="spec-list-remove"
              onClick={() => handleRemove(index)}
              title="Remove"
            >
              &times;
            </button>
          </li>
        )

      case 'count':
        // For aggregated data like {item: "text", count: 5}
        return (
          <li key={index} className="spec-list-item spec-list-item-count">
            <span className="spec-list-item-text">
              {isObject ? item.item || item.name : String(item)}
            </span>
            <span className="spec-list-item-badge">
              {isObject && item.count !== undefined ? item.count : 1}
            </span>
          </li>
        )

      default:
        return (
          <li key={index} className="spec-list-item">
            <span className="spec-list-item-text">
              {isObject ? item.text || item.name || JSON.stringify(item) : String(item)}
            </span>
            <button
              className="spec-list-remove"
              onClick={() => handleRemove(index)}
              title="Remove"
            >
              &times;
            </button>
          </li>
        )
    }
  }

  if (!items || items.length === 0) {
    return (
      <div className="spec-list-empty">
        No items yet
      </div>
    )
  }

  return (
    <ul className="spec-list">
      {items.map((item, index) => renderItem(item, index))}
    </ul>
  )
}
