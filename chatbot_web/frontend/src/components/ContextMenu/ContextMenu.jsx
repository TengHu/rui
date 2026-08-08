import { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react'
import './ContextMenu.css'

const ContextMenuContext = createContext()

export const useContextMenu = () => {
  const context = useContext(ContextMenuContext)
  if (!context) {
    throw new Error('useContextMenu must be used within ContextMenuProvider')
  }
  return context
}

export function ContextMenuProvider({ children }) {
  const [menu, setMenu] = useState(null)

  const showMenu = useCallback((x, y, items) => {
    setMenu({ x, y, items })
  }, [])

  const hideMenu = useCallback(() => {
    setMenu(null)
  }, [])

  // Hide menu on any click
  useEffect(() => {
    if (!menu) return

    const handleClick = () => hideMenu()
    const handleScroll = () => hideMenu()
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') hideMenu()
    }

    // Delay adding listeners to prevent immediate close
    const timeout = setTimeout(() => {
      window.addEventListener('click', handleClick)
      window.addEventListener('scroll', handleScroll, true)
      window.addEventListener('keydown', handleKeyDown)
    }, 10)

    return () => {
      clearTimeout(timeout)
      window.removeEventListener('click', handleClick)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [menu, hideMenu])

  return (
    <ContextMenuContext.Provider value={{ showMenu, hideMenu }}>
      {children}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={hideMenu}
        />
      )}
    </ContextMenuContext.Provider>
  )
}

function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null)
  const [position, setPosition] = useState({ x, y })
  const [submenu, setSubmenu] = useState(null)

  // Adjust position if menu would overflow viewport
  useEffect(() => {
    if (!menuRef.current) return

    const rect = menuRef.current.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let adjustedX = x
    let adjustedY = y

    // Adjust horizontal position
    if (x + rect.width > viewportWidth - 10) {
      adjustedX = viewportWidth - rect.width - 10
    }

    // Adjust vertical position
    if (y + rect.height > viewportHeight - 10) {
      adjustedY = viewportHeight - rect.height - 10
    }

    // Ensure minimum position
    adjustedX = Math.max(10, adjustedX)
    adjustedY = Math.max(10, adjustedY)

    if (adjustedX !== x || adjustedY !== y) {
      setPosition({ x: adjustedX, y: adjustedY })
    }
  }, [x, y])

  const handleItemClick = (item) => {
    if (item.disabled) return
    if (item.submenu) return // Don't close for submenu items

    if (item.action) {
      item.action()
    }
    onClose()
  }

  const handleItemMouseEnter = (item, index, e) => {
    if (item.submenu) {
      const rect = e.currentTarget.getBoundingClientRect()
      setSubmenu({
        items: item.submenu,
        x: rect.right,
        y: rect.top,
        parentIndex: index
      })
    } else {
      setSubmenu(null)
    }
  }

  return (
    <>
      <div
        ref={menuRef}
        className="context-menu"
        style={{ top: position.y, left: position.x }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => {
          if (item.divider) {
            return <div key={i} className="context-menu-divider" />
          }

          return (
            <div
              key={i}
              className={`context-menu-item ${item.disabled ? 'disabled' : ''} ${item.submenu ? 'has-submenu' : ''}`}
              onClick={() => handleItemClick(item)}
              onMouseEnter={(e) => handleItemMouseEnter(item, i, e)}
              onMouseLeave={() => !item.submenu && setSubmenu(null)}
            >
              {item.icon && <span className="context-menu-icon">{item.icon}</span>}
              <span className="context-menu-label">{item.label}</span>
              {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
              {item.submenu && <span className="context-menu-arrow">&#9654;</span>}
            </div>
          )
        })}
      </div>

      {/* Submenu */}
      {submenu && (
        <ContextMenu
          x={submenu.x}
          y={submenu.y}
          items={submenu.items}
          onClose={onClose}
        />
      )}
    </>
  )
}

export default ContextMenu
