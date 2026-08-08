import { useState } from 'react'
import { Rnd } from 'react-rnd'
import './StickyNote.css'

const StickyNote = ({ note, onUpdate, onDelete }) => {
  const [content, setContent] = useState(note.content)
  const isTutorial = note.isTutorial

  const handleBlur = () => {
    if (content !== note.content) {
      onUpdate(note.id, content, note.position)
    }
  }

  const handleDragStop = (e, data) => {
    onUpdate(note.id, isTutorial ? note.content : content, { x: data.x, y: data.y })
  }

  // Parse tutorial content into title and body
  const parseTutorialContent = (text) => {
    const lines = text.split('\n')
    const title = lines[0] || ''
    const body = lines.slice(1).join('\n').trim()
    return { title, body }
  }

  return (
    <Rnd
      position={{
        x: note.position.x,
        y: note.position.y
      }}
      size={{
        width: isTutorial ? 240 : 200,
        height: isTutorial ? 160 : 200,
      }}
      minWidth={150}
      minHeight={isTutorial ? 120 : 150}
      bounds="parent"
      onDragStop={handleDragStop}
      enableResizing={false}
      dragHandleClassName="sticky-note-header"
    >
      <div className={`sticky-note ${isTutorial ? 'sticky-note--tutorial' : ''}`} style={{ background: note.color || '#fef08a' }}>
        <div className="sticky-note-header">
          {isTutorial && note.icon && (
            <span className="sticky-note-icon-badge">{note.icon}</span>
          )}
          <button
            className="sticky-note-close"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(note.id)
            }}
            title={isTutorial ? 'Dismiss tip' : 'Delete note'}
          >
            ×
          </button>
        </div>
        {isTutorial ? (
          <div className="sticky-note-tutorial-content">
            <div className="sticky-note-tutorial-title">
              {parseTutorialContent(note.content).title}
            </div>
            <div className="sticky-note-tutorial-body">
              {parseTutorialContent(note.content).body}
            </div>
          </div>
        ) : (
          <textarea
            className="sticky-note-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onBlur={handleBlur}
            placeholder="Write a note..."
          />
        )}
      </div>
    </Rnd>
  )
}

export default StickyNote
