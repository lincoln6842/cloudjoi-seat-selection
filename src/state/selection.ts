import { useMemo } from 'react'
import type { SeatInfo } from '../seatmap/model'
import { seatStore } from './actions'
import type { HoldStatus } from './seats'
import { useStore } from './store'

export interface SelectedSeat {
  seat: SeatInfo
  status: HoldStatus
}

/**
 * The selection as every panel sees it: seats in pick order plus totals.
 * Any new panel (a third one tomorrow) reads this hook; nothing is passed
 * between siblings.
 */
export function useSelection() {
  const holds = useStore(seatStore, (s) => s.holds)
  const venue = useStore(seatStore, (s) => s.venue)
  const maxSeats = useStore(seatStore, (s) => s.maxSeats)

  return useMemo(() => {
    const seats: SelectedSeat[] = []
    for (const [id, status] of holds) {
      const seat = venue?.byId.get(id)
      if (seat) seats.push({ seat, status })
    }
    const held = seats.filter((s) => s.status === 'held')
    return {
      seats,
      held: held.length,
      lost: seats.filter((s) => s.status === 'revoked').length,
      pending: seats.filter((s) => s.status === 'pending').length,
      subtotal: held.reduce((sum, s) => sum + s.seat.section.tier.price, 0),
      currency: venue?.seatmap.event.currency ?? 'MYR',
      maxSeats,
    }
  }, [holds, venue, maxSeats])
}

export type Selection = ReturnType<typeof useSelection>

/** Why checkout can't happen yet, or null when it can. */
export function checkoutBlocker(selection: Selection): string | null {
  if (selection.lost > 0) return `Remove lost seat${selection.lost > 1 ? 's' : ''} to continue`
  if (selection.pending > 0) return 'Confirming your seats…'
  if (selection.held === 0) return 'Select seats to continue'
  return null
}
