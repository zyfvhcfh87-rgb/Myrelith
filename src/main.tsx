import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app/App.tsx'

// Dev-only: expose stores for console inspection (the Phase 3 gate checks
// the document JSON live) and for browser-driven verification. Stripped
// from production builds.
if (import.meta.env.DEV) {
  void Promise.all([
    import('./state/documentStore'),
    import('./state/transportStore'),
    import('./state/mediaStore'),
    import('./state/mediaImportStore'),
    import('./state/projectSessionStore'),
  ]).then(([doc, transport, media, mediaImport, projectSession]) => {
    Object.assign(window, {
      __stores: {
        document: doc.useDocumentStore,
        transport: transport.useTransportStore,
        media: media.useMediaStore,
        mediaImport: mediaImport.useMediaImportStore,
        projectSession: projectSession.useProjectSessionStore,
      },
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
