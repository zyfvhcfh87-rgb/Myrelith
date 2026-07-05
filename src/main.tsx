import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app/App.tsx'
// TEMPORARY (until Phase 3.4 passes): the Phase 2 decode sandbox stays
// reachable at ?sandbox for pipeline regression checks, then gets deleted.
import DecodeSandbox from './dev/DecodeSandbox.tsx'

const showSandbox = new URLSearchParams(window.location.search).has('sandbox')

// Dev-only: expose stores for console inspection (the Phase 3 gate checks
// the document JSON live) and for browser-driven verification. Stripped
// from production builds.
if (import.meta.env.DEV) {
  void Promise.all([
    import('./state/documentStore'),
    import('./state/transportStore'),
    import('./state/mediaStore'),
  ]).then(([doc, transport, media]) => {
    Object.assign(window, {
      __stores: {
        document: doc.useDocumentStore,
        transport: transport.useTransportStore,
        media: media.useMediaStore,
      },
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{showSandbox ? <DecodeSandbox /> : <App />}</StrictMode>,
)
