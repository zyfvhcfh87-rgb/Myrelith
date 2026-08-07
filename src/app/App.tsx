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
import ProjectLaunch from '../ui/ProjectLaunch'
import LazyLoadBoundary from '../ui/LazyLoadBoundary'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { initPreferencesPersistence } from './preferencesController'
import { loadEditorShell } from './editorModuleLoader'
import type { EditorShellProps } from './EditorShell'

const LazyEditorShell = lazy(loadEditorShell)

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
      <p>Your project is ready. WebCut is loading the editing tools.</p>
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
        Your browser may be offline or holding an older WebCut file. Reload to
        fetch the current editor, then reopen your local project or recovery copy.
      </p>
      <button
        type="button"
        className="project-button project-button-primary"
        autoFocus
        onClick={onReload}
      >
        Reload WebCut
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
  return editorActive
    ? <EditorSurface closing={closing} />
    : <ProjectLaunch />
}
