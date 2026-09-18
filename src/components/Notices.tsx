import { dismissNotice, seatStore } from '../state/actions'
import { useStore } from '../state/store'

/** Toasts, docked above the bottom bar (mobile) or bottom of the map (desktop). */
export function Notices() {
  const notices = useStore(seatStore, (s) => s.notices)
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice--${n.tone}`} role={n.tone === 'danger' ? 'alert' : 'status'}>
          <WarningIcon />
          <div>
            <strong>{n.title}</strong>
            <span>{n.body}</span>
          </div>
          <button className="icon-button icon-button--bare" onClick={() => dismissNotice(n.id)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

export function WarningIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 2 21h20L12 3z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M12 10v5M12 18v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}
