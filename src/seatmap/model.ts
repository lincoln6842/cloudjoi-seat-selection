import type { Schemas } from '../api/client'

export type Seatmap = Schemas['Seatmap']
export type Point = [number, number]

export interface SeatInfo {
  id: string
  number: string
  row: string
  x: number
  y: number
  section: SectionInfo
}

export interface SectionInfo {
  id: string
  name: string
  shortName: string
  tier: Schemas['Tier']
  outline: Point[]
  /** Bounding box of the outline. */
  bounds: Schemas['Rect']
  seatIds: string[]
  /** Centre of the section's front row, where "tap a section" zooms to. */
  front: Point
  /** Where to draw the section label: midway down the outline at its middle x. */
  centre: Point
  /** Outline height at `centre` (arcs make it shorter than the bounds). */
  labelHeight: number
  /** Just above the front row at the section's centre: where its title goes at mid zoom. */
  titleAt: Point
  /** First and last seat of each row, for row labels. */
  rows: { label: string; first: SeatInfo; last: SeatInfo }[]
}

export interface VenueModel {
  seatmap: Seatmap
  seats: SeatInfo[]
  byId: Map<string, SeatInfo>
  sections: SectionInfo[]
  grid: Map<string, SeatInfo[]>
}

const cellKey = (gx: number, gy: number) => `${gx},${gy}`

/** Flattens the API seatmap into lookups the renderer and store need. */
export function buildModel(seatmap: Seatmap): VenueModel {
  const tiers = new Map(seatmap.tiers.map((t) => [t.id, t]))
  const seats: SeatInfo[] = []
  const sections: SectionInfo[] = []

  for (const s of seatmap.sections) {
    const tier = tiers.get(s.tier_id)
    if (!tier) throw new Error(`Section ${s.id} has unknown tier ${s.tier_id}`)
    const front = s.rows[0].seats
    const xs = s.outline.map((p) => p[0])
    const ys = s.outline.map((p) => p[1])
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2
    const [top, bottom] = verticalSpan(s.outline, midX)
    const section: SectionInfo = {
      id: s.id,
      name: s.name,
      shortName: s.short_name,
      tier,
      outline: s.outline.map(([x, y]) => [x, y] as Point),
      bounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      seatIds: [],
      front: [(front[0].x + front[front.length - 1].x) / 2, front[0].y],
      centre: [midX, (top + bottom) / 2],
      labelHeight: bottom - top,
      titleAt: [0, 0],
      rows: [],
    }
    for (const row of s.rows) {
      const rowSeats = row.seats.map((seat) => ({ ...seat, row: row.label, section }))
      seats.push(...rowSeats)
      section.seatIds.push(...rowSeats.map((seat) => seat.id))
      if (rowSeats.length > 0) section.rows.push({ label: row.label, first: rowSeats[0], last: rowSeats[rowSeats.length - 1] })
    }
    section.titleAt = [section.centre[0], Math.min(...front.map((seat) => seat.y)) - seatmap.seat_size * 0.9]
    sections.push(section)
  }

  // Spatial hash so a click checks a handful of seats, not all of them.
  const size = seatmap.seat_size
  const grid = new Map<string, SeatInfo[]>()
  for (const seat of seats) {
    const key = cellKey(Math.floor(seat.x / size), Math.floor(seat.y / size))
    const bucket = grid.get(key)
    if (bucket) bucket.push(seat)
    else grid.set(key, [seat])
  }

  return { seatmap, seats, byId: new Map(seats.map((s) => [s.id, s])), sections, grid }
}

/** The seat whose cell contains the world point, if any. The whole cell is the hit target. */
export function seatAt(model: VenueModel, x: number, y: number): SeatInfo | null {
  const size = model.seatmap.seat_size
  const half = size / 2
  const gx = Math.floor(x / size)
  const gy = Math.floor(y / size)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const seat of model.grid.get(cellKey(gx + dx, gy + dy)) ?? []) {
        if (Math.abs(seat.x - x) <= half && Math.abs(seat.y - y) <= half) return seat
      }
    }
  }
  return null
}

export function sectionAt(model: VenueModel, x: number, y: number): SectionInfo | null {
  return model.sections.find((s) => insidePolygon(s.outline, x, y)) ?? null
}

/**
 * The nearest section lying roughly in direction (dx, dy) of `from`, or null
 * if `accept` rejects it: a closed neighbour is never skipped for one further
 * away. Straight ahead beats diagonal (score cos² / distance).
 */
export function sectionToward(
  model: VenueModel,
  from: SectionInfo,
  dx: number,
  dy: number,
  accept: (s: SectionInfo) => boolean,
): SectionInfo | null {
  let best: SectionInfo | null = null
  let bestScore = 0
  const length = Math.hypot(dx, dy)
  for (const s of model.sections) {
    if (s === from) continue
    const vx = s.centre[0] - from.centre[0]
    const vy = s.centre[1] - from.centre[1]
    const distance = Math.hypot(vx, vy)
    const cos = (vx * dx + vy * dy) / (distance * length)
    if (cos < 0.5) continue // more than 60° off
    const score = (cos * cos) / distance
    if (score > bestScore) [best, bestScore] = [s, score]
  }
  return best && accept(best) ? best : null
}

/** Top and bottom where the vertical line at x crosses a polygon. */
function verticalSpan(polygon: number[][], x: number): [number, number] {
  let top = Infinity
  let bottom = -Infinity
  polygon.forEach(([x1, y1], i) => {
    const [x2, y2] = polygon[(i + 1) % polygon.length]
    if (x1 <= x === x2 <= x) return
    const y = y1 + ((x - x1) / (x2 - x1)) * (y2 - y1)
    top = Math.min(top, y)
    bottom = Math.max(bottom, y)
  })
  return [top, bottom]
}

// Ray casting.
function insidePolygon(polygon: Point[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function seatLabel(model: VenueModel, seatId: string): string {
  const seat = model.byId.get(seatId)
  return seat ? `${seat.section.name} · Row ${seat.row}, Seat ${seat.number}` : seatId
}
