import { useWindows } from '../../context/WindowContext'
import { WINDOW_ICONS } from '../../utils/windowTypes'
import './Taskbar.css'

const TaskbarItem = ({ window, isFocused, isMinimized, onClick }) => {
  return (
    <div
      className={`taskbar-item ${isFocused ? 'focused' : ''} ${isMinimized ? 'minimized' : ''}`}
      onClick={onClick}
      title={window.title}
    >
      <span className="taskbar-item-icon">{WINDOW_ICONS[window.type]}</span>
      <span className="taskbar-item-title">{window.title}</span>
      {isFocused && !isMinimized && <div className="taskbar-item-indicator"></div>}
    </div>
  )
}

const Taskbar = () => {
  const { windows, focusedWindowId, minimizedWindows, focusWindow, restoreWindow } = useWindows()

  const handleItemClick = (windowId) => {
    if (minimizedWindows.includes(windowId)) {
      restoreWindow(windowId)
    } else {
      focusWindow(windowId)
    }
  }

  return (
    <div className="taskbar">
      {/* Open windows */}
      <div className="taskbar-items">
        {windows.map(window => (
          <TaskbarItem
            key={window.id}
            window={window}
            isFocused={focusedWindowId === window.id}
            isMinimized={minimizedWindows.includes(window.id)}
            onClick={() => handleItemClick(window.id)}
          />
        ))}
      </div>
    </div>
  )
}

export default Taskbar
