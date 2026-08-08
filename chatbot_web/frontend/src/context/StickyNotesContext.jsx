import { createContext, useContext, useState, useEffect } from 'react'
import { useAuth } from './AuthContext'
import { generateUUID } from '../utils/constants'

const StickyNotesContext = createContext()

export const useStickyNotes = () => {
  const context = useContext(StickyNotesContext)
  if (!context) {
    throw new Error('useStickyNotes must be used within StickyNotesProvider')
  }
  return context
}

// Positions are computed relative to viewport center on first render
const getDefaultNotes = () => {
  const cx = Math.round(window.innerWidth / 2)
  const cy = Math.round(window.innerHeight / 2)
  return [
    {
      id: 'tutorial-1',
      content: "Drag & Drop Files\n\nDrag files from your computer and drop them onto the desktop to upload.",
      position: { x: cx - 350, y: cy - 200 },
      color: '#dbeafe',
      isTutorial: true,
      icon: '📂'
    },
    {
      id: 'tutorial-2',
      content: "Open & Customize Apps\n\nDouble-click an app icon to open it. Use the chat panel to customize it.",
      position: { x: cx - 50, y: cy - 220 },
      color: '#fef3c7',
      isTutorial: true,
      icon: '💬'
    },
    {
      id: 'tutorial-3',
      content: "Create a New App\n\nClick the + button at the bottom-right to create a brand new app from scratch.",
      position: { x: cx - 200, y: cy + 10 },
      color: '#d1fae5',
      isTutorial: true,
      icon: '✨'
    }
  ]
}

export const StickyNotesProvider = ({ children }) => {
  const { user, authLoading } = useAuth()
  const [notes, setNotes] = useState([])

  const storageKey = user ? `desktop_sticky_notes_${user.id}` : null

  useEffect(() => {
    if (authLoading) return

    if (!storageKey) {
      setNotes([])
      return
    }

    const savedNotes = localStorage.getItem(storageKey)
    if (savedNotes) {
      try {
        setNotes(JSON.parse(savedNotes))
      } catch (e) {
        console.error('Failed to load sticky notes:', e)
        setNotes(getDefaultNotes())
      }
    } else {
      setNotes(getDefaultNotes())
    }
  }, [authLoading, storageKey])

  useEffect(() => {
    if (!storageKey) return
    if (notes.length > 0) {
      localStorage.setItem(storageKey, JSON.stringify(notes))
    }
  }, [notes, storageKey])

  const createNote = (position) => {
    const newNote = {
      id: `note-${generateUUID()}`,
      content: '',
      position: position || { x: Math.round(window.innerWidth / 2) - 100, y: Math.round(window.innerHeight / 2) - 100 },
      color: '#fef08a'
    }
    setNotes(prev => [...prev, newNote])
  }

  const updateNote = (id, content, position) => {
    setNotes(prev => prev.map(note =>
      note.id === id
        ? { ...note, content, position: position || note.position }
        : note
    ))
  }

  const deleteNote = (id) => {
    setNotes(prev => prev.filter(note => note.id !== id))
  }

  const value = {
    notes,
    createNote,
    updateNote,
    deleteNote
  }

  return (
    <StickyNotesContext.Provider value={value}>
      {children}
    </StickyNotesContext.Provider>
  )
}
