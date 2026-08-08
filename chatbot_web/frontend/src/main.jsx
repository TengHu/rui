import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initPostHog } from './utils/posthog'

initPostHog()

createRoot(document.getElementById('root')).render(
  <App />,
)
