import { formatMoney } from '../lib/money'
import type { SeatState, SeatStatus } from '../state/seats'
import { seatStatus } from '../state/seats'
import type { Store } from '../state/store'
import { seatAt, sectionAt, sectionToward, type SeatInfo, type SectionInfo, type VenueModel } from './model'
import { colors, FADE_MS, fallbackTierColor, fonts, LOW_STOCK, SEAT_FILL, tierColors } from './theme'
import {
  CLOSE_TARGET_PX,
  clampTo,
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
  /** Entered a section (level 2), or back to all sections (null). */
  onZoneChange(zone: SectionInfo | null): void
  /** Dragging against the section's edge towards another section, or null once not. */
  onEdge(edge: Edge | null): void
}

export interface Edge {
  section: SectionInfo
  side: 'left' | 'right' | 'top' | 'bottom'
}

const MAX_DPR = 2 // 3x phone screens cost 2.25x the pixels for no visible gain
const DRAG_THRESHOLD = 6
const ANIMATION_MS = 350
const ZONE_SLACK = 24 // px of the neighbouring sections allowed in view past the section's edge
const EDGE_PUSH_PX = 60 // drag this far past the edge to be offered the next section
const BLUR_DOWNSCALE = 4 // other sections render at 1/4 size, then scale up soft
const OUTSIDE_ALPHA = 0.45
const ZONE_MIN_ZOOM = 0.6 // zoom out past the fitted section, to see the blurred venue around it

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
  /** The section being shown (level 2); null shows all sections (level 1). */
  private zone: SectionInfo | null = null
  private edge: Edge | null = null
  private lod: Lod = 'overview'
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
  private readonly coarsePointer = matchMedia('(pointer: coarse)')
  private readonly blur = document.createElement('canvas')
  private readonly blurCtx: CanvasRenderingContext2D
  private readonly canvas: HTMLCanvasElement
  private readonly model: VenueModel
  private readonly store: Store<SeatState>
  private readonly callbacks: RendererCallbacks
  private insets: Insets
  /** The whole-venue view may use more of the screen (e.g. no legend over it on a phone). */
  private overviewInsets: Insets

  constructor(
    canvas: HTMLCanvasElement,
    model: VenueModel,
    store: Store<SeatState>,
    callbacks: RendererCallbacks,
    insets: Insets,
    overviewInsets = insets,
  ) {
    this.canvas = canvas
    this.insets = insets
    this.overviewInsets = overviewInsets
    this.model = model
    this.store = store
    this.callbacks = callbacks
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D is not available')
    this.ctx = ctx
    const blurCtx = this.blur.getContext('2d')
    if (!blurCtx) throw new Error('Canvas 2D is not available')
    this.blurCtx = blurCtx
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

  setInsets(insets: Insets, overviewInsets = insets): void {
    this.insets = insets
    this.overviewInsets = overviewInsets
    this.resize()
  }

  /** Back to the whole section (level 2), or the whole venue (level 1). */
  fit(): void {
    this.animateTo(this.zone ? this.zoneFit(this.zone) : this.fitVp)
  }

  /** Level 2: zoom into one section; other sections blur out. */
  enterZone(section: SectionInfo): void {
    // The go-to pill outlives its offer; the section may have sold out since.
    if (!this.isOpen(section)) return this.setEdge(null)
    this.zone = section
    this.setEdge(null)
    this.callbacks.onZoneChange(section)
    const fit = this.zoneFit(section)
    // A fitted section on a phone gives ~12 px seats: land on its front rows at finger size instead.
    const scale = Math.max(fit.scale, CLOSE_TARGET_PX / this.model.seatmap.seat_size)
    this.animateTo(this.coarsePointer.matches ? centreOn(scale, ...section.front, this.width / 2, this.height * 0.3) : fit)
  }

  /** Level 1: every section as a block. */
  showAll(): void {
    this.zone = null
    this.setEdge(null)
    this.callbacks.onZoneChange(null)
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
    this.fitVp = fitTo(this.model.seatmap.bounds, this.width, this.height, this.overviewInsets)
    this.setViewport(this.zone ? this.vp : this.fitVp)
  }

  private zoneFit(zone: SectionInfo): Viewport {
    return fitTo(zone.bounds, this.width, this.height, this.insets)
  }

  private limits() {
    const limits = scaleLimits(this.zone ? this.zoneFit(this.zone) : this.fitVp, this.model.seatmap.seat_size)
    return this.zone ? { ...limits, min: limits.min * ZONE_MIN_ZOOM } : limits
  }

  /** Keeps a section in view. `elastic` (a drag) stretches a little past its edge and offers the next section. */
  private clamp(vp: Viewport, elastic = false): Viewport {
    if (!this.zone) return vp
    const held = clampTo(vp, this.zone.bounds, this.width, this.height, this.insets, ZONE_SLACK)
    if (!elastic) return held.vp
    const [ox, oy] = held.over
    this.pushEdge(ox, oy)
    const rubber = (o: number) => Math.sign(o) * Math.min(80, Math.abs(o) * 0.35)
    return { ...held.vp, x: held.vp.x + rubber(ox), y: held.vp.y + rubber(oy) }
  }

  private pushEdge(ox: number, oy: number): void {
    if (Math.hypot(ox, oy) < EDGE_PUSH_PX) {
      if (ox === 0 && oy === 0) this.setEdge(null)
      return
    }
    // Dragged right (ox > 0) means looking left.
    const section = sectionToward(this.model, this.zone!, -ox, -oy, (s) => this.isOpen(s))
    const side = Math.abs(ox) > Math.abs(oy) ? (ox > 0 ? 'left' : 'right') : oy > 0 ? 'top' : 'bottom'
    this.setEdge(section && { section, side })
  }

  private setEdge(edge: Edge | null): void {
    if (edge?.section === this.edge?.section && edge?.side === this.edge?.side) return
    this.edge = edge
    this.callbacks.onEdge(edge)
  }

  private isOpen(section: SectionInfo): boolean {
    return (this.sectionLeft.get(section.id) ?? 0) > 0
  }

  private setViewport(vp: Viewport, elastic = false): void {
    this.updateViewport(this.clamp(vp, elastic))
    this.invalidate()
  }

  private updateViewport(vp: Viewport): void {
    this.vp = vp
    this.lod = this.zone ? lodFor(vp.scale, this.model.seatmap.seat_size) : 'overview'
  }

  private animateTo(target: Viewport): void {
    target = this.clamp(target)
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
      if (this.edge && !this.isOpen(this.edge.section)) this.setEdge(null)
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
    this.setEdge(null)
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
    if (!this.zone) return // level 1 doesn't pan or zoom
    this.hover(-1, -1)
    // Pinch scales around the fingers' midpoint; one pointer just pans.
    const factor = g.distance > 0 && c.distance > 0 ? c.distance / g.distance : 1
    const zoomed = zoomAt(g.start, factor, g.x, g.y, this.limits())
    this.setViewport({ ...zoomed, x: zoomed.x + c.x - g.x, y: zoomed.y + c.y - g.y }, true)
  }

  private onPointerUp(e: PointerEvent): void {
    const g = this.gesture
    const wasTap = g !== null && !g.moved && this.pointers.size === 1
    this.pointers.delete(e.pointerId)
    // Remaining finger of a pinch carries on panning from here.
    this.gesture = this.pointers.size > 0 ? { start: this.vp, ...this.centroid(), moved: true } : null
    // Let go past the edge: spring back.
    const held = this.clamp(this.vp)
    if (!this.gesture && (held.x !== this.vp.x || held.y !== this.vp.y)) this.animateTo(held)
    if (wasTap && e.type === 'pointerup') this.tap(...this.point(e), e.pointerType)
  }

  private onPointerLeave(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && !this.pointers.size) this.hover(-1, -1)
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    if (!this.zone) return
    this.animation = null
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
    if (!this.zone) {
      const section = x < 0 ? null : sectionAt(this.model, ...toWorld(this.vp, x, y))
      this.canvas.style.cursor = section && this.isOpen(section) ? 'pointer' : ''
      return
    }
    const found = x < 0 ? null : seatAt(this.model, ...toWorld(this.vp, x, y))
    const seat = found?.section === this.zone ? found : null
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
    if (!this.zone) {
      const section = sectionAt(this.model, wx, wy)
      if (section && this.isOpen(section)) this.enterZone(section)
      return
    }
    // Mid-zoom seats are too small for fingers: zoom in on the spot instead.
    if (this.lod === 'mid' && pointerType !== 'mouse') {
      return this.animateTo(centreOn(CLOSE_TARGET_PX / this.model.seatmap.seat_size, wx, wy, x, y))
    }
    const seat = seatAt(this.model, wx, wy)
    if (seat?.section === this.zone) this.callbacks.onSeatClick(seat.id)
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
    if (this.zone) this.drawSeats(this.zone, now)
    else this.drawSectionBlocks()

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
    const widthPx = section.bounds.width * this.vp.scale
    if (widthPx < 60) return
    const soldOut = left === 0
    const price = formatMoney(section.tier.price, this.model.seatmap.event.currency, true)
    const name = section.shortName.toUpperCase()

    // Stack: name/price box, gap, chip = 5.1 × size tall; keep it within the block.
    const fit = Math.min(15, widthPx / 9, (section.labelHeight * this.vp.scale * 0.8) / 5.1)
    ctx.font = `700 ${fit}px ${fonts.sans}`
    // Text width per px of font size, plus the box's side padding.
    const perPx = Math.max(ctx.measureText(name).width, ctx.measureText(price).width) / fit + 1.6
    const size = Math.min(fit, (widthPx * 0.82) / perPx)
    if (size < 7) return
    const boxW = size * perPx
    const boxH = size * 3.2
    const top = cy - (size * 5.1) / 2

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (!soldOut) {
      ctx.fillStyle = colors.paper
      roundedRect(ctx, cx - boxW / 2, top, boxW, boxH, 6)
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = colors.ink
      ctx.stroke()
    }
    ctx.fillStyle = soldOut ? colors.soldOutText : colors.ink
    ctx.font = `700 ${size}px ${fonts.sans}`
    ctx.fillText(name, cx, top + size * 1.05)
    ctx.font = `700 ${size * 0.95}px ${fonts.mono}`
    ctx.fillText(price, cx, top + size * 2.25)

    const chip = soldOut ? 'SOLD OUT' : left <= LOW_STOCK ? `Only ${left} left` : `${left} left`
    ctx.font = `700 ${size * 0.8}px ${fonts.sans}`
    const chipW = ctx.measureText(chip).width + size * 1.2
    const chipH = size * 1.5
    const chipY = top + boxH + size * 0.4
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

  private drawSeats(zone: SectionInfo, now: number): void {
    const { ctx } = this
    const state = this.store.get()
    const cell = this.model.seatmap.seat_size * this.vp.scale
    const close = this.lod === 'close'
    const size = cell * SEAT_FILL
    const radius = size * (close ? 0.22 : 0.18)
    const inside: SeatInfo[] = []
    const outside: SeatInfo[] = []
    for (const seat of this.model.seats) {
      const x = this.sx(seat.x)
      const y = this.sy(seat.y)
      if (x > -cell && x < this.width + cell && y > -cell && y < this.height + cell) {
        ;(seat.section === zone ? inside : outside).push(seat)
      }
    }

    this.drawBlurred(outside, size, now)

    if (!close) {
      this.drawSectionTitle(zone)
      this.fillSeats(ctx, inside, size, now, size >= 8 ? 1 : 0)
      for (const seat of inside) {
        const status = seatStatus(state, seat.id)
        if (status === 'selected' || status === 'lost' || seat === this.hovered) this.drawSeatMark(seat, status, size)
      }
      return
    }

    // Close zoom: only ~100 seats on screen, so draw each in full detail.
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const seat of inside) {
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
    this.drawRowLabels(zone, size, radius)
  }

  /**
   * Mid-zoom style seats: one pass per fill colour, so thousands of seats are
   * a handful of draw calls. Plain fillRects: at 8-28px rounded corners are
   * invisible, and building thousands of arc paths per frame cost ~3x the
   * whole frame budget. The outline is an outline-coloured square with the fill inset.
   */
  private fillSeats(ctx: CanvasRenderingContext2D, seats: SeatInfo[], size: number, now: number, outline: number): void {
    const state = this.store.get()
    const half = size / 2
    const batches = new Map<string, SeatInfo[]>()
    for (const seat of seats) {
      const fill = this.fillFor(seat, seatStatus(state, seat.id), now)
      const batch = batches.get(fill)
      if (batch) batch.push(seat)
      else batches.set(fill, [seat])
    }
    for (const [fill, batch] of batches) {
      if (outline) {
        ctx.fillStyle = fill === colors.unavailable ? colors.unavailableStroke : colors.ink
        for (const seat of batch) ctx.fillRect(this.sx(seat.x) - half, this.sy(seat.y) - half, size, size)
      }
      ctx.fillStyle = fill
      for (const seat of batch) {
        ctx.fillRect(this.sx(seat.x) - half + outline, this.sy(seat.y) - half + outline, size - 2 * outline, size - 2 * outline)
      }
    }
  }

  /**
   * Seats outside the section, drawn at 1/4 size and scaled back up: the
   * smoothing blurs them, cheaply and in every browser (ctx.filter isn't).
   */
  private drawBlurred(seats: SeatInfo[], size: number, now: number): void {
    const w = Math.ceil(this.width / BLUR_DOWNSCALE)
    const h = Math.ceil(this.height / BLUR_DOWNSCALE)
    if (this.blur.width !== w || this.blur.height !== h) {
      this.blur.width = w
      this.blur.height = h
    }
    const b = this.blurCtx
    b.setTransform(1 / BLUR_DOWNSCALE, 0, 0, 1 / BLUR_DOWNSCALE, 0, 0)
    b.clearRect(0, 0, this.width, this.height)
    this.fillSeats(b, seats, size, now, 0)
    const { ctx } = this
    ctx.save()
    ctx.globalAlpha = OUTSIDE_ALPHA
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(this.blur, 0, 0, w * BLUR_DOWNSCALE, h * BLUR_DOWNSCALE)
    ctx.restore()
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

  private drawSectionTitle(section: SectionInfo): void {
    const { ctx } = this
    const currency = this.model.seatmap.event.currency
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.font = `700 11px ${fonts.sans}`
    const soldOut = !this.isOpen(section)
    ctx.fillStyle = soldOut ? colors.soldOutText : colors.ink
    const text = `${section.shortName.toUpperCase()} • ${formatMoney(section.tier.price, currency, true)}${soldOut ? ' (SOLD OUT)' : ''}`
    ctx.fillText(text, this.sx(section.titleAt[0]), this.sy(section.titleAt[1]))
  }

  private drawRowLabels(section: SectionInfo, size: number, radius: number): void {
    const { ctx } = this
    ctx.font = `700 ${size * 0.4}px ${fonts.sans}`
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
