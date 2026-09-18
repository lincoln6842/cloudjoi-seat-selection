import { formatMoney } from '../lib/money'
import { tierColors } from '../seatmap/theme'
import { checkout, removeSeat, seatStore } from '../state/actions'
import { checkoutBlocker, useSelection, type SelectedSeat } from '../state/selection'
import { useStore } from '../state/store'
import { HoldTimer } from './HoldTimer'
import { WarningIcon } from './Notices'

/**
 * The selection: desktop sidebar and mobile bottom sheet are this same
 * component. It only reads the store and calls actions, so the map stays
 * in sync without the two knowing about each other.
 */
export function SelectionPanel({ onClose }: { onClose?: () => void }) {
  const selection = useSelection()
  const expiresAt = useStore(seatStore, (s) => s.expiresAt)
  const checkingOut = useStore(seatStore, (s) => s.checkingOut)
  const blocker = checkoutBlocker(selection)
  const { seats, lost, currency } = selection
  const count = seats.length - lost

  return (
    <section className="panel" aria-labelledby="panel-title">
      <header className="panel__header">
        <div>
          <h2 id="panel-title">
            Your Selected Seats <span className="count-badge">{count} / {selection.maxSeats}</span>
          </h2>
          <p className="panel__sub">Maximum {selection.maxSeats} seats per order</p>
        </div>
        {onClose && (
          <button className="icon-button" onClick={onClose} aria-label="Close selection">
            ✕
          </button>
        )}
      </header>

      <div className="panel__body">
        {lost > 0 && (
          <div className="banner banner--danger" role="alert">
            <WarningIcon />
            <div>
              <strong>{lost === 1 ? '1 seat is no longer available' : `${lost} seats are no longer available`}</strong>
              <span>The venue released {lost === 1 ? 'this seat' : 'these seats'}. Remove {lost === 1 ? 'it' : 'them'} to continue.</span>
            </div>
          </div>
        )}
        {expiresAt !== null && <HoldTimer expiresAt={expiresAt} variant="card" />}
        {seats.length === 0 ? (
          <p className="panel__empty">No seats yet. Pick seats on the map; each one is held for you while you decide.</p>
        ) : (
          <ul className="seat-list">
            {seats.map((item) => (
              <SeatRow key={item.seat.id} item={item} currency={currency} />
            ))}
          </ul>
        )}
      </div>

      <footer className="panel__footer">
        <div className="subtotal">
          <span>Subtotal ({selection.held} ticket{selection.held === 1 ? '' : 's'})</span>
          <strong>{formatMoney(selection.subtotal, currency)}</strong>
        </div>
        <p className="subtotal__note">* Taxes or additional fees, if any, calculated at checkout.</p>
        <button className="button button--primary button--block" disabled={blocker !== null || checkingOut} onClick={() => void checkout().then(onClose)}>
          {blocker ?? (checkingOut ? 'Placing order…' : `Proceed to Checkout (${formatMoney(selection.subtotal, currency)}) →`)}
        </button>
      </footer>
    </section>
  )
}

function SeatRow({ item, currency }: { item: SelectedSeat; currency: string }) {
  const { seat, status } = item
  const name = `Row ${seat.row}, Seat ${seat.number}`

  if (status === 'revoked') {
    return (
      <li className="seat-row seat-row--lost">
        <span className="seat-row__lost-mark" aria-hidden="true">✕</span>
        <div className="seat-row__main">
          <s>{name}</s>
          <span className="seat-row__status">LOST: Released by venue</span>
        </div>
        <button className="button button--danger button--small" onClick={() => void removeSeat(seat.id)}>
          Remove <span className="visually-hidden">{name}</span>
        </button>
      </li>
    )
  }

  return (
    <li className={`seat-row ${status === 'pending' ? 'is-pending' : ''}`}>
      <span className="seat-row__tier" style={{ background: tierColors[seat.section.tier.id] }} aria-hidden="true" />
      <div className="seat-row__main">
        <strong>{name}</strong>
        <span>{status === 'pending' ? 'Confirming hold…' : seat.section.name}</span>
      </div>
      <span className="seat-row__price">{formatMoney(seat.section.tier.price, currency)}</span>
      <button
        className="icon-button icon-button--remove"
        onClick={() => void removeSeat(seat.id)}
        disabled={status === 'pending'}
        aria-label={`Remove ${seat.section.name} ${name}`}
      >
        ✕
      </button>
    </li>
  )
}
