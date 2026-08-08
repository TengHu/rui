// Window type constants
export const WINDOW_TYPES = {
  FILE_VIEWER: 'FILE_VIEWER',
  FILE_MANAGER: 'FILE_MANAGER',
  IMAGE_VIEWER: 'IMAGE_VIEWER',
  WEB_APP: 'WEB_APP',
  CODE_EDITOR: 'CODE_EDITOR',
  VISUALIZATION: 'VISUALIZATION',
  SEARCH_RESULTS: 'SEARCH_RESULTS',
  TERMINAL: 'TERMINAL',
  SPEC: 'SPEC',  // Spec-based composable windows
  MCP_PANEL: 'MCP_PANEL',
  APP_ECOSYSTEM: 'APP_ECOSYSTEM'
}

// Window icons for each type
export const WINDOW_ICONS = {
  [WINDOW_TYPES.FILE_VIEWER]: '\ud83d\udcc4',
  [WINDOW_TYPES.FILE_MANAGER]: '\ud83d\udcc1',
  [WINDOW_TYPES.IMAGE_VIEWER]: '\ud83d\uddbc\ufe0f',
  [WINDOW_TYPES.WEB_APP]: '\ud83c\udf10',
  [WINDOW_TYPES.CODE_EDITOR]: '\ud83d\udcbb',
  [WINDOW_TYPES.VISUALIZATION]: '\ud83d\udcca',
  [WINDOW_TYPES.SEARCH_RESULTS]: '\ud83d\udd0d',
  [WINDOW_TYPES.TERMINAL]: '\u26a1',
  [WINDOW_TYPES.SPEC]: '\ud83e\ude9f',
  SPEC: '\ud83e\ude9f',  // Also make available as WINDOW_ICONS.SPEC
  [WINDOW_TYPES.MCP_PANEL]: '\ud83d\udd0c',
  [WINDOW_TYPES.APP_ECOSYSTEM]: '\ud83e\udde9'
}

// Default window sizes
export const DEFAULT_WINDOW_SIZE = {
  width: 600,
  height: 400
}

export const MIN_WINDOW_SIZE = {
  width: 300,
  height: 200
}

// Window positioning helper - cascade new windows
let windowOffset = 0
export const getNewWindowPosition = () => {
  windowOffset = (windowOffset + 30) % 150
  return {
    x: 100 + windowOffset,
    y: 80 + windowOffset
  }
}

export const resetWindowOffset = () => {
  windowOffset = 0
}
