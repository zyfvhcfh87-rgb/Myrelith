import { useState, type FormEvent } from 'react'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useSequenceInstanceSelectionStore } from '../state/sequenceInstanceSelectionStore'

type SequenceEditorKind = 'create' | 'duplicate' | 'rename' | 'compound'

interface SequenceEditorState {
  kind: SequenceEditorKind
  name: string
}

function actionLabel(kind: SequenceEditorKind): string {
  if (kind === 'create') return 'Create sequence'
  if (kind === 'duplicate') return 'Duplicate sequence'
  if (kind === 'compound') return 'Create compound'
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
  const sequenceNavigation = useDocumentStore((state) => state.sequenceNavigation)
  const openSequenceInstance = useDocumentStore((state) => state.openSequenceInstance)
  const returnToParentSequence = useDocumentStore((state) => state.returnToParentSequence)
  const createCompoundFromClips = useDocumentStore(
    (state) => state.createCompoundFromClips,
  )
  const editSequenceInstance = useDocumentStore((state) => state.editSequenceInstance)
  const makeSequenceInstanceIndependent = useDocumentStore(
    (state) => state.makeSequenceInstanceIndependent,
  )
  const selectedClipIds = useTransportStore((state) => state.selectedClipIds)
  const playheadFrame = useTransportStore((state) => state.playheadFrame)
  const selectedInstanceId = useSequenceInstanceSelectionStore(
    (state) => state.selectedInstanceId,
  )
  const [editor, setEditor] = useState<SequenceEditorState | null>(null)
  const [status, setStatus] = useState('')
  const active = project.sequences.find((sequence) => sequence.id === activeSequenceId)
    ?? project.sequences[0]
  const root = project.sequences.find((sequence) => sequence.id === project.rootSequenceId)
    ?? project.sequences[0]
  const activeIsRoot = active?.id === project.rootSequenceId
  const selectedInstance = active?.tracks.flatMap((track) => (
    track.sequenceInstances ?? []
  )).find((instance) => instance.id === selectedInstanceId) ?? null

  const begin = (kind: SequenceEditorKind): void => {
    if (!active) return
    const name = kind === 'create'
      ? `Sequence ${project.sequences.length + 1}`
      : kind === 'compound'
        ? `${active.name} compound`
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
    let succeeded: boolean
    if (editor.kind === 'compound') {
      const created = createCompoundFromClips(selectedClipIds, name)
      succeeded = created !== null
      if (created) {
        useTransportStore.getState().setSelectedClip(null)
        useSequenceInstanceSelectionStore.getState()
          .setSelectedInstanceId(created.instanceId)
      }
    } else succeeded = editor.kind === 'create'
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
        <button
          type="button"
          disabled={!active || selectedClipIds.length === 0}
          title={selectedClipIds.length === 0 ? 'Select one or more bounded clips first' : undefined}
          onClick={() => begin('compound')}
        >
          Create compound
        </button>
        <button
          type="button"
          disabled={sequenceNavigation.length === 0}
          onClick={() => {
            const parent = returnToParentSequence()
            if (parent) {
              useTransportStore.getState().setPlayheadFrame(parent.playheadFrame)
              useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(null)
              setStatus('Returned to the parent sequence.')
            }
          }}
        >
          Back to parent
        </button>
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
      {selectedInstance && (
        <div
          className="sequence-instance-actions"
          role="group"
          aria-label={`Compound actions for ${selectedInstance.name}`}
        >
          <span>{selectedInstance.name}</span>
          <button
            type="button"
            onClick={() => {
              const childFrame = openSequenceInstance(
                selectedInstance.id,
                playheadFrame,
              )
              if (childFrame !== null) {
                useTransportStore.getState().setPlayheadFrame(childFrame)
                useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(null)
                setStatus(`Opened ${selectedInstance.name}.`)
              }
            }}
          >
            Open compound
          </button>
          <button
            type="button"
            disabled={selectedInstance.timelineRange.startFrame === 0}
            onClick={() => {
              const ok = editSequenceInstance({
                kind: 'move',
                instanceId: selectedInstance.id,
                startFrame: selectedInstance.timelineRange.startFrame - 1,
              })
              setStatus(ok ? 'Moved compound earlier by one frame.' : 'The compound could not move there.')
            }}
          >
            Move earlier
          </button>
          <button
            type="button"
            onClick={() => {
              const ok = editSequenceInstance({
                kind: 'move',
                instanceId: selectedInstance.id,
                startFrame: selectedInstance.timelineRange.startFrame + 1,
              })
              setStatus(ok ? 'Moved compound later by one frame.' : 'The compound could not move there.')
            }}
          >
            Move later
          </button>
          <button
            type="button"
            disabled={selectedInstance.timelineRange.durationFrames <= 1}
            onClick={() => {
              const ok = editSequenceInstance({
                kind: 'trim',
                instanceId: selectedInstance.id,
                timelineRange: {
                  startFrame: selectedInstance.timelineRange.startFrame + 1,
                  durationFrames: selectedInstance.timelineRange.durationFrames - 1,
                },
                sourceStartFrame: selectedInstance.sourceStartFrame + 1,
              })
              setStatus(ok ? 'Trimmed one frame from the compound start.' : 'The compound could not be trimmed.')
            }}
          >
            Trim start
          </button>
          <button
            type="button"
            disabled={selectedInstance.timelineRange.durationFrames <= 1}
            onClick={() => {
              const ok = editSequenceInstance({
                kind: 'trim',
                instanceId: selectedInstance.id,
                timelineRange: {
                  ...selectedInstance.timelineRange,
                  durationFrames: selectedInstance.timelineRange.durationFrames - 1,
                },
                sourceStartFrame: selectedInstance.sourceStartFrame,
              })
              setStatus(ok ? 'Trimmed one frame from the compound end.' : 'The compound could not be trimmed.')
            }}
          >
            Trim end
          </button>
          <button
            type="button"
            disabled={
              playheadFrame <= selectedInstance.timelineRange.startFrame
                || playheadFrame >= selectedInstance.timelineRange.startFrame
                  + selectedInstance.timelineRange.durationFrames
            }
            onClick={() => {
              const ok = editSequenceInstance({
                kind: 'split',
                instanceId: selectedInstance.id,
                frame: playheadFrame,
              })
              setStatus(ok ? 'Split compound at the playhead.' : 'Place the playhead inside the compound to split it.')
            }}
          >
            Split compound
          </button>
          <button
            type="button"
            onClick={() => {
              const ok = editSequenceInstance({
                kind: 'duplicate',
                instanceId: selectedInstance.id,
                startFrame: selectedInstance.timelineRange.startFrame
                  + selectedInstance.timelineRange.durationFrames,
              })
              setStatus(ok ? 'Duplicated compound after the selection.' : 'The duplicate would collide with another item.')
            }}
          >
            Duplicate compound
          </button>
          <button
            type="button"
            onClick={() => {
              const clonedId = makeSequenceInstanceIndependent(selectedInstance.id)
              setStatus(clonedId
                ? 'Made this compound independent.'
                : 'The compound could not be made independent.')
            }}
          >
            Make independent
          </button>
        </div>
      )}
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
