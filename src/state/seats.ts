import type { Schemas } from '../api/client'
import type { VenueModel } from '../seatmap/model'

export type HoldStatus = 'pending' | 'held' | 'revoked'
export type SeatStatus = 'available' | 'selected' | 'pending' | 'unavailable' | 'lost'
export type Connection = 'connecting' | 'live' | 'reconnecting'

export interface Notice {
  id: number
  tone: 'warning' | 'danger' | 'info'
  title: string
  body: string
}

export interface Order {
  id: string
  /** Seat ids bought, in pick order. */
  seats: readonly string[]
  total: number
}

export interface SeatState {
  phase: 'loading' | 'ready' | 'error'
  /** Static venue layout, loaded once. */
  venue: VenueModel | null
  /** Last applied availability seq; broadcasts must follow it by exactly 1. */
  seq: number
  /** Public availability: held by anyone (including me) or sold. */
  unavailable: ReadonlySet<string>
  /** My holds, in the order they were picked. */
  holds: ReadonlyMap<string, HoldStatus>
  /** Shared hold expiry on the device clock (already corrected for skew). */
  expiresAt: number | null
  maxSeats: number
  /** Seats released when the hold timer ran out; drives the "hold expired" screen. */
  expired: readonly string[] | null
  /** Checkout request in flight; blocks a second submit. */
  checkingOut: boolean
  /** Last completed order; drives the confirmation screen. */
  order: Order | null
  connection: Connection
  notices: readonly Notice[]
}

export const initialState: SeatState = {
  phase: 'loading',
  venue: null,
  seq: 0,
  unavailable: new Set(),
  holds: new Map(),
  expiresAt: null,
  maxSeats: 10,
  expired: null,
  checkingOut: false,
  order: null,
  connection: 'connecting',
  notices: [],
}

export function seatStatus(state: SeatState, seatId: string): SeatStatus {
  switch (state.holds.get(seatId)) {
    case 'held':
      return 'selected'
    case 'pending':
      return 'pending'
    case 'revoked':
      return 'lost'
    default:
      return state.unavailable.has(seatId) ? 'unavailable' : 'available'
  }
}

type Availability = Schemas['AvailabilitySnapshot'] | Schemas['AvailabilityDelta']

export function applyAvailability(state: SeatState, availability: Availability): Partial<SeatState> {
  if (availability.type === 'snapshot') {
    return { seq: availability.seq, unavailable: new Set(availability.unavailable) }
  }
  return { seq: availability.seq, unavailable: applyChanges(state.unavailable, availability.changes) }
}

export function applyChanges(unavailable: ReadonlySet<string>, changes: Schemas['SeatChange'][]): Set<string> {
  const next = new Set(unavailable)
  for (const { seat_id, status } of changes) {
    if (status === 'unavailable') next.add(seat_id)
    else next.delete(seat_id)
  }
  return next
}

/**
 * Replaces my holds with the server's view, keeping seats whose hold request
 * is still in flight (the server may answer another call before that one).
 */
export function applyHoldSet(state: SeatState, set: Schemas['HoldSet'], receivedAt: number): Partial<SeatState> {
  const holds = new Map<string, HoldStatus>(set.holds.map((h) => [h.seat_id, h.status]))
  for (const [seat, status] of state.holds) {
    if (status === 'pending' && !holds.has(seat)) holds.set(seat, 'pending')
  }
  const skew = Date.parse(set.server_time) - receivedAt
  return {
    holds,
    maxSeats: set.max_seats,
    expiresAt: set.expires_at === null ? null : Date.parse(set.expires_at) - skew,
  }
}

/** True when a public change touches a seat I hold: the cue to refetch my holds. */
export function touchesMine(state: SeatState, changes: Schemas['SeatChange'][]): boolean {
  return changes.some((c) => {
    const mine = state.holds.get(c.seat_id)
    return mine === 'held' || mine === 'revoked'
  })
}

export function countHolds(state: SeatState, ...statuses: HoldStatus[]): number {
  let n = 0
  for (const status of state.holds.values()) if (statuses.includes(status)) n++
  return n
}
