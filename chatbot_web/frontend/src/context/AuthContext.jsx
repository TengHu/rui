import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { posthog } from '../utils/posthog'

const AuthContext = createContext()

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authError, setAuthError] = useState(null)

  // On mount: check existing session via GET /api/auth/me
  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await fetch('/api/auth/me', { credentials: 'include' })
        const data = await response.json()
        if (data.user) {
          setUser(data.user)
          posthog.identify(data.user.id || data.user.email, {
            email: data.user.email,
            name: data.user.name,
          })
        }
      } catch (err) {
        // Not authenticated — that's fine
      } finally {
        setAuthLoading(false)
      }
    }
    checkSession()
  }, [])

  const login = useCallback(() => {
    setAuthError(null)
    // GET /api/auth/login redirects to Google directly
    // Pass return_to so the callback redirects back to the correct frontend origin
    window.location.href = `/api/auth/login?return_to=${encodeURIComponent(window.location.origin)}`
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      })
    } catch (err) {
      // best-effort
    }
    posthog.reset()
    setUser(null)
    sessionStorage.clear()
  }, [])

  const value = {
    user,
    authLoading,
    authError,
    login,
    logout,
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}
