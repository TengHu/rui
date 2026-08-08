// App configuration constants
export const APP_CONFIG = {
  CHAT_PANEL_WIDTH: 400,
  CHAT_INPUT_MAX_WIDTH: 700,
  TASKBAR_HEIGHT: 60,
  STICKY_NOTE_SIZE: 200,
  MAX_OPEN_WINDOWS: 10
}

export const E2B_DOMAIN = import.meta.env.VITE_E2B_DOMAIN || 'e2b.app'
export const E2B_FALLBACK_DOMAINS = [E2B_DOMAIN, E2B_DOMAIN === 'e2b.app' ? 'e2b.dev' : 'e2b.app']

// Generate UUID for conversation IDs
export const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

// Get navigation type for detecting page reloads
export const getNavigationType = () => {
  const navEntries = performance.getEntriesByType?.('navigation')
  if (navEntries && navEntries.length) {
    return navEntries[0].type || 'navigate'
  }
  if (performance.navigation) {
    switch (performance.navigation.type) {
      case 1:
        return 'reload'
      case 2:
        return 'back_forward'
      default:
        return 'navigate'
    }
  }
  return 'navigate'
}

// Format timestamp for messages
export const getTimestamp = () => {
  const now = new Date()
  const hours = now.getHours().toString().padStart(2, '0')
  const minutes = now.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

// Extract E2B URLs from text
export const extractE2bUrl = (text) => {
  const e2bPattern = /https:\/\/\d+-[a-zA-Z0-9-]+\.e2b\.(?:app|dev)(?:\/[a-zA-Z0-9/_.-]*)?(?:\?[a-zA-Z0-9=&_.-]*)?/g
  const matches = text.match(e2bPattern)
  return matches ? matches[0] : null
}

// Check if file is an image
export const isImageFile = (filename) => {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp']
  const lowerName = filename.toLowerCase()
  return imageExtensions.some(ext => lowerName.endsWith(ext))
}

// Check if file is HTML
export const isHtmlFile = (filename) => {
  return filename.toLowerCase().endsWith('.html')
}
