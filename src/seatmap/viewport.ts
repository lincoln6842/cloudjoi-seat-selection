import type { Schemas } from '../api/client'

/** screen = world * scale + (x, y). Shared by any renderer (canvas today). */
export interface Viewport {
  scale: number
  x: number
  y: number
}

export type Lod = 'overview' | 'mid' | 'close'

// Level of detail is keyed on how big a seat cell is on screen, not on raw
// scale, so it holds for any seatmap's layout units.
export const SEATS_FROM_PX = 7 // below this, draw section blocks
export const CLOSE_FROM_PX = 28 // from here, seats are finger-sized: numbers and marks
export const CLOSE_TARGET_PX = 32 // zoom level used when jumping to close
const MAX_CELL_PX = 64

export function lodFor(scale: number, seatSize: number): Lod {
  const cell = scale * seatSize
  if (cell < SEATS_FROM_PX) return 'overview'
  return cell < CLOSE_FROM_PX ? 'mid' : 'close'
}

export function fitTo(bounds: Schemas['Rect'], width: number, height: number, padding = 16): Viewport {
  const scale = Math.min((width - 2 * padding) / bounds.width, (height - 2 * padding) / bounds.height)
  return {
    scale,
    x: (width - bounds.width * scale) / 2 - bounds.x * scale,
    y: (height - bounds.height * scale) / 2 - bounds.y * scale,
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

/** Stops the venue from being dragged entirely off screen. */
export function clampPan(vp: Viewport, bounds: Schemas['Rect'], width: number, height: number): Viewport {
  const margin = 80
  const left = bounds.x * vp.scale + vp.x
  const right = (bounds.x + bounds.width) * vp.scale + vp.x
  const top = bounds.y * vp.scale + vp.y
  const bottom = (bounds.y + bounds.height) * vp.scale + vp.y
  let { x, y } = vp
  if (right < margin) x += margin - right
  if (left > width - margin) x -= left - (width - margin)
  if (bottom < margin) y += margin - bottom
  if (top > height - margin) y -= top - (height - margin)
  return { ...vp, x, y }
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
