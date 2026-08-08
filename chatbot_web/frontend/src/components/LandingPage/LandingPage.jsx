import { useAuth } from '../../context/AuthContext'
import './LandingPage.css'

const LandingPage = () => {
  const { login, authLoading: isLoading } = useAuth()

  return (
    <div className="landing-page">
      {/* Animated background */}
      <div className="landing-bg">
        <div className="landing-bg-gradient"></div>
        <div className="landing-bg-grid"></div>
        <div className="landing-bg-orb landing-bg-orb-1"></div>
        <div className="landing-bg-orb landing-bg-orb-2"></div>
        <div className="landing-bg-orb landing-bg-orb-3"></div>
      </div>

      {/* Main content */}
      <div className="landing-content">
        {/* Hero section */}
        <header className="landing-hero">
          <div className="landing-logo">
            <span className="landing-logo-icon">◈</span>
            <span className="landing-logo-text">Rui</span>
          </div>

          <h1 className="landing-title">
            <span className="landing-title-gradient">Describe what you need.</span>
            <br />
            <span className="landing-title-white">Watch it get built.</span>
          </h1>

          <p className="landing-tagline">
            Type what your team needs. Rui builds a live, working app — no code, no setup, no waiting on engineers.
          </p>

          <button
            className="landing-cta"
            onClick={login}
            disabled={isLoading}
          >
            <span className="landing-cta-text">
              {isLoading ? 'Signing in...' : 'Build your desktop of AI apps →'}
            </span>
            <div className="landing-cta-glow"></div>
          </button>

          <p className="landing-hint">Sign in with Google · Each app runs isolated · They talk to each other</p>

          <div className="landing-privacy-badge">
            <svg className="landing-privacy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            <span className="landing-privacy-text">
              Isolated Sandbox · Full Privacy · No Data Leaves
            </span>
          </div>
        </header>

        {/* Product demo image */}
        <div className="landing-gif-section">
          <img src="/land_demo.png" alt="Rui desktop — vibe-coded mini apps working together" className="landing-gif" />
        </div>

      </div>
    </div>
  )
}

export default LandingPage
