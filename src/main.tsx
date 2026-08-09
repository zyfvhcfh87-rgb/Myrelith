import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app/App.tsx'
import { PERFORMANCE_BENCHMARK_PATH } from './app/benchmarkRoute'

function exposeDevelopmentStores(): void {
  if (!import.meta.env.DEV) return
  void Promise.all([
    import('./state/documentStore'),
    import('./state/transportStore'),
    import('./state/mediaStore'),
    import('./state/mediaImportStore'),
    import('./state/projectSessionStore'),
    import('./state/preferencesStore'),
  ]).then(([doc, transport, media, mediaImport, projectSession, preferences]) => {
    Object.assign(window, {
      __stores: {
        document: doc.useDocumentStore,
        transport: transport.useTransportStore,
        media: media.useMediaStore,
        mediaImport: mediaImport.useMediaImportStore,
        projectSession: projectSession.useProjectSessionStore,
        preferences: preferences.usePreferencesStore,
      },
    })
  })
}

async function renderApplication(): Promise<void> {
  const root = createRoot(document.getElementById('root')!)
  // Keep the environment expression adjacent to the dynamic import so the
  // default production build can remove the entire benchmark chunk.
  if (
    (
      import.meta.env.DEV
      || import.meta.env.VITE_MYRELITH_PERFORMANCE_HARNESS === '1'
    )
    && window.location.pathname === PERFORMANCE_BENCHMARK_PATH
  ) {
    const { default: PerformanceBenchmarkApp } = await import(
      './dev/performance/PerformanceBenchmarkApp'
    )
    // The harness owns singleton browser resources. Avoid StrictMode's
    // intentional dev remount so one evidence run has one exact owner.
    root.render(<PerformanceBenchmarkApp />)
    return
  }

  exposeDevelopmentStores()
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void renderApplication()
