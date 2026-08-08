import { AuthProvider } from './context/AuthContext'
import { WindowProvider } from './context/WindowContext'
import { ChatProvider } from './context/ChatContext'
import { StickyNotesProvider } from './context/StickyNotesContext'
import { SpecWindowProvider } from './context/SpecWindowContext'
import { RouteWindowProvider } from './context/RouteWindowContext'
import { SelectionProvider } from './context/SelectionContext'
import { ContextMenuProvider } from './components/ContextMenu'
import useKeyboardShortcuts from './hooks/useKeyboardShortcuts'
import Desktop from './components/Desktop/Desktop'
import './App.css'

// Component that uses keyboard shortcuts
const DesktopWithEventStream = () => {
  useKeyboardShortcuts()
  return <Desktop />
}

function App() {
  return (
    <AuthProvider>
      <ChatProvider>
        <WindowProvider>
          <StickyNotesProvider>
            <SpecWindowProvider>
              <RouteWindowProvider>
                <SelectionProvider>
                  <ContextMenuProvider>
                    <DesktopWithEventStream />
                  </ContextMenuProvider>
                </SelectionProvider>
              </RouteWindowProvider>
            </SpecWindowProvider>
          </StickyNotesProvider>
        </WindowProvider>
      </ChatProvider>
    </AuthProvider>
  )
}

export default App
