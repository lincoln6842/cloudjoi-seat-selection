/*! CloudJoi seat selection by lincoln6842 · https://github.com/lincoln6842 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

console.log('%cSeat selection by lincoln6842%c github.com/lincoln6842', 'font-weight:700', 'color:#5f5a52')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
