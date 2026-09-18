import { describe, expect, it } from 'vitest'
import { buildModel, seatAt, sectionAt, type Seatmap } from './model'
import { clampPan, fitTo, lerpViewport, lodFor, toWorld, zoomAt } from './viewport'

// Two sections side by side, 2 rows x 3 seats each, 10-unit cells.
const seatmap: Seatmap = {
  event: { id: '1', name: 'Test', venue: 'Hall', starts_at: '2026-01-01T00:00:00Z', currency: 'MYR' },
  seat_size: 10,
  bounds: { x: 0, y: 0, width: 100, height: 40 },
  stage: { x: 0, y: 0, width: 100, height: 5 },
  tiers: [{ id: 't', name: 'Tier', price: 1000 }],
  sections: ['A', 'B'].map((id, s) => ({
    id,
    name: `Section ${id}`,
    short_name: id,
    tier_id: 't',
    outline: [
      [s * 50, 10],
      [s * 50 + 40, 10],
      [s * 50 + 40, 30],
      [s * 50, 30],
    ],
    rows: ['A', 'B'].map((label, r) => ({
      label,
      seats: [0, 1, 2].map((n) => ({ id: `${id}-${label}-${n + 1}`, number: String(n + 1), x: s * 50 + 5 + n * 10, y: 15 + r * 10 })),
    })),
  })),
}
const model = buildModel(seatmap)

describe('seat hit testing', () => {
  it('hits the seat whose cell contains the point, edges included', () => {
    expect(seatAt(model, 5, 15)?.id).toBe('A-A-1')
    expect(seatAt(model, 9.9, 19.9)?.id).toBe('A-A-1')
    expect(seatAt(model, 25, 25)?.id).toBe('A-B-3')
    expect(seatAt(model, 65, 15)?.id).toBe('B-A-2')
  })

  it('misses aisles and empty space', () => {
    expect(seatAt(model, 42, 15)).toBeNull()
    expect(seatAt(model, 5, 3)).toBeNull()
  })

  it('finds sections by outline', () => {
    expect(sectionAt(model, 20, 20)?.id).toBe('A')
    expect(sectionAt(model, 70, 20)?.id).toBe('B')
    expect(sectionAt(model, 45, 20)).toBeNull()
  })

  it('records the front row centre of each section', () => {
    expect(model.sections[0].front).toEqual([15, 15])
  })
})

describe('viewport', () => {
  it('fits the venue and centres it', () => {
    const vp = fitTo(seatmap.bounds, 220, 100, { top: 10, right: 10, bottom: 10, left: 10 })
    expect(vp.scale).toBe(2)
    expect(toWorld(vp, 110, 50)).toEqual([50, 20])
  })

  it('zooms around the pointer, within limits', () => {
    const vp = { scale: 1, x: 0, y: 0 }
    const zoomed = zoomAt(vp, 2, 50, 20, { min: 0.5, max: 4 })
    expect(toWorld(zoomed, 50, 20)).toEqual([50, 20])
    expect(zoomAt(vp, 100, 0, 0, { min: 0.5, max: 4 }).scale).toBe(4)
  })

  it('picks detail level from on-screen seat size', () => {
    expect(lodFor(0.5, 10)).toBe('overview')
    expect(lodFor(1, 10)).toBe('mid')
    expect(lodFor(3, 10)).toBe('close')
  })

  it('keeps the venue from being dragged off screen', () => {
    const lost = clampPan({ scale: 1, x: -1000, y: 0 }, seatmap.bounds, 200, 100)
    expect(lost.x).toBeGreaterThan(-1000)
  })

  it('tweens from start to end', () => {
    const a = { scale: 1, x: 0, y: 0 }
    const b = { scale: 4, x: -100, y: -40 }
    expect(lerpViewport(a, b, 0, 200, 100)).toEqual(a)
    const end = lerpViewport(a, b, 1, 200, 100)
    expect(end.scale).toBeCloseTo(4)
    expect(end.x).toBeCloseTo(-100)
    expect(end.y).toBeCloseTo(-40)
  })
})
