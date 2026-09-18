import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from 'react'
import { formatMoney } from '../lib/money'
import type { SeatInfo, SectionInfo, VenueModel } from '../seatmap/model'
import { SeatMapRenderer, type Edge } from '../seatmap/renderer'
import { colors, tierColors } from '../seatmap/theme'
import type { Insets } from '../seatmap/viewport'
import { DESKTOP, useMediaQuery } from '../hooks/useMediaQuery'
import { devRevokeSeat, seatStore, toggleSeat } from '../state/actions'
import { seatStatus } from '../state/seats'
import { useStore } from '../state/store'

// Space the overlays take, so "fit" keeps the venue clear of them (see .map__zoom/.legend CSS).
const DESKTOP_INSETS: Insets = { top: 60, right: 16, bottom: 84, left: 76 }
const MOBILE_INSETS: Insets = { top: 56, right: 12, bottom: 176, left: 12 }
// Phone overview: no legend (every block already shows its price), so the venue gets the height.
const MOBILE_OVERVIEW_INSETS: Insets = { ...MOBILE_INSETS, bottom: 16 }

/** What other UI (e.g. "Choose seats again") may ask of the map. */
export interface SeatMapHandle {
  showAll(): void
}

const ARROWS = { left: '←', right: '→', top: '↑', bottom: '↓' }
const GOTO_MS = 2500 // the go-to button's life if not tapped; its CSS fade-out ends then too

export function SeatMap({ venue, ref }: { venue: VenueModel; ref?: Ref<SeatMapHandle> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<SeatMapRenderer | null>(null)
  const [zone, setZone] = useState<SectionInfo | null>(null)
  const [edge, setEdge] = useState<Edge | null>(null)
  const [tip, setTip] = useState<{ seat: SeatInfo; x: number; y: number } | null>(null)
  const desktop = useMediaQuery(DESKTOP)
  const insets = desktop ? DESKTOP_INSETS : MOBILE_INSETS
  const overviewInsets = desktop ? DESKTOP_INSETS : MOBILE_OVERVIEW_INSETS
  const initialInsets = useRef([insets, overviewInsets] as const)

  useEffect(() => {
    const instance = new SeatMapRenderer(canvasRef.current!, venue, seatStore, {
      onSeatClick: toggleSeat,
      onHover: (seat, x, y) => setTip(seat ? { seat, x, y } : null),
      onZoneChange: setZone,
      onEdge: setEdge,
    }, ...initialInsets.current)
    renderer.current = instance
    return () => {
      instance.destroy()
      renderer.current = null
    }
  }, [venue])

  useEffect(() => renderer.current?.setInsets(insets, overviewInsets), [insets, overviewInsets])

  useEffect(() => {
    if (!edge) return
    const timer = setTimeout(() => setEdge(null), GOTO_MS)
    return () => clearTimeout(timer)
  }, [edge])

  useImperativeHandle(ref, () => ({ showAll: () => renderer.current?.showAll() }), [])

  // Overlays placed against the edges of the map's free area (the go-to pill).
  const insetVars = Object.fromEntries(Object.entries(insets).map(([side, px]) => [`--inset-${side}`, `${px}px`])) as CSSProperties

  return (
    <div className="map" style={insetVars}>
      <canvas
        ref={canvasRef}
        className="map__canvas"
        role="img"
        aria-label={`Seat map of ${venue.seatmap.event.venue}. Your selected seats are listed in the selection panel.`}
      />
      {zone ? (
        <button className="button button--small map__top" onClick={() => renderer.current?.showAll()}>
          ← All sections
        </button>
      ) : (
        <p className="map__hint map__top">
          <InfoIcon /> Tap a section block to zoom in &amp; pick seats
        </p>
      )}
      {edge && (
        <button
          key={`${edge.section.id}-${edge.side}`}
          className={`button button--small map__goto map__goto--${edge.side}`}
          onClick={() => renderer.current?.enterZone(edge.section)}
        >
          {edge.side === 'left' ? `← Go to ${edge.section.name}` : `Go to ${edge.section.name} ${ARROWS[edge.side]}`}
        </button>
      )}
      {zone && (
        <div className="map__zoom">
          <button className="button button--square" onClick={() => renderer.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button className="button button--square" onClick={() => renderer.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button className="button button--square" onClick={() => renderer.current?.fit()} aria-label="Fit whole section">
            FIT
          </button>
        </div>
      )}
      {(desktop || zone) && <Legend venue={venue} showStates={zone !== null} />}
      {tip && <SeatTooltip {...tip} currency={venue.seatmap.event.currency} />}
      {import.meta.env.DEV && (
        <button className="map__dev" onClick={() => void devRevokeSeat()} title="Dev only: the fake venue revokes one of your seats">
          Dev: revoke one of my seats
        </button>
      )}
    </div>
  )
}

function Legend({ venue, showStates }: { venue: VenueModel; showStates: boolean }) {
  const currency = venue.seatmap.event.currency
  return (
    <div className="legend" aria-label="Legend">
      <ul className="legend__tiers">
        {venue.seatmap.tiers.map((t) => (
          <li key={t.id}>
            <span className="swatch" style={{ background: tierColors[t.id] }} />
            {t.name} {formatMoney(t.price, currency, true)}
          </li>
        ))}
      </ul>
      {showStates && (
        <ul className="legend__states">
          <li>
            <span className="swatch" style={{ background: colors.selected }}>✓</span> Selected
          </li>
          <li>
            <span className="swatch swatch--dashed" style={{ background: colors.pending }} /> Pending
          </li>
          <li>
            <span className="swatch swatch--muted" style={{ background: colors.unavailable }}>⊘</span> Taken
          </li>
          <li>
            <span className="swatch swatch--light" style={{ background: colors.lost }}>✕</span> Lost
          </li>
        </ul>
      )}
    </div>
  )
}

const STATUS_TEXT = {
  available: 'Available • Click to add',
  selected: 'Selected • Click to remove',
  pending: 'Confirming hold…',
  unavailable: 'Unavailable',
  lost: 'Released by venue • Click to dismiss',
}

function SeatTooltip({ seat, x, y, currency }: { seat: SeatInfo; x: number; y: number; currency: string }) {
  const status = useStore(seatStore, (s) => seatStatus(s, seat.id))
  return (
    <div className="tooltip" style={{ transform: `translate(${x + 14}px, ${y + 14}px)` }} role="tooltip">
      <div className="tooltip__head">
        <span className="tooltip__section" style={{ background: tierColors[seat.section.tier.id] }}>
          {seat.section.name}
        </span>
        <span className="tooltip__price">{formatMoney(seat.section.tier.price, currency)}</span>
      </div>
      <strong>
        Row {seat.row}, Seat {seat.number}
      </strong>
      <span className={`tooltip__status is-${status}`}>{STATUS_TEXT[status]}</span>
    </div>
  )
}

function InfoIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M12 11v6M12 7.5v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}
