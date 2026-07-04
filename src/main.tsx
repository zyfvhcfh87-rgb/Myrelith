import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app/App.tsx'
// TEMPORARY (until Phase 3.4 passes): the Phase 2 decode sandbox stays
// reachable at ?sandbox for pipeline regression checks, then gets deleted.
import DecodeSandbox from './dev/DecodeSandbox.tsx'

const showSandbox = new URLSearchParams(window.location.search).has('sandbox')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{showSandbox ? <DecodeSandbox /> : <App />}</StrictMode>,
)
