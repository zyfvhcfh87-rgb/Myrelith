/**
 * ui/Toolbar.tsx — Project identity, persistence, keyboard hints, and export.
 * The heavy export workflow mounts only while its dialog is open.
 */

import { useRef, useState } from 'react'
import {
  saveActiveProject,
  saveActiveProjectAs,
} from '../app/projectPersistenceController'
import { leaveActiveProject } from '../app/projectController'
import { useProjectSessionStore } from '../state/projectSessionStore'
import ExportDialog from './ExportDialog'

function saveStatus(
  phase: 'idle' | 'saving' | 'error',
  dirty: boolean,
  liveSaveEnabled: boolean,
  lastSavedAt: number | null,
  fileName: string | null,
): string {
  if (phase === 'saving') return 'Saving…'
  if (phase === 'error') return 'Save failed'
  if (dirty) {
    if (liveSaveEnabled) return 'Unsaved · live save queued'
    return lastSavedAt === null
      ? 'Unsaved changes'
      : 'Copy downloaded · unsaved changes'
  }
  if (lastSavedAt !== null) {
    return liveSaveEnabled ? 'Saved · live save on' : 'Saved copy'
  }
  return fileName ? 'Opened · Save to enable live save' : 'Not saved yet'
}

export default function Toolbar() {
  const [exportOpen, setExportOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const exportButtonRef = useRef<HTMLButtonElement | null>(null)
  const projectName = useProjectSessionStore((state) => state.activeProjectName)
  const projectFile = useProjectSessionStore(
    (state) => state.activeProjectFileName,
  )
  const dirty = useProjectSessionStore((state) => state.hasUnsavedChanges)
  const projectPhase = useProjectSessionStore((state) => state.phase)
  const phase = useProjectSessionStore((state) => state.savePhase)
  const liveSaveEnabled = useProjectSessionStore(
    (state) => state.liveSaveEnabled,
  )
  const lastSavedAt = useProjectSessionStore((state) => state.lastSavedAt)
  const saveError = useProjectSessionStore((state) => state.saveError)
  const saving = phase === 'saving'
  const closing = leaving || projectPhase === 'closing'
  const busy = saving || closing
  const statusError = closing ? null : leaveError ?? saveError

  const closeExport = (): void => {
    setExportOpen(false)
    requestAnimationFrame(() => exportButtonRef.current?.focus())
  }

  const openProjects = async (): Promise<void> => {
    if (
      dirty
      && !window.confirm(
        'This project has unsaved changes. Leave them behind and return to Projects?',
      )
    ) {
      return
    }
    setLeaveError(null)
    setLeaving(true)
    const result = await leaveActiveProject()
    if (result.status === 'failed') setLeaveError(result.message)
    setLeaving(false)
  }

  return (
    <div className="toolbar">
      <strong className="toolbar-brand">WebCut</strong>
      <div className="toolbar-project" title={projectFile ?? undefined}>
        <strong>{projectName ?? 'Untitled project'}</strong>
        <span
          className="toolbar-save-status"
          data-state={statusError ? 'error' : dirty ? 'dirty' : 'clean'}
          role={statusError ? 'alert' : undefined}
          aria-live="polite"
          aria-atomic="true"
          title={statusError ?? undefined}
        >
          {closing
            ? 'Returning to Projects…'
            : leaveError
              ? 'Could not return to Projects'
              : saveStatus(phase, dirty, liveSaveEnabled, lastSavedAt, projectFile)}
        </span>
      </div>
      <span className="placeholder-note">S splits at playhead · Del ripple-deletes</span>
      <div className="toolbar-actions">
        <button
          type="button"
          className="toolbar-button toolbar-projects"
          disabled={busy}
          onClick={() => void openProjects()}
        >
          Projects
        </button>
        <button
          type="button"
          className="toolbar-button"
          disabled={busy}
          title="Save to the current .webcut; the first save asks where to store it"
          onClick={() => void saveActiveProject()}
        >
          Save
        </button>
        <button
          type="button"
          className="toolbar-button"
          disabled={busy}
          title="Choose a new .webcut file and enable live save"
          onClick={() => void saveActiveProjectAs()}
        >
          Save As
        </button>
        <button
          ref={exportButtonRef}
          type="button"
          className="toolbar-export"
          aria-haspopup="dialog"
          aria-expanded={exportOpen}
          disabled={closing}
          onClick={() => setExportOpen(true)}
        >
          Export
        </button>
      </div>
      {exportOpen && <ExportDialog onClose={closeExport} />}
    </div>
  )
}
