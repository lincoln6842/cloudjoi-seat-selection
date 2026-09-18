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
  seatIds: string[]
  /** Centre of the section's front row, where "tap a section" zooms to. */
  front: Point
  /** Where to draw the section label. */
  centre: Point
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
    const section: SectionInfo = {
      id: s.id,
      name: s.name,
      shortName: s.short_name,
      tier,
      outline: s.outline.map(([x, y]) => [x, y] as Point),
      seatIds: [],
      front: [(front[0].x + front[front.length - 1].x) / 2, front[0].y],
      centre: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2],
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
