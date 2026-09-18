import { useEffect, useRef } from 'react'
import { formatMoney } from '../lib/money'
import { seatLabel } from '../seatmap/model'
import { chooseSeatsAgain, closeOrder, load, seatStore, showCredit } from '../state/actions'
import { useSelection } from '../state/selection'
import { useStore } from '../state/store'
import { HoldTimer } from './HoldTimer'
import { SelectionPanel } from './SelectionPanel'

const dateFormat = new Intl.DateTimeFormat('en-MY', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

let taps = 0
let lastTap = 0

function tapBrand(): void {
  const now = Date.now()
  taps = now - lastTap < 500 ? taps + 1 : 1
  lastTap = now
  if (taps === 5) showCredit()
}

export function Header() {
  const event = useStore(seatStore, (s) => s.venue?.seatmap.event)
  const connection = useStore(seatStore, (s) => s.connection)
  return (
    <>
      <header className="header">
        <span className="brand" onClick={tapBrand}>CLOUDJOI</span>
        <div className="header__event">
          <h1>{event?.name ?? 'Seat selection'}</h1>
          {event && (
            <p>
              {dateFormat.format(new Date(event.starts_at))} • {event.venue}
            </p>
          )}
        </div>
        <span className={`badge badge--${connection}`}>
          {connection === 'live' ? '● LIVE' : connection === 'reconnecting' ? '↻ RECONNECTING…' : 'CONNECTING…'}
        </span>
      </header>
      {connection === 'reconnecting' && (
        <p className="connection-banner" role="status">
          Live updates paused. Your seats stay held until the timer ends.
        </p>
      )}
    </>
  )
}

export function LoadState() {
  const phase = useStore(seatStore, (s) => s.phase)
  if (phase === 'error') {
    return (
      <div className="load-state" role="alert">
        <h2>Couldn't load the seat map</h2>
        <p>Check your connection and try again.</p>
        <button className="button button--primary" onClick={() => void load()}>
          Retry
        </button>
      </div>
    )
  }
  return (
    <div className="load-state" aria-busy="true">
      <div className="load-state__stage" />
      <p>Loading seat map…</p>
    </div>
  )
}

/** Mobile/tablet: the collapsed ("peek") state of the selection. */
export function BottomBar({ onReview }: { onReview: () => void }) {
  const selection = useSelection()
  const expiresAt = useStore(seatStore, (s) => s.expiresAt)
  const count = selection.seats.length - selection.lost
  return (
    <div className="bottom-bar">
      <div className="bottom-bar__info">
        {expiresAt !== null && <HoldTimer expiresAt={expiresAt} variant="pill" />}
        <div>
          <strong>
            {count} / {selection.maxSeats} seats{count === 0 ? ' selected' : ''}
          </strong>
          <span>
            {count === 0 ? 'Tap any section to pick your seats' : `Subtotal: ${formatMoney(selection.subtotal, selection.currency)}`}
            {selection.lost > 0 && <em className="bottom-bar__lost"> • {selection.lost} lost</em>}
          </span>
        </div>
      </div>
      <button className="button button--primary" onClick={onReview} disabled={selection.seats.length === 0}>
        Review →
      </button>
    </div>
  )
}

/** Native <dialog>: focus trap, Esc and backdrop for free. */
function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return ref
}

export function BottomSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useDialog(open)
  return (
    <dialog
      ref={ref}
      className="sheet"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-label="Your selected seats"
    >
      {open && <SelectionPanel onClose={onClose} />}
    </dialog>
  )
}

export function ExpiredDialog({ onChooseAgain }: { onChooseAgain: () => void }) {
  const expired = useStore(seatStore, (s) => s.expired)
  const venue = useStore(seatStore, (s) => s.venue)
  const ref = useDialog(expired !== null)
  const restart = () => {
    chooseSeatsAgain()
    onChooseAgain()
  }
  return (
    <dialog ref={ref} className="sheet sheet--alert" onCancel={(e) => (e.preventDefault(), restart())} aria-labelledby="expired-title">
      {expired && (
        <div className="expired">
          <div className="banner banner--solid-danger">
            <strong id="expired-title">Hold expired — seats released</strong>
            <span>Your 5-minute reservation timer ended. All held seats have been returned to public availability.</span>
          </div>
          {expired.length > 0 && (
            <div className="expired__list">
              <strong>Released seats ({expired.length}):</strong>
              <ul>
                {expired.map((id) => (
                  <li key={id}>{venue ? seatLabel(venue, id) : id}</li>
                ))}
              </ul>
              <span>You have not been charged.</span>
            </div>
          )}
          <button className="button button--primary button--block" onClick={restart} autoFocus>
            Choose Seats Again →
          </button>
          <p className="expired__note">Tapping will clear the basket and return to the venue map.</p>
        </div>
      )}
    </dialog>
  )
}

export function ConfirmationDialog({ onDone }: { onDone: () => void }) {
  const order = useStore(seatStore, (s) => s.order)
  const venue = useStore(seatStore, (s) => s.venue)
  const ref = useDialog(order !== null)
  const done = () => {
    closeOrder()
    onDone()
  }
  const currency = venue?.seatmap.event.currency ?? 'MYR'
  return (
    <dialog ref={ref} className="sheet sheet--alert" onCancel={(e) => (e.preventDefault(), done())} aria-labelledby="order-title">
      {order && (
        <div className="expired">
          <div className="banner banner--solid-success">
            <strong id="order-title">Seats booked</strong>
            <span>Order {order.id}</span>
          </div>
          <div className="expired__list order__list">
            <strong>Purchased seats ({order.seats.length}):</strong>
            <ul>
              {order.seats.map((id) => (
                <li key={id}>{venue ? seatLabel(venue, id) : id}</li>
              ))}
            </ul>
            <strong>Total: {formatMoney(order.total, currency)}</strong>
          </div>
          <p>
            A confirmation with order ID <strong>{order.id}</strong> has been sent to your email.
          </p>
          <button className="button button--primary button--block" onClick={done} autoFocus>
            Done
          </button>
        </div>
      )}
    </dialog>
  )
}
