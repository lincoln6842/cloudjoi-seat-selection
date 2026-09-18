import { formatMoney } from '../lib/money'
import type { SeatState, SeatStatus } from '../state/seats'
import { seatStatus } from '../state/seats'
import type { Store } from '../state/store'
import { seatAt, sectionAt, type SeatInfo, type SectionInfo, type VenueModel } from './model'
import { colors, FADE_MS, fallbackTierColor, fonts, LOW_STOCK, SEAT_FILL, tierColors } from './theme'
import {
  CLOSE_TARGET_PX,
  clampPan,
  centreOn,
  fitTo,
  lerpViewport,
  lodFor,
  scaleLimits,
  toWorld,
  zoomAt,
  type Insets,
  type Lod,
  type Viewport,
} from './viewport'

export interface RendererCallbacks {
  onSeatClick(seatId: string): void
  /** Mouse hover over a seat (null when leaving one), in canvas CSS pixels. */
  onHover(seat: SeatInfo | null, x: number, y: number): void
  onLodChange(lod: Lod): void
}

const MAX_DPR = 2 // 3x phone screens cost 2.25x the pixels for no visible gain
const DRAG_THRESHOLD = 6
const ANIMATION_MS = 350

/**
 * Draws the seat map on one <canvas> and handles pan/zoom/tap. Framework
 * free: React mounts it, the store drives it, and it only redraws (at most
 * once per frame) when something changed.
 */
export class SeatMapRenderer {
  private readonly ctx: CanvasRenderingContext2D
  private width = 0
  private height = 0
  private dpr = 1
  private vp: Viewport = { scale: 1, x: 0, y: 0 }
  private fitVp: Viewport = { scale: 1, x: 0, y: 0 }
  private userMoved = false
  private lod: Lod | null = null
  private frame = 0
  private animation: { from: Viewport; to: Viewport; start: number } | null = null
  private hovered: SeatInfo | null = null
  private readonly fades = new Map<string, number>()
  private sectionLeft = new Map<string, number>()
  private previousUnavailable: ReadonlySet<string>
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private gesture: { start: Viewport; x: number; y: number; distance: number; moved: boolean } | null = null
  private readonly cleanup: (() => void)[] = []
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  private readonly canvas: HTMLCanvasElement
  private readonly model: VenueModel
  private readonly store: Store<SeatState>
  private readonly callbacks: RendererCallbacks
  private insets: Insets

  constructor(canvas: HTMLCanvasElement, model: VenueModel, store: Store<SeatState>, callbacks: RendererCallbacks, insets: Insets) {
    this.canvas = canvas
    this.insets = insets
    this.model = model
    this.store = store
    this.callbacks = callbacks
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D is not available')
    this.ctx = ctx
    this.previousUnavailable = store.get().unavailable
    this.countSectionsLeft()

    const observer = new ResizeObserver(() => this.resize())
    observer.observe(canvas)
    this.cleanup.push(() => observer.disconnect())
    this.cleanup.push(store.subscribe(() => this.onStoreChange()))
    this.listen('pointerdown', this.onPointerDown)
    this.listen('pointermove', this.onPointerMove)
    this.listen('pointerup', this.onPointerUp)
    this.listen('pointercancel', this.onPointerUp)
    this.listen('pointerleave', this.onPointerLeave)
    this.listen('wheel', this.onWheel, { passive: false })
    // Canvas text needs the web fonts; draw again once they arrive.
    void document.fonts?.ready.then(() => this.invalidate())
    this.resize()
  }

  destroy(): void {
    cancelAnimationFrame(this.frame)
    this.cleanup.forEach((fn) => fn())
  }

  zoomIn(): void {
    this.animateTo(zoomAt(this.vp, 1.6, this.width / 2, this.height / 2, this.limits()))
  }

  zoomOut(): void {
    this.animateTo(zoomAt(this.vp, 1 / 1.6, this.width / 2, this.height / 2, this.limits()))
  }

  setInsets(insets: Insets): void {
    this.insets = insets
    this.resize()
  }

  fit(): void {
    this.userMoved = false
    this.animateTo(this.fitVp)
  }

  // ------------------------------------------------------------ plumbing

  private listen<K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const bound = handler.bind(this)
    this.canvas.addEventListener(type, bound, options)
    this.cleanup.push(() => this.canvas.removeEventListener(type, bound))
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    this.width = rect.width
    this.height = rect.height
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    this.canvas.width = Math.round(rect.width * this.dpr)
    this.canvas.height = Math.round(rect.height * this.dpr)
    this.fitVp = fitTo(this.model.seatmap.bounds, this.width, this.height, this.insets)
    this.setViewport(this.userMoved ? this.vp : this.fitVp)
  }

  private limits() {
    return scaleLimits(this.fitVp, this.model.seatmap.seat_size)
  }

  private setViewport(vp: Viewport): void {
    this.updateViewport(vp)
    this.invalidate()
  }

  private updateViewport(vp: Viewport): void {
    this.vp = clampPan(vp, this.model.seatmap.bounds, this.width, this.height)
    const lod = lodFor(this.vp.scale, this.model.seatmap.seat_size)
    if (lod !== this.lod) {
      this.lod = lod
      this.callbacks.onLodChange(lod)
    }
  }

  private animateTo(target: Viewport): void {
    if (this.reducedMotion.matches) return this.setViewport(target)
    this.animation = { from: this.vp, to: target, start: performance.now() }
    this.invalidate()
  }

  private invalidate(): void {
    if (!this.frame) this.frame = requestAnimationFrame((t) => this.draw(t))
  }

  private onStoreChange(): void {
    const { unavailable } = this.store.get()
    if (unavailable !== this.previousUnavailable) {
      if (!this.reducedMotion.matches) {
        const now = performance.now()
        for (const id of unavailable) if (!this.previousUnavailable.has(id)) this.fades.set(id, now)
      }
      this.previousUnavailable = unavailable
      this.countSectionsLeft()
    }
    this.invalidate()
  }

  private countSectionsLeft(): void {
    const { unavailable } = this.store.get()
    this.sectionLeft = new Map(
      this.model.sections.map((s) => [s.id, s.seatIds.reduce((n, id) => n + (unavailable.has(id) ? 0 : 1), 0)]),
    )
  }

  // ------------------------------------------------------------- input

  private point(e: PointerEvent | WheelEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    this.canvas.setPointerCapture(e.pointerId)
    const [x, y] = this.point(e)
    this.pointers.set(e.pointerId, { x, y })
    this.animation = null
    this.gesture = { start: this.vp, ...this.centroid(), moved: this.pointers.size > 1 }
  }

  private onPointerMove(e: PointerEvent): void {
    const [x, y] = this.point(e)
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') this.hover(x, y)
      return
    }
    this.pointers.set(e.pointerId, { x, y })
    const g = this.gesture
    if (!g) return
    const c = this.centroid()
    if (!g.moved && Math.hypot(c.x - g.x, c.y - g.y) < DRAG_THRESHOLD) return
    g.moved = true
    this.userMoved = true
    this.hover(-1, -1)
    // Pinch scales around the fingers' midpoint; one pointer just pans.
    const factor = g.distance > 0 && c.distance > 0 ? c.distance / g.distance : 1
    const zoomed = zoomAt(g.start, factor, g.x, g.y, this.limits())
    this.setViewport({ ...zoomed, x: zoomed.x + c.x - g.x, y: zoomed.y + c.y - g.y })
  }

  private onPointerUp(e: PointerEvent): void {
    const g = this.gesture
    const wasTap = g !== null && !g.moved && this.pointers.size === 1
    this.pointers.delete(e.pointerId)
    // Remaining finger of a pinch carries on panning from here.
    this.gesture = this.pointers.size > 0 ? { start: this.vp, ...this.centroid(), moved: true } : null
    if (wasTap && e.type === 'pointerup') this.tap(...this.point(e), e.pointerType)
  }

  private onPointerLeave(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && !this.pointers.size) this.hover(-1, -1)
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    this.animation = null
    this.userMoved = true
    const [x, y] = this.point(e)
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))
    this.setViewport(zoomAt(this.vp, factor, x, y, this.limits()))
    this.hover(x, y) // a different seat is under the cursor now
  }

  private centroid() {
    const pts = [...this.pointers.values()]
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length
    const distance = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0
    return { x, y, distance }
  }

  private hover(x: number, y: number): void {
    const seat = this.lod === 'overview' || x < 0 ? null : seatAt(this.model, ...toWorld(this.vp, x, y))
    if (seat !== this.hovered) {
      this.hovered = seat
      this.canvas.style.cursor = seat && this.isClickable(seat) ? 'pointer' : ''
      this.invalidate()
    }
    this.callbacks.onHover(seat, x, y)
  }

  private isClickable(seat: SeatInfo): boolean {
    return seatStatus(this.store.get(), seat.id) !== 'unavailable'
  }

  private tap(x: number, y: number, pointerType: string): void {
    const [wx, wy] = toWorld(this.vp, x, y)
    const closeScale = CLOSE_TARGET_PX / this.model.seatmap.seat_size
    if (this.lod === 'overview') {
      const section = sectionAt(this.model, wx, wy)
      if (section && (this.sectionLeft.get(section.id) ?? 0) > 0) this.zoomToSection(section)
      return
    }
    // Mid-zoom seats are too small for fingers: zoom in on the spot instead.
    if (this.lod === 'mid' && pointerType !== 'mouse') {
      this.userMoved = true
      return this.animateTo(centreOn(closeScale, wx, wy, x, y))
    }
    const seat = seatAt(this.model, wx, wy)
    if (seat) this.callbacks.onSeatClick(seat.id)
  }

  private zoomToSection(section: SectionInfo): void {
    this.userMoved = true
    const scale = CLOSE_TARGET_PX / this.model.seatmap.seat_size
    this.animateTo(centreOn(scale, section.front[0], section.front[1], this.width / 2, this.height * 0.3))
  }

  // ------------------------------------------------------------- drawing

  private draw(now: number): void {
    this.frame = 0
    if (this.animation) {
      const t = Math.min(1, (now - this.animation.start) / ANIMATION_MS)
      const eased = 1 - Math.pow(1 - t, 3)
      this.updateViewport(lerpViewport(this.animation.from, this.animation.to, eased, this.width, this.height))
      if (t >= 1) this.animation = null
    }

    const { ctx } = this
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    this.drawStage()
    if (this.lod === 'overview') this.drawSectionBlocks()
    else this.drawSeats(now)

    for (const [id, start] of this.fades) if (now - start > FADE_MS) this.fades.delete(id)
    if (this.animation || this.fades.size > 0) this.invalidate()
  }

  private sx(x: number) {
    return x * this.vp.scale + this.vp.x
  }

  private sy(y: number) {
    return y * this.vp.scale + this.vp.y
  }

  private drawStage(): void {
    const { stage } = this.model.seatmap
    const { ctx } = this
    const x = this.sx(stage.x)
    const y = this.sy(stage.y)
    const w = stage.width * this.vp.scale
    const h = stage.height * this.vp.scale
    const r = Math.min(20 * this.vp.scale, h / 2)
    ctx.fillStyle = colors.stage
    roundedRect(ctx, x, y, w, h, r)
    ctx.fill()
    const size = Math.min(h * 0.35, 18)
    if (size >= 7) {
      ctx.fillStyle = colors.paper
      ctx.font = `700 ${size}px ${fonts.sans}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(spaced('★ STAGE ★'), x + w / 2, y + h / 2)
    }
  }

  private drawSectionBlocks(): void {
    const { ctx } = this
    for (const section of this.model.sections) {
      const left = this.sectionLeft.get(section.id) ?? 0
      const soldOut = left === 0
      if (!soldOut) {
        tracePolygon(ctx, section.outline, (x) => this.sx(x) + 3, (y) => this.sy(y) + 3)
        ctx.fillStyle = colors.ink
        ctx.fill()
      }
      tracePolygon(ctx, section.outline, (x) => this.sx(x), (y) => this.sy(y))
      ctx.fillStyle = soldOut ? colors.soldOut : tierColors[section.tier.id] ?? fallbackTierColor
      ctx.fill()
      ctx.lineWidth = 2.5
      ctx.strokeStyle = soldOut ? colors.soldOutStroke : colors.ink
      ctx.stroke()
      this.drawSectionLabel(section, left)
    }
  }

  private drawSectionLabel(section: SectionInfo, left: number): void {
    const { ctx } = this
    const cx = this.sx(section.centre[0])
    const cy = this.sy(section.centre[1])
    const xs = section.outline.map((p) => p[0])
    const widthPx = (Math.max(...xs) - Math.min(...xs)) * this.vp.scale
    const size = Math.max(9, Math.min(14, widthPx / 11))
    if (widthPx < 60) return
    const soldOut = left === 0
    const price = formatMoney(section.tier.price, this.model.seatmap.event.currency, true)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `700 ${size}px ${fonts.sans}`
    const name = section.shortName.toUpperCase()
    const boxW = Math.max(ctx.measureText(name).width, ctx.measureText(price).width) + size * 1.6
    const boxH = size * 3
    if (!soldOut) {
      ctx.fillStyle = colors.paper
      roundedRect(ctx, cx - boxW / 2, cy - boxH / 2 - size * 0.6, boxW, boxH, 6)
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = colors.ink
      ctx.stroke()
    }
    ctx.fillStyle = soldOut ? colors.soldOutText : colors.ink
    ctx.fillText(name, cx, cy - size * 1.1)
    ctx.font = `700 ${size * 0.95}px ${fonts.mono}`
    ctx.fillText(price, cx, cy + size * 0.2)

    const chip = soldOut ? 'SOLD OUT' : left <= LOW_STOCK ? `Only ${left} left` : `${left} left`
    ctx.font = `700 ${size * 0.8}px ${fonts.sans}`
    const chipW = ctx.measureText(chip).width + size * 1.2
    const chipH = size * 1.5
    const chipY = cy + boxH / 2 + size * 0.1
    ctx.fillStyle = soldOut ? colors.soldOutStroke : left <= LOW_STOCK ? colors.chipLow : colors.paper
    roundedRect(ctx, cx - chipW / 2, chipY, chipW, chipH, 4)
    ctx.fill()
    if (!soldOut) {
      ctx.lineWidth = 1.5
      ctx.strokeStyle = colors.ink
      ctx.stroke()
    }
    ctx.fillStyle = soldOut ? colors.paper : colors.ink
    ctx.fillText(chip, cx, chipY + chipH / 2)
  }

  private drawSeats(now: number): void {
    const { ctx } = this
    const state = this.store.get()
    const cell = this.model.seatmap.seat_size * this.vp.scale
    const close = this.lod === 'close'
    const size = cell * SEAT_FILL
    const half = size / 2
    const radius = size * (close ? 0.22 : 0.18)
    const margin = cell
    const visible = (seat: SeatInfo) => {
      const x = this.sx(seat.x)
      const y = this.sy(seat.y)
      return x > -margin && x < this.width + margin && y > -margin && y < this.height + margin
    }

    this.drawSectionTitles(close)

    // Mid zoom: thousands of seats. Batch one path per fill colour so the
    // whole map is a handful of draw calls.
    if (!close) {
      const batches = new Map<string, SeatInfo[]>()
      for (const seat of this.model.seats) {
        if (!visible(seat)) continue
        const fill = this.fillFor(seat, seatStatus(state, seat.id), now)
        const batch = batches.get(fill)
        if (batch) batch.push(seat)
        else batches.set(fill, [seat])
      }
      for (const [fill, seats] of batches) {
        ctx.beginPath()
        for (const seat of seats) rectPath(ctx, this.sx(seat.x) - half, this.sy(seat.y) - half, size, size, radius)
        ctx.fillStyle = fill
        ctx.fill()
        if (size >= 8) {
          ctx.lineWidth = 1
          ctx.strokeStyle = fill === colors.unavailable ? colors.unavailableStroke : colors.ink
          ctx.stroke()
        }
      }
      for (const seat of this.model.seats) {
        const status = seatStatus(state, seat.id)
        if ((status === 'selected' || status === 'lost' || seat === this.hovered) && visible(seat)) {
          this.drawSeatMark(seat, status, size)
        }
      }
      return
    }

    // Close zoom: only ~100 seats on screen, so draw each in full detail.
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const seat of this.model.seats) {
      if (!visible(seat)) continue
      const status = seatStatus(state, seat.id)
      const hovered = seat === this.hovered && status !== 'unavailable'
      const s = hovered ? size * 1.08 : size
      const x = this.sx(seat.x) - s / 2
      const y = this.sy(seat.y) - s / 2
      const taken = status === 'unavailable'
      if (!taken) {
        ctx.fillStyle = colors.ink
        roundedRect(ctx, x + (hovered ? 4 : 2), y + (hovered ? 4 : 2), s, s, radius)
        ctx.fill()
      }
      ctx.fillStyle = this.fillFor(seat, status, now)
      roundedRect(ctx, x, y, s, s, radius)
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = taken ? colors.unavailableStroke : colors.ink
      ctx.setLineDash(status === 'pending' ? [4, 3] : [])
      ctx.stroke()
      ctx.setLineDash([])
      this.drawSeatMark(seat, status, s)
    }
    this.drawRowLabels(size, radius)
  }

  private fillFor(seat: SeatInfo, status: SeatStatus, now: number): string {
    switch (status) {
      case 'selected':
        return colors.selected
      case 'pending':
        return colors.pending
      case 'lost':
        return colors.lost
      case 'unavailable': {
        const start = this.fades.get(seat.id)
        const tier = tierColors[seat.section.tier.id] ?? fallbackTierColor
        return start === undefined ? colors.unavailable : mix(tier, colors.unavailable, (now - start) / FADE_MS)
      }
      default:
        return tierColors[seat.section.tier.id] ?? fallbackTierColor
    }
  }

  private drawSeatMark(seat: SeatInfo, status: SeatStatus, size: number): void {
    const { ctx } = this
    const x = this.sx(seat.x)
    const y = this.sy(seat.y)
    if (this.lod !== 'close') {
      // Mid zoom: just enough to tell states apart without colour.
      if (seat === this.hovered && status !== 'unavailable') {
        ctx.lineWidth = 2
        ctx.strokeStyle = colors.ink
        ctx.strokeRect(x - size / 2 - 1, y - size / 2 - 1, size + 2, size + 2)
      }
      if (size >= 9 && status === 'selected') drawCheck(ctx, x, y, size * 0.55, colors.ink)
      if (size >= 9 && status === 'lost') drawCross(ctx, x, y, size * 0.45, colors.paper)
      return
    }
    const numberSize = size * 0.36
    ctx.font = `700 ${numberSize}px ${fonts.sans}`
    switch (status) {
      case 'selected':
        drawCheck(ctx, x, y - size * 0.15, size * 0.32, colors.ink)
        ctx.fillStyle = colors.ink
        ctx.font = `700 ${numberSize * 0.85}px ${fonts.sans}`
        ctx.fillText(seat.number, x, y + size * 0.22)
        break
      case 'lost':
        drawCross(ctx, x, y, size * 0.36, colors.paper)
        break
      case 'unavailable':
        drawBlocked(ctx, x, y, size * 0.2, colors.unavailableStroke)
        break
      default:
        ctx.fillStyle = colors.ink
        ctx.fillText(seat.number, x, y + 1)
    }
  }

  private drawSectionTitles(close: boolean): void {
    if (close) return
    const { ctx } = this
    const currency = this.model.seatmap.event.currency
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.font = `700 11px ${fonts.sans}`
    for (const section of this.model.sections) {
      const soldOut = (this.sectionLeft.get(section.id) ?? 0) === 0
      ctx.fillStyle = soldOut ? colors.soldOutText : colors.ink
      const text = `${section.shortName.toUpperCase()} • ${formatMoney(section.tier.price, currency, true)}${soldOut ? ' (SOLD OUT)' : ''}`
      ctx.fillText(text, this.sx(section.titleAt[0]), this.sy(section.titleAt[1]))
    }
  }

  private drawRowLabels(size: number, radius: number): void {
    const { ctx } = this
    ctx.font = `700 ${size * 0.4}px ${fonts.sans}`
    for (const section of this.model.sections) {
      for (const row of section.rows) {
        const x = this.sx(row.first.x) - size * 1.25
        const y = this.sy(row.first.y)
        if (x < -size || x > this.width + size || y < -size || y > this.height + size) continue
        const holdsHere = [...this.store.get().holds.keys()].some((id) => {
          const seat = this.model.byId.get(id)
          return seat?.section === section && seat.row === row.label
        })
        ctx.fillStyle = holdsHere ? colors.selected : colors.ink
        roundedRect(ctx, x - size * 0.4, y - size * 0.4, size * 0.8, size * 0.8, radius * 0.8)
        ctx.fill()
        ctx.fillStyle = holdsHere ? colors.ink : colors.paper
        ctx.fillText(row.label, x, y + 1)
      }
    }
  }
}

// ---------------------------------------------------------------- helpers

function tracePolygon(ctx: CanvasRenderingContext2D, points: [number, number][], sx: (x: number) => number, sy: (y: number) => number): void {
  ctx.beginPath()
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(sx(x), sy(y)) : ctx.lineTo(sx(x), sy(y))))
  ctx.closePath()
}

/** Rounded rect path without ctx.roundRect (missing before Safari 16). */
function rectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  rectPath(ctx, x, y, w, h, r)
}

function drawCheck(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.beginPath()
  ctx.moveTo(x - size * 0.5, y)
  ctx.lineTo(x - size * 0.15, y + size * 0.35)
  ctx.lineTo(x + size * 0.5, y - size * 0.35)
  ctx.lineWidth = Math.max(1.5, size * 0.18)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = color
  ctx.stroke()
}

function drawCross(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.beginPath()
  ctx.moveTo(x - size / 2, y - size / 2)
  ctx.lineTo(x + size / 2, y + size / 2)
  ctx.moveTo(x + size / 2, y - size / 2)
  ctx.lineTo(x - size / 2, y + size / 2)
  ctx.lineWidth = Math.max(1.5, size * 0.2)
  ctx.lineCap = 'round'
  ctx.strokeStyle = color
  ctx.stroke()
}

/** ⊘: a circle with a slash. */
function drawBlocked(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.moveTo(x - r * 0.7, y + r * 0.7)
  ctx.lineTo(x + r * 0.7, y - r * 0.7)
  ctx.lineWidth = Math.max(1.2, r * 0.25)
  ctx.strokeStyle = color
  ctx.stroke()
}

/** Blend two #rrggbb colours; t in [0, 1]. */
function mix(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t))
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const c = [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * k))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

function spaced(text: string): string {
  return text.split('').join(' ')
}
