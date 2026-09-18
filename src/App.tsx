import { useEffect, useRef, useState } from 'react'
import { BottomBar, BottomSheet, ExpiredDialog, Header, LoadState } from './components/Chrome'
import { Notices } from './components/Notices'
import { SeatMap, type SeatMapHandle } from './components/SeatMap'
import { SelectionPanel } from './components/SelectionPanel'
import { DESKTOP, useMediaQuery } from './hooks/useMediaQuery'
import { seatStore, start } from './state/actions'
import { useStore } from './state/store'

export default function App() {
  useEffect(() => start(), [])
  const venue = useStore(seatStore, (s) => (s.phase === 'ready' ? s.venue : null))
  const desktop = useMediaQuery(DESKTOP)
  const map = useRef<SeatMapHandle>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  return (
    <div className="app">
      <Header />
      {venue ? (
        <main className="layout">
          <SeatMap venue={venue} ref={map} />
          {desktop ? (
            <aside className="sidebar">
              <SelectionPanel />
            </aside>
          ) : (
            <BottomBar onReview={() => setSheetOpen(true)} />
          )}
          <Notices />
        </main>
      ) : (
        <LoadState />
      )}
      {!desktop && <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />}
      <ExpiredDialog onChooseAgain={() => map.current?.fit()} />
    </div>
  )
}
