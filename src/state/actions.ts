import { api, authHeaders, ensureSession, EVENT_ID, type Schemas } from '../api/client'
import { subscribeSeats } from '../api/realtime'
import { buildModel, seatLabel } from '../seatmap/model'
import {
  applyAvailability,
  applyChanges,
  applyHoldSet,
  countHolds,
  initialState,
  seatStatus,
  touchesMine,
  type Notice,
  type SeatState,
} from './seats'
import { createStore } from './store'

/** The one store every panel reads from. */
export const seatStore = createStore<SeatState>(initialState)

// A hot update would create a second store while the app still runs on the
// first; reload the page instead.
import.meta.hot?.accept(() => location.reload())
const { get, set } = seatStore
const eventPath = { params: { path: { eventId: EVENT_ID } } }

// ---------------------------------------------------------------- lifecycle

/** Loads everything and keeps it live. Returns a cleanup for React effects. */
export function start(): () => void {
  void load()
  const unsubscribe = subscribeSeats(EVENT_ID, {
    onChange: applyBroadcast,
    onConnection: (connection) => set({ connection }),
    onReconnected: () => void catchUp(),
  })
  // Hidden tabs get throttled or frozen; catch up the moment we're visible.
  const onVisible = () => document.visibilityState === 'visible' && void catchUp()
  document.addEventListener('visibilitychange', onVisible)
  const expiryTimer = setInterval(checkExpiry, 1_000)
  return () => {
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisible)
    clearInterval(expiryTimer)
  }
}

export async function load(): Promise<void> {
  set({ phase: 'loading' })
  try {
    await ensureSession()
    const [seatmap, availability] = await Promise.all([
      api.GET('/events/{eventId}/seatmap', eventPath),
      api.GET('/events/{eventId}/availability', eventPath),
    ])
    if (!seatmap.data || !availability.data) throw new Error('Load failed')
    set((s) => ({ venue: buildModel(seatmap.data), ...applyAvailability(s, availability.data), phase: 'ready' }))
    await refreshHolds()
  } catch {
    set({ phase: 'error' })
  }
}

// ------------------------------------------------------------- availability

function applyBroadcast(payload: Schemas['SeatsChanged']): void {
  const s = get()
  if (s.phase !== 'ready' || payload.seq <= s.seq) return
  // A gap means we missed a broadcast: fetch what we missed instead.
  if (payload.seq !== s.seq + 1) return void catchUp()
  set({ seq: payload.seq, unavailable: applyChanges(s.unavailable, payload.changes) })
  if (touchesMine(s, payload.changes)) void refreshHolds()
}

let catchingUp: Promise<void> | null = null

/** Pulls changes since our last seq (or a fresh snapshot) and my holds. */
function catchUp(): Promise<void> {
  if (get().phase !== 'ready') return Promise.resolve()
  catchingUp ??= (async () => {
    try {
      const { data } = await api.GET('/events/{eventId}/availability', {
        params: { path: { eventId: EVENT_ID }, query: { since: get().seq } },
      })
      // Broadcasts may have moved us past this response while it was in flight.
      if (data && data.seq >= get().seq) set((s) => applyAvailability(s, data))
      await refreshHolds()
    } catch {
      // Offline: the socket reconnecting will bring us back here.
    }
  })().finally(() => (catchingUp = null))
  return catchingUp
}

// -------------------------------------------------------------------- holds

async function refreshHolds(): Promise<void> {
  const { data, response } = await api.GET('/events/{eventId}/holds', eventPath)
  if (response.status === 401) return sessionLost()
  if (!data) return
  const before = get().holds
  set((s) => applyHoldSet(s, data, Date.now()))
  const revoked = data.holds.filter((h) => h.status === 'revoked' && before.get(h.seat_id) === 'held')
  if (revoked.length > 0) {
    notify({ tone: 'danger', title: 'A seat is no longer available', body: `The venue released ${revoked.map((h) => label(h.seat_id)).join(', ')}. Remove it to continue.` }, 10_000)
  }
}

/** The server no longer knows our session (e.g. it restarted): start clean. */
async function sessionLost(): Promise<void> {
  await ensureSession(true)
  set({ holds: new Map(), expiresAt: null })
}

/** Map click: select, deselect, or dismiss, depending on the seat's state. */
export function toggleSeat(seatId: string): void {
  const status = seatStatus(get(), seatId)
  if (status === 'available') void holdSeat(seatId)
  else if (status === 'selected' || status === 'lost') void removeSeat(seatId)
  // 'pending' waits for the server; 'unavailable' does nothing.
}

async function holdSeat(seatId: string, retried = false): Promise<void> {
  const s = get()
  if (countHolds(s, 'held', 'pending') >= s.maxSeats) return limitReached()
  set((s) => ({ holds: new Map(s.holds).set(seatId, 'pending') }))
  try {
    const { data, error, response } = await api.POST('/events/{eventId}/holds', { ...eventPath, body: { seat_id: seatId } })
    if (data) return set((s) => applyHoldSet({ ...s, ...withoutHold(s, seatId) }, data, Date.now()))
    set((s) => withoutHold(s, seatId))
    if (response.status === 401 && !retried) {
      await sessionLost()
      return holdSeat(seatId, true)
    }
    if (error?.error.code === 'SEAT_UNAVAILABLE') {
      set((s) => ({ unavailable: new Set(s.unavailable).add(seatId) }))
      return notify({ tone: 'warning', title: 'Seat just taken', body: `${label(seatId)} was just reserved by another customer. The map has updated.` })
    }
    if (error?.error.code === 'HOLD_LIMIT_REACHED') {
      void refreshHolds() // we were out of sync with the server
      return limitReached()
    }
    throw new Error(error?.error.message)
  } catch {
    set((s) => withoutHold(s, seatId))
    notify({ tone: 'danger', title: "Couldn't hold that seat", body: 'Check your connection and try again.' })
  }
}

function limitReached(): void {
  const max = get().maxSeats
  notify({ tone: 'warning', title: `Seat limit reached (${max} / ${max})`, body: `Maximum ${max} seats per booking. Remove a seat to pick a different one.` })
}

/** Sidebar remove, map deselect, or dismissing a lost seat. */
export async function removeSeat(seatId: string): Promise<void> {
  const previous = get().holds.get(seatId)
  if (!previous || previous === 'pending') return
  // Optimistic: the seat frees up on screen straight away.
  set((s) => ({
    ...withoutHold(s, seatId),
    unavailable: previous === 'held' ? without(s.unavailable, seatId) : s.unavailable,
  }))
  try {
    const { data } = await api.DELETE('/events/{eventId}/holds/{seatId}', {
      params: { path: { eventId: EVENT_ID, seatId } },
    })
    if (data) set((s) => applyHoldSet(s, data, Date.now()))
  } catch {
    void catchUp()
  }
}

export async function checkout(): Promise<void> {
  const seats = [...get().holds.keys()]
  try {
    const { data } = await api.POST('/events/{eventId}/checkout', eventPath)
    if (!data) throw new Error('Checkout rejected')
    console.log('Checkout', { order: data.order_id, seats })
    set({ holds: new Map(), expiresAt: null })
    notify({ tone: 'info', title: 'Order created', body: `Order ${data.order_id} is waiting for payment (demo: payment is out of scope).` })
  } catch {
    notify({ tone: 'danger', title: 'Checkout failed', body: 'Your seats changed. Please review them and try again.' })
    void refreshHolds()
  }
}

let warnedFor: number | null = null

/** One-minute warning, then: the shared hold timer ran out and everything I held is released. */
function checkExpiry(): void {
  const s = get()
  if (s.expiresAt === null) return
  if (s.expiresAt - Date.now() <= 60_000 && warnedFor !== s.expiresAt) {
    warnedFor = s.expiresAt
    notify({ tone: 'warning', title: 'Less than 1 minute left', body: 'Complete checkout now before your seats are released.' })
  }
  if (Date.now() < s.expiresAt) return
  const lost = [...s.holds].filter(([, status]) => status !== 'pending').map(([seat]) => seat)
  set({ expired: lost, holds: new Map(), expiresAt: null })
  void catchUp()
}

export function chooseSeatsAgain(): void {
  set({ expired: null })
}

// ------------------------------------------------------------------ notices

let noticeId = 0

function notify(notice: Omit<Notice, 'id'>, ttl = 6_000): void {
  const id = ++noticeId
  set((s) => ({ notices: [...s.notices.filter((n) => n.title !== notice.title), { ...notice, id }] }))
  setTimeout(() => dismissNotice(id), ttl)
}

export function dismissNotice(id: number): void {
  set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
}

// --------------------------------------------------------------------- dev

/** Dev only: ask the fake API to revoke one of my seats (the "lost seat" flow). */
export async function devRevokeSeat(): Promise<void> {
  await fetch('/api/__dev/revoke', { method: 'POST', headers: authHeaders() })
}

// ------------------------------------------------------------------ helpers

function withoutHold(s: SeatState, seatId: string): Pick<SeatState, 'holds' | 'expiresAt'> {
  const holds = new Map(s.holds)
  holds.delete(seatId)
  const live = [...holds.values()].some((status) => status !== 'revoked')
  return { holds, expiresAt: live ? s.expiresAt : null }
}

function without(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set)
  next.delete(id)
  return next
}

function label(seatId: string): string {
  const venue = get().venue
  return venue ? seatLabel(venue, seatId) : seatId
}
