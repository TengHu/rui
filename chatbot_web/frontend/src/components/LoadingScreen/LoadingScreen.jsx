import './LoadingScreen.css'

const LoadingScreen = ({ message = "Your virtual computer is starting..." }) => {
  return (
    <div className="loading-screen">
      <div className="loading-screen-background"></div>
      <div className="loading-screen-content">
        <div className="loading-spinner-large"></div>
        <p className="loading-message">{message}</p>
        <div className="loading-privacy-badge">
          <svg className="loading-privacy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          <span className="loading-privacy-text">
            Isolated Sandbox · Full Privacy · No Data Leaves
          </span>
        </div>
      </div>
    </div>
  )
}

export default LoadingScreen
