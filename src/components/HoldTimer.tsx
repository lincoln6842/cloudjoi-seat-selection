import { useNow } from '../hooks/useNow'

const WARN_MS = 60_000

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Countdown to the shared hold expiry. `card` in the panel, `pill` in the mobile bottom bar. */
export function HoldTimer({ expiresAt, variant }: { expiresAt: number; variant: 'card' | 'pill' }) {
  const remaining = expiresAt - useNow()
  const urgent = remaining <= WARN_MS
  const time = <span className="timer__time">{formatRemaining(remaining)}</span>

  if (variant === 'pill') {
    return (
      <span className={`timer-pill ${urgent ? 'is-urgent' : ''}`} aria-label={`Seats held for ${formatRemaining(remaining)}`}>
        <ClockIcon /> {time}
      </span>
    )
  }
  return (
    <div className={`timer-card ${urgent ? 'is-urgent' : ''}`} role="timer">
      <ClockIcon />
      <div className="timer-card__text">
        <strong>{urgent ? 'Less than 1 minute remaining' : 'Seats held for you'}</strong>
        <span>{urgent ? 'Complete checkout now before seats are released' : "Holds release if checkout isn't completed in time"}</span>
      </div>
      {time}
    </div>
  )
}

export function ClockIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}
