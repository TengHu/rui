/**
 * Dock - Mac-style dock at the bottom of the screen
 *
 * Shows minimized RouteWindows as icons that can be clicked to restore.
 * For common windows with a registered app, shows the app's SVG logo.
 * Has the characteristic Mac dock magnification effect on hover.
 */

import './Dock.css'

const AppLogo = ({ svg, size = 32 }) => {
  if (!svg) return null
  const encoded = encodeURIComponent(svg)
  return (
    <img
      className="dock-item-app-logo"
      src={`data:image/svg+xml,${encoded}`}
      width={size}
      height={size}
      alt=""
    />
  )
}

const DockItem = ({ window, appEntry, onClick }) => {
  const hasLogo = appEntry && appEntry.logo

  return (
    <div
      className="dock-item"
      onClick={() => onClick(window.id)}
      title={window.title}
    >
      <div className={`dock-item-icon ${hasLogo ? 'dock-item-icon-app' : ''}`}>
        {hasLogo
          ? <AppLogo svg={appEntry.logo} />
          : <span className="dock-item-icon-text">{">"}_</span>
        }
      </div>
      <div className="dock-item-label">{window.title}</div>
      <div className="dock-item-indicator" />
    </div>
  )
}

const Dock = ({ minimizedWindows, onRestore, appRegistry = [] }) => {
  if (minimizedWindows.length === 0) {
    return null
  }

  return (
    <div className="dock-container">
      <div className="dock">
        {minimizedWindows.map(window => {
          // Look up the app registry entry for common windows by port
          const appEntry = window.window_type === 'common' && window.port
            ? appRegistry.find(app => app.port === window.port)
            : null

          return (
            <DockItem
              key={window.id}
              window={window}
              appEntry={appEntry}
              onClick={onRestore}
            />
          )
        })}
      </div>
    </div>
  )
}

export default Dock
