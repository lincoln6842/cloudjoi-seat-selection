import { randomUUID } from 'node:crypto'
import type { components } from '../src/api/schema.js'

type Schemas = components['schemas']
type SeatChange = Schemas['SeatChange']
type ErrorCode = Schemas['Error']['error']['code']

export const HOLD_TTL_MS = 5 * 60_000
export const MAX_SEATS = 10
const LOG_LIMIT = 500

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode

  constructor(status: number, code: ErrorCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

interface Session {
  holds: Map<string, 'held' | 'revoked'>
  expiresAt: number | null
}

export interface VenueOptions {
  /** Defaults to HOLD_TTL_MS; shortened in dev to demo expiry. */
  holdTtlMs?: number
  now: () => number
  random: () => number
  broadcast: (payload: Schemas['SeatsChanged']) => void
}

/**
 * In-memory implementation of the contract in api/openapi.yaml.
 * Node runs this single-threaded, so every method is atomic: two requests
 * for the same seat can never both succeed.
 */
export class FakeVenue {
  readonly seatmap: Schemas['Seatmap']
  private readonly opts: VenueOptions
  private readonly seatIds: Set<string>
  private readonly rows: string[][]
  private readonly unavailable: Set<string>
  private readonly sessions = new Map<string, Session>()
  private readonly botHolds = new Map<string, number>() // seat -> when the bot decides
  private readonly botSold = new Set<string>()
  private seq = 0
  private log: Schemas['SeatsChanged'][] = []

  constructor(seatmap: Schemas['Seatmap'], initiallyUnavailable: string[], opts: VenueOptions) {
    this.seatmap = seatmap
    this.opts = opts
    this.rows = seatmap.sections.flatMap((s) => s.rows.map((r) => r.seats.map((seat) => seat.id)))
    this.seatIds = new Set(this.rows.flat())
    this.unavailable = new Set(initiallyUnavailable)
  }

  createSession(): string {
    const token = randomUUID()
    this.sessions.set(token, { holds: new Map(), expiresAt: null })
    return token
  }

  availability(since?: number): Schemas['AvailabilitySnapshot'] | Schemas['AvailabilityDelta'] {
    const server_time = this.isoNow()
    const oldest = this.log[0]?.seq ?? this.seq + 1
    if (since === undefined || since > this.seq || since < oldest - 1) {
      return { type: 'snapshot', seq: this.seq, server_time, unavailable: [...this.unavailable] }
    }
    const net = new Map<string, SeatChange>()
    for (const entry of this.log) {
      if (entry.seq > since) for (const change of entry.changes) net.set(change.seat_id, change)
    }
    return { type: 'delta', seq: this.seq, server_time, changes: [...net.values()] }
  }

  holdSet(token: string | undefined): Schemas['HoldSet'] {
    const session = this.session(token)
    return {
      holds: [...session.holds].map(([seat_id, status]) => ({ seat_id, status })),
      expires_at: session.expiresAt === null ? null : new Date(session.expiresAt).toISOString(),
      server_time: this.isoNow(),
      max_seats: MAX_SEATS,
    }
  }

  /** Returns true when a new hold was created, false when already held. */
  hold(token: string | undefined, seatId: string): boolean {
    const session = this.session(token)
    this.assertSeat(seatId)
    const current = session.holds.get(seatId)
    if (current === 'held') return false
    if (current === 'revoked' || this.unavailable.has(seatId)) {
      throw new ApiError(409, 'SEAT_UNAVAILABLE', 'Seat was just taken.')
    }
    const held = [...session.holds.values()].filter((s) => s === 'held').length
    if (held >= MAX_SEATS) {
      throw new ApiError(409, 'HOLD_LIMIT_REACHED', `Maximum ${MAX_SEATS} seats per order.`)
    }
    session.holds.set(seatId, 'held')
    session.expiresAt ??= this.opts.now() + (this.opts.holdTtlMs ?? HOLD_TTL_MS)
    this.unavailable.add(seatId)
    this.commit([{ seat_id: seatId, status: 'unavailable' }])
    return true
  }

  release(token: string | undefined, seatId: string): void {
    const session = this.session(token)
    const current = session.holds.get(seatId)
    if (!current) return
    session.holds.delete(seatId)
    if (session.holds.size === 0) session.expiresAt = null
    // A revoked seat belongs to the venue now; dismissing it changes nothing public.
    if (current === 'held') {
      this.unavailable.delete(seatId)
      this.commit([{ seat_id: seatId, status: 'available' }])
    }
  }

  checkout(token: string | undefined): string {
    const session = this.session(token)
    const statuses = [...session.holds.values()]
    if (statuses.length === 0 || statuses.includes('revoked')) {
      throw new ApiError(409, 'HOLDS_INVALID', 'Nothing to check out, or a seat was lost.')
    }
    const seats = [...session.holds.keys()]
    session.holds.clear()
    session.expiresAt = null
    // Status stays unavailable, but the hold changed, so it is broadcast (see x-realtime).
    this.commit(seats.map((seat_id) => ({ seat_id, status: 'unavailable' })))
    return `ord_${randomUUID().slice(0, 8)}`
  }

  /** Venue takes back one seat a buyer holds. Picks the buyer at random unless given. */
  revoke(token?: string): string | null {
    const candidates = [...this.sessions]
      .filter(([t]) => token === undefined || t === token)
      .flatMap(([, s]) => [...s.holds].filter(([, status]) => status === 'held').map(([seat]) => ({ s, seat })))
    if (candidates.length === 0) return null
    const { s, seat } = candidates[Math.floor(this.opts.random() * candidates.length)]
    s.holds.set(seat, 'revoked')
    this.commit([{ seat_id: seat, status: 'unavailable' }])
    return seat
  }

  /** Releases every hold set whose shared expiry has passed. */
  sweep(): void {
    const now = this.opts.now()
    const changes: SeatChange[] = []
    for (const session of this.sessions.values()) {
      if (session.expiresAt === null || session.expiresAt > now) continue
      for (const [seat, status] of session.holds) {
        if (status === 'held') {
          this.unavailable.delete(seat)
          changes.push({ seat_id: seat, status: 'available' })
        }
      }
      session.holds.clear()
      session.expiresAt = null
    }
    this.commit(changes)
  }

  /** Simulated other customers: grab seat clusters, then buy or release them. */
  botTick(): void {
    const { now, random } = this.opts
    const changes: SeatChange[] = []

    for (const [seat, decideAt] of this.botHolds) {
      if (decideAt > now()) continue
      this.botHolds.delete(seat)
      if (random() < 0.7) {
        this.botSold.add(seat)
      } else {
        this.unavailable.delete(seat)
        changes.push({ seat_id: seat, status: 'available' })
      }
    }

    if (random() < 0.6) {
      const row = this.rows[Math.floor(random() * this.rows.length)]
      const want = 1 + Math.floor(random() * 4)
      let i = Math.floor(random() * row.length)
      for (let taken = 0; taken < want && i < row.length; i++, taken++) {
        if (this.unavailable.has(row[i])) break
        this.unavailable.add(row[i])
        this.botHolds.set(row[i], now() + 3_000 + random() * 15_000)
        changes.push({ seat_id: row[i], status: 'unavailable' })
      }
    }

    // Keep a long demo session from selling out: refund bot purchases.
    if (this.unavailable.size > this.seatIds.size * 0.75) {
      for (const seat of [...this.botSold].slice(0, 20)) {
        this.botSold.delete(seat)
        this.unavailable.delete(seat)
        changes.push({ seat_id: seat, status: 'available' })
      }
    }

    this.commit(changes)
  }

  private commit(changes: SeatChange[]): void {
    if (changes.length === 0) return
    const entry = { seq: ++this.seq, changes }
    this.log.push(entry)
    if (this.log.length > LOG_LIMIT) this.log = this.log.slice(-LOG_LIMIT)
    this.opts.broadcast(entry)
  }

  private session(token: string | undefined): Session {
    this.sweep()
    const session = token === undefined ? undefined : this.sessions.get(token)
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Unknown or expired session.')
    return session
  }

  private assertSeat(seatId: string): void {
    if (!this.seatIds.has(seatId)) throw new ApiError(404, 'NOT_FOUND', `No seat ${seatId}.`)
  }

  private isoNow(): string {
    return new Date(this.opts.now()).toISOString()
  }
}
