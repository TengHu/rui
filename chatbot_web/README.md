# Chatbot Web - React Frontend

React-based desktop OS interface for interacting with the E2B Sandbox Agent.

## Frontend Quick Start

### Install Dependencies

```bash
cd chatbot_web/frontend
npm install
```

### Development Server

```bash
# Start Vite dev server (with hot reload)
npm run dev

# Server will start at http://localhost:5173
# API requests are proxied to Flask backend at http://localhost:5001
```

### Production Build

```bash
# Build optimized production bundle
npm run build

# Output will be in frontend/dist/
# Flask will serve this in production
```

## Tech Stack

- **React 18.3.1** - UI framework with hooks
- **Vite 7.3.1** - Build tool and dev server
- **react-rnd 10.4.1** - Draggable/resizable windows
- **framer-motion 11.0.0** - Animations
- **prism-react-renderer 2.3.1** - Code syntax highlighting

## Project Structure

```
frontend/
├── src/
│   ├── components/          # React components
│   │   ├── Desktop/         # Desktop environment
│   │   ├── Window/          # Draggable windows
│   │   ├── ChatPanel/       # Chat display
│   │   ├── ChatInput/       # Message input
│   │   ├── Taskbar/         # Window taskbar
│   │   ├── StickyNote/      # Sticky notes
│   │   └── WindowContents/  # Content viewers
│   ├── context/             # React Context providers
│   ├── hooks/               # Custom hooks (SSE, etc.)
│   └── utils/               # Utilities and constants
├── vite.config.js           # Vite config with API proxy
└── package.json             # Dependencies
```

## Vite Proxy Configuration

In development, Vite proxies `/api/*` requests to Flask:

```javascript
// vite.config.js
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true,
      }
    }
  }
})
```

## Full Documentation

For complete documentation including:
- Architecture overview
- Backend setup
- Local development guide
- Production deployment
- Event streaming system
- API endpoints

See the [Root README](../README.md)
