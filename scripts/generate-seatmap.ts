/**
 * Generates the demo venue served by the dev fake API:
 *   mock/data/seatmap.json      GET /events/{id}/seatmap
 *   mock/data/availability.json initial unavailable seats (API snapshot format)
 *
 * Deterministic (seeded PRNG), so re-running produces identical files.
 * Usage: node scripts/generate-seatmap.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'

type Point = [number, number]
type Seat = { id: string; number: string; x: number; y: number }
type Row = { label: string; seats: Seat[] }

const SEAT = 26 // seat cell size in layout units
const ROW_STEP = 30 // distance between rows (a little legroom)
const AISLE = 2 * SEAT // aisle width between sections
const TIER_GAP = 5 * ROW_STEP // room for section titles above curved rows
const CURVE = 0.0001 // rows bow away from the stage: y += CURVE * x^2
const PAD = 10 // outline padding around seats

const tiers = [
  { key: 'O', name: 'Orchestra', short: 'Orch', rows: 20, side: 26, centre: 30, tiers: ['orch-sides', 'orch-centre'] },
  { key: 'M', name: 'Mezzanine', short: 'Mezz', rows: 18, side: 26, centre: 30, tiers: ['mezz-sides', 'mezz-centre'] },
  { key: 'B', name: 'Balcony', short: 'Balc', rows: 18, side: 26, centre: 30, tiers: ['balc-sides', 'balc-centre'] },
]

const priceTiers = [
  { id: 'orch-centre', name: 'Orchestra Centre', price: 15000 },
  { id: 'orch-sides', name: 'Orchestra Sides', price: 12000 },
  { id: 'mezz-centre', name: 'Mezzanine Centre', price: 9000 },
  { id: 'mezz-sides', name: 'Mezzanine Sides', price: 7500 },
  { id: 'balc-centre', name: 'Balcony Centre', price: 5500 },
  { id: 'balc-sides', name: 'Balcony Sides', price: 4500 },
]

// Share of seats already unavailable when the demo starts, per section.
// Chosen so the overview shows every chip state: plenty, "Only N left", sold out.
const initiallyTaken: Record<string, number> = {
  OL: 0.3, OC: 0.35, OR: 0.3,
  ML: 0.96, MC: 0.6, MR: 0.97,
  BL: 1, BC: 0.2, BR: 0.25,
}

function round(n: number) {
  return Math.round(n * 10) / 10
}

// Row labels skip I and O (easily confused with 1 and 0), then double up: AA, BB...
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
function rowLabel(i: number) {
  return LETTERS[i % LETTERS.length].repeat(Math.floor(i / LETTERS.length) + 1)
}

const curveY = (x: number, rowY: number) => rowY + CURVE * x * x

/** Outline hugging the first and last row, following the row curve. */
function sectionOutline(left: number, right: number, firstY: number, lastY: number): Point[] {
  const half = SEAT / 2 + PAD
  const xs = Array.from({ length: 9 }, (_, i) => left - half + ((right - left + 2 * half) * i) / 8)
  const points: Point[] = [
    ...xs.map((x): Point => [x, curveY(x, firstY) - half]),
    ...xs.reverse().map((x): Point => [x, curveY(x, lastY) + half]),
  ]
  return points.map(([x, y]) => [round(x), round(y)])
}

const sections = []
let rowY = 170

for (const tier of tiers) {
  const width = (2 * tier.side + tier.centre) * SEAT + 2 * AISLE
  const left = -width / 2
  const parts = [
    { code: `${tier.key}L`, suffix: 'Left', tier: tier.tiers[0], count: tier.side, x0: left },
    { code: `${tier.key}C`, suffix: 'Centre', tier: tier.tiers[1], count: tier.centre, x0: left + tier.side * SEAT + AISLE },
    { code: `${tier.key}R`, suffix: 'Right', tier: tier.tiers[0], count: tier.side, x0: width / 2 - tier.side * SEAT },
  ]

  for (const part of parts) {
    const firstX = part.x0 + SEAT / 2
    const lastX = firstX + (part.count - 1) * SEAT
    const rows: Row[] = Array.from({ length: tier.rows }, (_, r) => {
      const label = rowLabel(r)
      const y = rowY + r * ROW_STEP
      return {
        label,
        seats: Array.from({ length: part.count }, (_, n) => {
          const x = firstX + n * SEAT
          return { id: `${part.code}-${label}-${n + 1}`, number: String(n + 1), x: round(x), y: round(curveY(x, y)) }
        }),
      }
    })
    sections.push({
      id: part.code,
      name: `${tier.name} ${part.suffix}`,
      short_name: `${tier.short} ${part.suffix === 'Centre' ? 'C' : part.suffix}`,
      tier_id: part.tier,
      outline: sectionOutline(firstX, lastX, rowY, rowY + (tier.rows - 1) * ROW_STEP),
      rows,
    })
  }
  rowY += tier.rows * ROW_STEP + TIER_GAP
}

const stage = { x: -400, y: -10, width: 800, height: 110 }
const allPoints = sections.flatMap((s) => s.outline)
const minX = Math.min(stage.x, ...allPoints.map((p) => p[0]))
const maxX = Math.max(stage.x + stage.width, ...allPoints.map((p) => p[0]))
const maxY = Math.max(...allPoints.map((p) => p[1]))
const margin = 40
const bounds = {
  x: round(minX - margin),
  y: stage.y - margin,
  width: round(maxX - minX + 2 * margin),
  height: round(maxY - stage.y + 2 * margin),
}

const seatmap = {
  event: {
    id: '1',
    name: 'The Phantom of the Opera',
    venue: 'CloudJoi Grand Hall',
    starts_at: '2026-10-24T12:00:00Z',
    currency: 'MYR',
  },
  seat_size: SEAT,
  bounds,
  stage,
  tiers: priceTiers,
  sections,
}

// mulberry32: tiny seeded PRNG so the generated files are reproducible.
let seed = 20261024
function random() {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const unavailable = sections.flatMap((s) =>
  s.rows.flatMap((r) => r.seats).filter(() => random() < initiallyTaken[s.id]).map((seat) => seat.id),
)

mkdirSync('mock/data', { recursive: true })
writeFileSync('mock/data/seatmap.json', JSON.stringify(seatmap))
writeFileSync('mock/data/availability.json', JSON.stringify({ unavailable }, null, 1))

const seatCount = sections.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.seats.length, 0), 0)
const fit = (w: number, h: number) => Math.min(w / bounds.width, h / bounds.height)
console.log(`${seatCount} seats, ${unavailable.length} initially unavailable`)
console.log(`bounds ${bounds.width} x ${bounds.height}`)
for (const [label, w, h] of [['desktop map 1000x840', 1000, 840], ['phone 358x600', 358, 600]] as const) {
  console.log(`${label}: fit scale ${fit(w, h).toFixed(3)}, seat cell ${(fit(w, h) * SEAT).toFixed(1)}px`)
}
for (const s of sections) {
  const n = s.rows.reduce((m, r) => m + r.seats.length, 0)
  console.log(`  ${s.id} ${s.name.padEnd(18)} ${String(n).padStart(4)} seats, ${s.rows.length} rows`)
}
