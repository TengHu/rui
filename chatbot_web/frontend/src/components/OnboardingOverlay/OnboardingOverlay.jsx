import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../context/AuthContext'
import './OnboardingOverlay.css'

/**
 * OnboardingOverlay — 6-step experience shown on first login.
 *
 * Step 0: Welcome — "Watch AI build your first app"
 * Step 1: Auto-demo — builds a revenue management system; user watches
 * Step 2: Spotlight create-window button — "open another window"
 * Step 3: BTC app showcase — "double-click any app, modify with chat"
 * Step 4: Upload files tip card
 * Step 5: Done card — "Start building"
 *
 * Writes to localStorage so it only shows once per user.
 */

const DEMO_PROMPT = 'Build a revenue management system'

const buildMaskStyle = (rect, pad = 32) => {
  if (!rect) return {}
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const r = Math.max(rect.width, rect.height) / 2 + pad
  return {
    WebkitMaskImage: `radial-gradient(circle ${r}px at ${cx}px ${cy}px, transparent 100%, black 100%)`,
    maskImage: `radial-gradient(circle ${r}px at ${cx}px ${cy}px, transparent 100%, black 100%)`,
  }
}

const OnboardingOverlay = ({ onComplete }) => {
  const { user } = useAuth()
  const onboardingKey = `rui_onboarding_completed_${user.id}`

  const [step, setStep] = useState(0)
  const [visible, setVisible] = useState(true)
  const [exiting, setExiting] = useState(false)
  const [btcIconRect, setBtcIconRect] = useState(null)

  // Check if already completed
  useEffect(() => {
    if (localStorage.getItem(onboardingKey)) {
      setVisible(false)
      onComplete?.()
    }
  }, [onboardingKey, onComplete])

  const finish = useCallback(() => {
    setExiting(true)
    localStorage.setItem(onboardingKey, 'true')
    setTimeout(() => {
      setVisible(false)
      onComplete?.()
    }, 500)
  }, [onboardingKey, onComplete])

  // Step 1: auto-create a window, auto-fill and auto-send the demo prompt
  useEffect(() => {
    if (step !== 1) return

    const btn = document.querySelector('.create-common-window-btn')
    if (btn) btn.click()

    const pollInterval = setInterval(() => {
      const textarea = document.querySelector('.route-window-input')
      if (!textarea || textarea.disabled) return

      clearInterval(pollInterval)

      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set
      nativeSetter.call(textarea, DEMO_PROMPT)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))

      setTimeout(() => {
        const sendBtn = document.querySelector('.route-window-send-btn')
        if (sendBtn) {
          sendBtn.click()
          setStep(2)
        }
      }, 200)
    }, 300)

    return () => clearInterval(pollInterval)
  }, [step])

  // Step 3: spotlight BTC icon, advance when user double-clicks it
  useEffect(() => {
    if (step !== 3) return

    const iconPoll = setInterval(() => {
      const icon = document.querySelector('[title*="BTC Industrial"]')
      if (!icon) return
      clearInterval(iconPoll)
      setBtcIconRect(icon.getBoundingClientRect())
    }, 200)

    const handleWindowOpen = () => setStep(4)
    window.addEventListener('open-common-app', handleWindowOpen)
    window.addEventListener('focus-route-window', handleWindowOpen)

    return () => {
      clearInterval(iconPoll)
      window.removeEventListener('open-common-app', handleWindowOpen)
      window.removeEventListener('focus-route-window', handleWindowOpen)
    }
  }, [step])

  // Step 2: clicking the create-window button also advances
  useEffect(() => {
    if (step !== 2) return

    const handler = (e) => {
      const btn = document.querySelector('.create-common-window-btn')
      if (!btn) return
      const rect = btn.getBoundingClientRect()
      const pad = 24
      const nearBtn =
        e.clientX >= rect.left - pad && e.clientX <= rect.right + pad &&
        e.clientY >= rect.top - pad && e.clientY <= rect.bottom + pad
      if (nearBtn || e.target.closest('.create-common-window-btn')) {
        btn.click()
        setStep(3)
      }
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [step])

  // ESC to skip at any step
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') finish() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [finish])

  if (!visible) return null

  const backdropClass = [
    'onboarding-backdrop',
    step === 1 ? 'onboarding-backdrop-watch' : '',
    step === 2 ? 'onboarding-backdrop-spotlight' : '',
    step === 3 ? 'onboarding-backdrop-dynamic' : '',
  ].filter(Boolean).join(' ')

  const backdropInlineStyle = step === 3 ? buildMaskStyle(btcIconRect) : undefined

  return (
    <div className={`onboarding-overlay ${exiting ? 'onboarding-exit' : ''}`}>
      <div
        className={backdropClass}
        style={backdropInlineStyle}
        onClick={step === 0 ? () => setStep(1) : undefined}
      />

      {/* ───── Step 0: Welcome ───── */}
      {step === 0 && (
        <div className="onboarding-welcome" onClick={() => setStep(1)}>
          <div className="onboarding-welcome-icon">
            <span className="onboarding-welcome-logo">◈</span>
          </div>
          <h1 className="onboarding-welcome-title">Watch AI build your first app</h1>
          <p className="onboarding-welcome-sub">
            No setup. No code. Just watch what happens next.
          </p>
          <button className="onboarding-welcome-btn" onClick={(e) => { e.stopPropagation(); setStep(1) }}>
            See it in action
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
          <span className="onboarding-welcome-skip" onClick={(e) => { e.stopPropagation(); finish() }}>
            Skip
          </span>
        </div>
      )}

      {/* ───── Step 1: Auto-demo in progress ───── */}
      {step === 1 && (
        <div className="onboarding-watch-badge">
          <div className="onboarding-watch-spinner" />
          <span>Building your revenue management system…</span>
          <button className="onboarding-watch-skip" onClick={finish}>skip</button>
        </div>
      )}

      {/* ───── Step 2: Spotlight create-window button ───── */}
      {step === 2 && (
        <>
          <div className="onboarding-spotlight-ring" />
          <div className="onboarding-pulse" />
          <div className="onboarding-pointer">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
              <path d="M8 13V4.5a1.5 1.5 0 0 1 3 0V12M11 11.5V3a1.5 1.5 0 0 1 3 0v9.5M14 10.5V5.5a1.5 1.5 0 0 1 3 0v6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M17 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6H9.28a6 6 0 0 1-4.32-1.85L3 17a1.5 1.5 0 0 1 0-2l.5-.5a2 2 0 0 1 2.65-.15L8 16" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="onboarding-tooltip">
            <div className="onboarding-tooltip-arrow" />
            <h3 className="onboarding-tooltip-title">Run apps side by side</h3>
            <p className="onboarding-tooltip-desc">
              Each window is an independent app. Click this button to open another — run a calculator next to a data explorer, or anything else.
            </p>
            <div className="onboarding-tooltip-actions">
              <button className="onboarding-tooltip-btn-primary" onClick={() => setStep(3)}>Next →</button>
              <button className="onboarding-tooltip-btn-ghost" onClick={finish}>Skip</button>
            </div>
          </div>
        </>
      )}

      {/* ───── Step 3: Spotlight BTC icon ───── */}
      {step === 3 && btcIconRect && (
        <>
          <div
            className="onboarding-input-ring"
            style={{
              left: btcIconRect.left - 12,
              top: btcIconRect.top - 12,
              width: btcIconRect.width + 24,
              height: btcIconRect.height + 24,
              borderRadius: 20,
            }}
          />
          <div
            className="onboarding-input-pulse"
            style={{
              left: btcIconRect.left - 12,
              top: btcIconRect.top - 12,
              width: btcIconRect.width + 24,
              height: btcIconRect.height + 24,
              borderRadius: 20,
            }}
          />
          <div
            className="onboarding-tooltip onboarding-chat-tooltip"
            style={{
              top: btcIconRect.bottom + 20,
              left: Math.max(16, btcIconRect.left - 40),
            }}
          >
            <h3 className="onboarding-tooltip-title">Every app is yours to modify</h3>
            <p className="onboarding-tooltip-desc">
              Double-click any icon to open it, then use the chat button to keep building — add charts, swap data, change layouts. Every app on your desktop works this way.
            </p>
            <div className="onboarding-tooltip-actions">
              <button className="onboarding-tooltip-btn-primary" onClick={() => setStep(4)}>Next →</button>
              <button className="onboarding-tooltip-btn-ghost" onClick={finish}>Skip</button>
            </div>
          </div>
        </>
      )}
      {step === 3 && !btcIconRect && (
        <div className="onboarding-watch-badge">
          <div className="onboarding-watch-spinner" />
          <span>Loading…</span>
        </div>
      )}

      {/* ───── Step 4: Upload files tip ───── */}
      {step === 4 && (
        <div className="onboarding-tips-card">
          <div className="onboarding-tips-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <h3 className="onboarding-tips-title">Bring your own data</h3>
          <p className="onboarding-tips-desc">
            Drag any file onto the desktop — a CSV, PDF, image, or spreadsheet — then tell Rui what to build with it.
          </p>
          <div className="onboarding-tips-demo">
            <div className="onboarding-tips-demo-file">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span>sales.csv</span>
            </div>
            <div className="onboarding-tips-demo-arrow">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </div>
            <div className="onboarding-tips-demo-desktop">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span>Desktop</span>
            </div>
          </div>
          <div className="onboarding-tips-list" style={{ marginTop: 12 }}>
            <div className="onboarding-tips-item">
              <span className="onboarding-tips-item-icon">📊</span>
              <span>CSV → instant data explorer or chart</span>
            </div>
            <div className="onboarding-tips-item">
              <span className="onboarding-tips-item-icon">📄</span>
              <span>PDF / doc → summarize or extract data</span>
            </div>
            <div className="onboarding-tips-item">
              <span className="onboarding-tips-item-icon">🖼️</span>
              <span>Image → describe or analyze contents</span>
            </div>
          </div>
          <div className="onboarding-tooltip-actions" style={{ marginTop: 20 }}>
            <button className="onboarding-tooltip-btn-primary" onClick={() => setStep(5)}>Next →</button>
            <button className="onboarding-tooltip-btn-ghost" onClick={finish}>Skip</button>
          </div>
        </div>
      )}

      {/* ───── Step 5: Done ───── */}
      {step === 5 && (
        <div className="onboarding-tips-card">
          <div className="onboarding-tips-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <h3 className="onboarding-tips-title">You&apos;re ready.</h3>
          <p className="onboarding-tips-desc">
            Open windows, describe apps, drop in files. Rui handles the rest.
          </p>
          <div className="onboarding-tooltip-actions" style={{ marginTop: 20 }}>
            <button className="onboarding-tooltip-btn-primary" onClick={finish}>
              Start building →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default OnboardingOverlay
