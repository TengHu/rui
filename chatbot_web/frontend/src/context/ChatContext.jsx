import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { useAuth } from './AuthContext'
import { generateUUID, getNavigationType } from '../utils/constants'

const ChatContext = createContext()

export const useChat = () => {
  const context = useContext(ChatContext)
  if (!context) {
    throw new Error('useChat must be used within ChatProvider')
  }
  return context
}

export const ChatProvider = ({ children }) => {
  const { user } = useAuth()

  const [conversationId, setConversationId] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [sandboxReady, setSandboxReady] = useState(false)
  const [sandboxId, setSandboxId] = useState(null)
  const [chatStarted, setChatStarted] = useState(false)
  const [sandboxError, setSandboxError] = useState(false)
  const [sandboxEndAt, setSandboxEndAt] = useState(null)

  // Initialize conversation ID from sessionStorage or create new one
  useEffect(() => {
    const storedConversationId = sessionStorage.getItem('conversation_id')
    const navigationType = getNavigationType()

    let newConversationId = storedConversationId || generateUUID()

    if (storedConversationId && navigationType !== 'reload') {
      // New tab/navigation - create new conversation
      newConversationId = generateUUID()
      sessionStorage.setItem('conversation_id', newConversationId)
      sessionStorage.removeItem('sandbox_ready')
      sessionStorage.removeItem('sandbox_id')
      sessionStorage.removeItem('sandbox_end_at')
    } else if (!storedConversationId) {
      sessionStorage.setItem('conversation_id', newConversationId)
    }

    setConversationId(newConversationId)

    // On reload, don't trust cached sandbox - always verify/recreate
    if (navigationType === 'reload') {
      sessionStorage.removeItem('sandbox_ready')
      sessionStorage.removeItem('sandbox_id')
      sessionStorage.removeItem('sandbox_end_at')
      setSandboxReady(false)
      setSandboxId(null)
      setSandboxEndAt(null)
      setChatStarted(false)
    } else {
      const savedSandboxReady = sessionStorage.getItem('sandbox_ready') === 'true'
      const savedSandboxId = sessionStorage.getItem('sandbox_id')
      const savedEndAt = sessionStorage.getItem('sandbox_end_at')

      setSandboxReady(savedSandboxReady)
      setSandboxId(savedSandboxId)
      setSandboxEndAt(savedEndAt || null)
      setChatStarted(savedSandboxReady)
    }
  }, [])

  // Automatically create sandbox when user is authenticated
  useEffect(() => {
    if (!conversationId || sandboxReady || isLoading || !user || sandboxError) return

    const initSandbox = async () => {
      setIsLoading(true)

      try {
        const response = await fetch('/api/sandbox/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ conversation_id: conversationId }),
        })

        const data = await response.json()

        if (data.success) {
          setSandboxReady(true)
          setSandboxId(data.sandbox_id)
          sessionStorage.setItem('sandbox_ready', 'true')
          if (data.sandbox_id) {
            sessionStorage.setItem('sandbox_id', data.sandbox_id)
            try {
              const infoResponse = await fetch(
                `/api/sandbox/info?sandbox_id=${encodeURIComponent(data.sandbox_id)}`,
                { credentials: 'include' }
              )
              const infoData = await infoResponse.json()
              if (infoData.success && infoData.end_at) {
                setSandboxEndAt(infoData.end_at)
                sessionStorage.setItem('sandbox_end_at', infoData.end_at)
              }
            } catch (infoError) {
              // sandbox info fetch is non-critical
            }
          }
        } else {
          setSandboxError(true)
        }
      } catch (error) {
        setSandboxError(true)
      } finally {
        setIsLoading(false)
      }
    }

    initSandbox()
  }, [conversationId, sandboxReady, isLoading, user, sandboxError])

  const createSandbox = useCallback(async () => {
    if (!conversationId) return

    setIsLoading(true)

    try {
      const response = await fetch('/api/sandbox/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ conversation_id: conversationId }),
      })

      const data = await response.json()

      if (data.success) {
        setSandboxReady(true)
        setSandboxId(data.sandbox_id)
        sessionStorage.setItem('sandbox_ready', 'true')
        if (data.sandbox_id) {
          sessionStorage.setItem('sandbox_id', data.sandbox_id)
          try {
            const infoResponse = await fetch(
              `/api/sandbox/info?sandbox_id=${encodeURIComponent(data.sandbox_id)}`,
              { credentials: 'include' }
            )
            const infoData = await infoResponse.json()
            if (infoData.success && infoData.end_at) {
              setSandboxEndAt(infoData.end_at)
              sessionStorage.setItem('sandbox_end_at', infoData.end_at)
            }
          } catch (infoError) {
            // non-critical
          }
        }
      }
    } catch (error) {
      // sandbox creation failed
    } finally {
      setIsLoading(false)
    }
  }, [conversationId])

  const value = {
    conversationId,
    isLoading,
    sandboxReady,
    sandboxError,
    sandboxId,
    sandboxEndAt,
    chatStarted,
    createSandbox,
    setChatStarted,
  }

  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  )
}
