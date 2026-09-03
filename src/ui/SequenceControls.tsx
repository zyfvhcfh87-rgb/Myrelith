import { useState, type FormEvent } from 'react'
import { useDocumentStore } from '../state/documentStore'

type SequenceEditorKind = 'create' | 'duplicate' | 'rename'

interface SequenceEditorState {
  kind: SequenceEditorKind
  name: string
}

function actionLabel(kind: SequenceEditorKind): string {
  if (kind === 'create') return 'Create sequence'
  if (kind === 'duplicate') return 'Duplicate sequence'
  return 'Rename sequence'
}

export default function SequenceControls() {
  const project = useDocumentStore((state) => state.project)
  const activeSequenceId = useDocumentStore((state) => state.activeSequenceId)
  const switchSequence = useDocumentStore((state) => state.switchSequence)
  const createSequence = useDocumentStore((state) => state.createSequence)
  const duplicateSequence = useDocumentStore((state) => state.duplicateSequence)
  const renameSequence = useDocumentStore((state) => state.renameSequence)
  const deleteSequence = useDocumentStore((state) => state.deleteSequence)
  const chooseRootSequence = useDocumentStore((state) => state.chooseRootSequence)
  const [editor, setEditor] = useState<SequenceEditorState | null>(null)
  const [status, setStatus] = useState('')
  const active = project.sequences.find((sequence) => sequence.id === activeSequenceId)
    ?? project.sequences[0]
  const root = project.sequences.find((sequence) => sequence.id === project.rootSequenceId)
    ?? project.sequences[0]
  const activeIsRoot = active?.id === project.rootSequenceId

  const begin = (kind: SequenceEditorKind): void => {
    if (!active) return
    const name = kind === 'create'
      ? `Sequence ${project.sequences.length + 1}`
      : kind === 'duplicate'
        ? `${active.name} copy`
        : active.name
    setStatus('')
    setEditor({ kind, name })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!active || !editor) return
    const name = editor.name.trim()
    if (!name) {
      setStatus('Sequence names cannot be empty.')
      return
    }
    const succeeded = editor.kind === 'create'
      ? createSequence(name) !== null
      : editor.kind === 'duplicate'
        ? duplicateSequence(active.id, name) !== null
        : renameSequence(active.id, name)
    if (!succeeded) {
      setStatus('That sequence change could not be applied.')
      return
    }
    setStatus(`${actionLabel(editor.kind)} complete.`)
    setEditor(null)
  }

  const removeActive = (): void => {
    if (!active || activeIsRoot) return
    if (!window.confirm(`Delete sequence “${active.name}”? This can be undone.`)) return
    if (deleteSequence(active.id)) setStatus(`Deleted ${active.name}.`)
    else setStatus('The sequence is protected and could not be deleted.')
  }

  return (
    <div className="sequence-controls" aria-label="Project sequences">
      <label className="sequence-picker">
        <span>Sequence</span>
        <select
          value={active?.id ?? ''}
          aria-label="Active sequence"
          onChange={(event) => {
            setEditor(null)
            setStatus('')
            switchSequence(event.currentTarget.value)
          }}
        >
          {project.sequences.map((sequence) => (
            <option key={sequence.id} value={sequence.id}>
              {sequence.name}{sequence.id === project.rootSequenceId ? ' · Root' : ''}
            </option>
          ))}
        </select>
      </label>
      <span className="sequence-root" title="Portable default render truth">
        Root: {root?.name ?? 'Unavailable'}
      </span>
      <div className="sequence-buttons" role="group" aria-label="Sequence actions">
        <button type="button" onClick={() => begin('create')}>New</button>
        <button type="button" disabled={!active} onClick={() => begin('duplicate')}>
          Duplicate
        </button>
        <button type="button" disabled={!active} onClick={() => begin('rename')}>
          Rename
        </button>
        <button
          type="button"
          disabled={!active || activeIsRoot}
          title={activeIsRoot ? 'This is already the portable root sequence' : undefined}
          onClick={() => {
            if (!active) return
            if (chooseRootSequence(active.id)) setStatus(`${active.name} is now the root sequence.`)
          }}
        >
          Make root
        </button>
        <button
          type="button"
          disabled={!active || activeIsRoot}
          title={activeIsRoot ? 'Choose another root before deleting this sequence' : undefined}
          onClick={removeActive}
        >
          Delete
        </button>
      </div>
      {editor && (
        <form className="sequence-name-editor" onSubmit={submit}>
          <label>
            <span>{actionLabel(editor.kind)}</span>
            <input
              autoFocus
              value={editor.name}
              maxLength={256}
              onChange={(event) => setEditor({ ...editor, name: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditor(null)
                }
              }}
            />
          </label>
          <button type="submit">Apply</button>
          <button type="button" onClick={() => setEditor(null)}>Cancel</button>
        </form>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  )
}
