// Design tokens from docs/design (sheet 08 + handoff README). Canvas can't
// read CSS variables cheaply per frame, so seat-map colours live here.

export const tierColors: Record<string, string> = {
  'orch-centre': '#FFB703',
  'orch-sides': '#FB8500',
  'mezz-centre': '#06D6A0',
  'mezz-sides': '#118AB2',
  'balc-centre': '#9D4EDD',
  'balc-sides': '#FF70A6',
}
export const fallbackTierColor = '#FFB703'

export const colors = {
  ink: '#000000',
  paper: '#FFFFFF',
  stage: '#111111',
  selected: '#CCFF00',
  pending: 'rgba(204, 255, 0, 0.5)',
  unavailable: '#E2E8F0',
  unavailableStroke: '#94A3B8',
  lost: '#FF4D4D',
  soldOut: '#CBD5E1',
  soldOutStroke: '#64748B',
  soldOutText: '#64748B',
  chipLow: '#FFD166',
}

export const fonts = {
  sans: '"Space Grotesk", system-ui, sans-serif',
  mono: '"Space Mono", ui-monospace, monospace',
}

/** Seat drawn at this share of its cell; the full cell is the hit target (28px in 32px). */
export const SEAT_FILL = 0.875
/** Section availability chip turns to "Only N left" at or below this. */
export const LOW_STOCK = 25
/** Seat fade to "unavailable" when someone else takes it. */
export const FADE_MS = 300
