import type { Schemas } from '../api/client'

/** screen = world * scale + (x, y). Shared by any renderer (canvas today). */
export interface Viewport {
  scale: number
  x: number
  y: number
}

export type Lod = 'overview' | 'mid' | 'close'

// 'overview' is the all-sections level. Inside a section, detail is keyed on
// how big a seat cell is on screen, not on raw scale, so it holds for any
// seatmap's layout units.
export const CLOSE_FROM_PX = 28 // from here, seats are finger-sized: numbers and marks
export const CLOSE_TARGET_PX = 32 // zoom level used when jumping to close
const MAX_CELL_PX = 64

export function lodFor(scale: number, seatSize: number): Exclude<Lod, 'overview'> {
  return scale * seatSize < CLOSE_FROM_PX ? 'mid' : 'close'
}

/** Screen space kept free for overlays (zoom buttons, legend, hints). */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export const NO_INSETS: Insets = { top: 16, right: 16, bottom: 16, left: 16 }

/** Whole rect inside the screen minus `insets`, centred in that area. */
export function fitTo(bounds: Schemas['Rect'], width: number, height: number, insets: Insets = NO_INSETS): Viewport {
  const w = width - insets.left - insets.right
  const h = height - insets.top - insets.bottom
  const scale = Math.min(w / bounds.width, h / bounds.height)
  return {
    scale,
    x: insets.left + (w - bounds.width * scale) / 2 - bounds.x * scale,
    y: insets.top + (h - bounds.height * scale) / 2 - bounds.y * scale,
  }
}

export function toWorld(vp: Viewport, sx: number, sy: number): [number, number] {
  return [(sx - vp.x) / vp.scale, (sy - vp.y) / vp.scale]
}

export function scaleLimits(fit: Viewport, seatSize: number) {
  return { min: fit.scale, max: Math.max(fit.scale, MAX_CELL_PX / seatSize) }
}

/** Zoom by `factor`, keeping the world point under (sx, sy) fixed on screen. */
export function zoomAt(
  vp: Viewport,
  factor: number,
  sx: number,
  sy: number,
  limits: { min: number; max: number },
): Viewport {
  const scale = Math.min(limits.max, Math.max(limits.min, vp.scale * factor))
  const k = scale / vp.scale
  return { scale, x: sx - (sx - vp.x) * k, y: sy - (sy - vp.y) * k }
}

/** Viewport at `scale` with world point (wx, wy) at screen (sx, sy). */
export function centreOn(scale: number, wx: number, wy: number, sx: number, sy: number): Viewport {
  return { scale, x: sx - wx * scale, y: sy - wy * scale }
}

/**
 * Keeps `rect` covering the screen minus `insets` (plus `slack` px of what
 * lies beyond it), or centred there when it is smaller. Also returns how far
 * `vp` was past that, in px: positive x means dragged right, past the left edge.
 */
export function clampTo(
  vp: Viewport,
  rect: Schemas['Rect'],
  width: number,
  height: number,
  insets: Insets,
  slack = 0,
): { vp: Viewport; over: [number, number] } {
  const x = clampAxis(vp.x, rect.x, rect.x + rect.width, vp.scale, insets.left + slack, width - insets.right - slack)
  const y = clampAxis(vp.y, rect.y, rect.y + rect.height, vp.scale, insets.top + slack, height - insets.bottom - slack)
  return { vp: { scale: vp.scale, x, y }, over: [vp.x - x, vp.y - y] }
}

/** Screen offset keeping world span [a, b] across screen span [lo, hi]. */
function clampAxis(offset: number, a: number, b: number, scale: number, lo: number, hi: number): number {
  if ((b - a) * scale <= hi - lo) return (lo + hi) / 2 - ((a + b) / 2) * scale
  return Math.min(lo - a * scale, Math.max(hi - b * scale, offset))
}

/**
 * Tween between viewports of a width x height screen. Scale moves
 * geometrically (zoom feels even); the world point at the screen centre
 * moves in step with the scale, so zooming towards a spot stays anchored.
 */
export function lerpViewport(a: Viewport, b: Viewport, t: number, width: number, height: number): Viewport {
  const scale = a.scale * Math.pow(b.scale / a.scale, t)
  const progress = a.scale === b.scale ? t : (scale - a.scale) / (b.scale - a.scale)
  const [ax, ay] = toWorld(a, width / 2, height / 2)
  const [bx, by] = toWorld(b, width / 2, height / 2)
  return centreOn(scale, ax + (bx - ax) * progress, ay + (by - ay) * progress, width / 2, height / 2)
}
