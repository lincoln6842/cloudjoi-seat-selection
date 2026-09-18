import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FakeVenue, HOLD_TTL_MS, MAX_SEATS } from './venue.ts'

const seatmap = JSON.parse(readFileSync(new URL('./data/seatmap.json', import.meta.url), 'utf8'))
const seats: string[] = seatmap.sections[1].rows[0].seats.map((s: { id: string }) => s.id)

function setup() {
  let now = Date.parse('2026-10-24T11:00:00Z')
  const broadcasts: { seq: number; changes: { seat_id: string; status: string }[] }[] = []
  const venue = new FakeVenue(seatmap, [], {
    now: () => now,
    random: () => 0,
    broadcast: (p) => broadcasts.push(p),
  })
  return { venue, broadcasts, advance: (ms: number) => (now += ms) }
}

const errorCode = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as { code: string }).code
  }
  return null
}

describe('FakeVenue', () => {
  it('gives a contested seat to exactly one session', () => {
    const { venue } = setup()
    const buyers = Array.from({ length: 100 }, () => venue.createSession())
    const results = buyers.map((t) => errorCode(() => venue.hold(t, seats[0])))
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.filter((r) => r === 'SEAT_UNAVAILABLE')).toHaveLength(99)
  })

  it('treats holding an already-held seat as a no-op', () => {
    const { venue, broadcasts } = setup()
    const t = venue.createSession()
    expect(venue.hold(t, seats[0])).toBe(true)
    expect(venue.hold(t, seats[0])).toBe(false)
    expect(broadcasts).toHaveLength(1)
  })

  it('caps holds per session', () => {
    const { venue } = setup()
    const t = venue.createSession()
    seats.slice(0, MAX_SEATS).forEach((s) => venue.hold(t, s))
    expect(errorCode(() => venue.hold(t, seats[MAX_SEATS]))).toBe('HOLD_LIMIT_REACHED')
  })

  it('expires all holds together, measured from the first hold', () => {
    const { venue, advance } = setup()
    const t = venue.createSession()
    venue.hold(t, seats[0])
    const expiresAt = venue.holdSet(t).expires_at
    advance(HOLD_TTL_MS - 60_000)
    venue.hold(t, seats[1])
    expect(venue.holdSet(t).expires_at).toBe(expiresAt)

    advance(60_000)
    venue.sweep()
    expect(venue.holdSet(t).holds).toEqual([])
    const other = venue.createSession()
    expect(venue.hold(other, seats[0])).toBe(true)
  })

  it('serves net deltas since a seq, and a snapshot when history is gone', () => {
    const { venue } = setup()
    const t = venue.createSession()
    venue.hold(t, seats[0]) // seq 1
    venue.hold(t, seats[1]) // seq 2
    venue.release(t, seats[0]) // seq 3

    const delta = venue.availability(1)
    expect(delta).toMatchObject({ type: 'delta', seq: 3 })
    expect(delta.type === 'delta' && delta.changes).toEqual([
      { seat_id: seats[1], status: 'unavailable' },
      { seat_id: seats[0], status: 'available' },
    ])
    expect(venue.availability(99).type).toBe('snapshot')
  })

  it('keeps a revoked seat in the hold set until the buyer dismisses it', () => {
    const { venue, broadcasts } = setup()
    const t = venue.createSession()
    venue.hold(t, seats[0])
    expect(venue.revoke(t)).toBe(seats[0])
    expect(broadcasts.at(-1)?.changes).toEqual([{ seat_id: seats[0], status: 'unavailable' }])
    expect(venue.holdSet(t).holds).toEqual([{ seat_id: seats[0], status: 'revoked' }])
    expect(errorCode(() => venue.checkout(t))).toBe('HOLDS_INVALID')

    venue.release(t, seats[0])
    expect(venue.holdSet(t).holds).toEqual([])
    const snapshot = venue.availability()
    expect(snapshot.type === 'snapshot' && snapshot.unavailable).toContain(seats[0])
  })

  it('rejects unknown sessions', () => {
    const { venue } = setup()
    expect(errorCode(() => venue.holdSet('nope'))).toBe('UNAUTHENTICATED')
  })
})
