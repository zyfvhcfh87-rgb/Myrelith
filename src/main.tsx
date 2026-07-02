import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// TEMPORARY (Phase 2.5): the decode sandbox is the whole app while the
// pipeline gate is validated. Phase 3.1 swaps in app/App.tsx.
import DecodeSandbox from './dev/DecodeSandbox.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DecodeSandbox />
  </StrictMode>,
)
