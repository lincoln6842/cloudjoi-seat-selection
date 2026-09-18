import { describe, expect, it } from 'vitest'
import { applyAvailability, applyHoldSet, initialState, seatStatus, touchesMine, type SeatState } from './seats'

const state = (patch: Partial<SeatState>): SeatState => ({ ...initialState, ...patch })

describe('seatStatus', () => {
  it('lets my holds win over public availability', () => {
    const s = state({
      unavailable: new Set(['a', 'b', 'c', 'd']),
      holds: new Map([
        ['a', 'held'],
        ['b', 'pending'],
        ['c', 'revoked'],
      ]),
    })
    expect(seatStatus(s, 'a')).toBe('selected')
    expect(seatStatus(s, 'b')).toBe('pending')
    expect(seatStatus(s, 'c')).toBe('lost')
    expect(seatStatus(s, 'd')).toBe('unavailable')
    expect(seatStatus(s, 'e')).toBe('available')
  })
})

describe('applyAvailability', () => {
  it('replaces everything on a snapshot', () => {
    const s = state({ unavailable: new Set(['old']) })
    const next = applyAvailability(s, { type: 'snapshot', seq: 7, server_time: '', unavailable: ['x'] })
    expect(next).toEqual({ seq: 7, unavailable: new Set(['x']) })
  })

  it('patches on a delta', () => {
    const s = state({ seq: 3, unavailable: new Set(['a', 'b']) })
    const next = applyAvailability(s, {
      type: 'delta',
      seq: 5,
      server_time: '',
      changes: [
        { seat_id: 'a', status: 'available' },
        { seat_id: 'c', status: 'unavailable' },
      ],
    })
    expect(next).toEqual({ seq: 5, unavailable: new Set(['b', 'c']) })
  })
})

describe('applyHoldSet', () => {
  const set = (holds: { seat_id: string; status: 'held' | 'revoked' }[]) => ({
    holds,
    expires_at: '2026-01-01T00:05:00.000Z',
    server_time: '2026-01-01T00:00:00.000Z',
    max_seats: 10,
  })

  it('keeps seats still waiting on the server', () => {
    const s = state({ holds: new Map([['p', 'pending']]) })
    const next = applyHoldSet(s, set([{ seat_id: 'a', status: 'held' }]), Date.parse('2026-01-01T00:00:00.000Z'))
    expect([...next.holds!]).toEqual([
      ['a', 'held'],
      ['p', 'pending'],
    ])
  })

  it('converts expiry to the device clock', () => {
    // Device clock is 30s ahead of the server.
    const next = applyHoldSet(state({}), set([]), Date.parse('2026-01-01T00:00:30.000Z'))
    expect(next.expiresAt).toBe(Date.parse('2026-01-01T00:05:30.000Z'))
  })
})

describe('touchesMine', () => {
  it('ignores seats I am only waiting on', () => {
    const s = state({ holds: new Map([['p', 'pending'], ['h', 'held']]) })
    expect(touchesMine(s, [{ seat_id: 'p', status: 'unavailable' }])).toBe(false)
    expect(touchesMine(s, [{ seat_id: 'h', status: 'unavailable' }])).toBe(true)
  })
})
