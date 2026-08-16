/**
 * app/App.tsx — Launcher/editor boundary.
 *
 * The launcher and its CSS are the eager product path. Editor panels, runtime
 * lifecycles, and editor CSS live behind one shared dynamic import.
 */

import {
  lazy,
  Suspense,
  useEffect,
  type ComponentType,
} from 'react'
import './launcher.css'
import './styles/plugin-safe-mode.css'
import ProjectLaunch from '../ui/ProjectLaunch'
import LazyLoadBoundary from '../ui/LazyLoadBoundary'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { initPreferencesPersistence } from './preferencesController'
import { loadEditorShell } from './editorModuleLoader'
import type { EditorShellProps } from './EditorShell'

const LazyEditorShell = lazy(loadEditorShell)
const LazyPluginAppRoot = lazy(() => import('../ui/plugins/PluginAppRoot'))

function EditorLoadingState() {
  return (
    <main
      className="lazy-editor-state"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="lazy-load-spinner" aria-hidden="true" />
      <h1>Opening your studio…</h1>
      <p>Your project is ready. Myrelith is loading the editing tools.</p>
    </main>
  )
}

function PluginStartupLoadingState() {
  return (
    <main className="lazy-editor-state" role="status" aria-live="polite" aria-busy="true">
      <span className="lazy-load-spinner" aria-hidden="true" />
      <h1>Checking plugin recovery…</h1>
      <p>Myrelith is verifying the previous plugin session before opening your projects.</p>
    </main>
  )
}

interface EditorLoadFailureProps {
  onReload(): void
}

function EditorLoadFailure({ onReload }: EditorLoadFailureProps) {
  return (
    <main className="lazy-editor-state lazy-editor-error" role="alert">
      <span className="project-launch-eyebrow">Editor loading paused</span>
      <h1>We couldn’t load the editing tools.</h1>
      <p>
        Your browser may be offline or holding an older Myrelith file. Reload to
        fetch the current editor, then reopen your local project or recovery copy.
      </p>
      <button
        type="button"
        className="project-button project-button-primary"
        autoFocus
        onClick={onReload}
      >
        Reload Myrelith
      </button>
    </main>
  )
}

export interface EditorSurfaceProps {
  closing: boolean
  editor?: ComponentType<EditorShellProps>
  onReload?: () => void
}

export function EditorSurface({
  closing,
  editor: Editor = LazyEditorShell,
  onReload = () => window.location.reload(),
}: EditorSurfaceProps) {
  return (
    <LazyLoadBoundary fallback={<EditorLoadFailure onReload={onReload} />}>
      <Suspense fallback={<EditorLoadingState />}>
        <Editor closing={closing} />
      </Suspense>
    </LazyLoadBoundary>
  )
}

export default function App() {
  useEffect(() => initPreferencesPersistence(), [])
  const editorActive = useProjectSessionStore(
    (state) => state.screen === 'editor',
  )
  const closing = useProjectSessionStore((state) => state.phase === 'closing')
  const content = editorActive
    ? <EditorSurface closing={closing} />
    : <ProjectLaunch />
  return (
    <Suspense fallback={<PluginStartupLoadingState />}>
      <LazyPluginAppRoot showStartupCard={!editorActive}>
        {content}
      </LazyPluginAppRoot>
    </Suspense>
  )
}
