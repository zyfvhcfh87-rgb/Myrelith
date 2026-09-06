import { useEffect, useLayoutEffect, useMemo, useState, type FormEvent } from 'react'
import { mountMulticamMonitor } from '../app/multicamMonitorController'
import { openSourceAsset } from '../app/sourceMonitorController'
import type { MulticamAngle } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  createMulticamInstancePresentation,
  multicamAssetDurationFrames,
  multicamDefinitionIsLocked,
} from '../state/multicamPresentation'
import { useMulticamSelectionStore } from '../state/multicamSelectionStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { useTransportStore } from '../state/transportStore'
import MulticamAlignmentControls from './MulticamAlignmentControls'
import MulticamMonitorControls, { MulticamAngleStatus } from './MulticamMonitorControls'

interface SetupState {
  readonly projectId: string
  readonly sequenceId: string
  readonly name: string
  readonly assetIds: readonly string[]
  readonly syncFrames: Readonly<Record<string, string>>
  readonly videoTrackId: string
  readonly audioTrackId: string
  readonly audioPolicy: string
}

function editableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable
      || target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT')
}

interface AngleEditorProps {
  readonly active: boolean
  readonly angle: MulticamAngle
  readonly index: number
  readonly definitionFrame: number
  readonly connected: boolean
  readonly filmstripUrl: string | null
  readonly editingDisabled: boolean
  readonly onCut: () => void
  readonly onEdit: (name: string, coverageStartFrame: number) => boolean
  readonly onStatus: (message: string) => void
}

function AngleEditor({
  active,
  angle,
  index,
  definitionFrame,
  connected,
  filmstripUrl,
  editingDisabled,
  onCut,
  onEdit,
  onStatus,
}: AngleEditorProps) {
  const [name, setName] = useState(angle.name)
  const [offset, setOffset] = useState(String(angle.coverage.startFrame))
  useEffect(() => {
    setName(angle.name)
    setOffset(String(angle.coverage.startFrame))
  }, [angle.name, angle.coverage.startFrame])
  const preview = (): void => {
    const opened = openSourceAsset(angle.assetId)
    if (opened.status !== 'ok') {
      onStatus(`${angle.name} is offline. Reconnect it in the Media Pool to preview.`)
      return
    }
    const coverageEnd = angle.coverage.startFrame + angle.coverage.durationFrames
    const sourceFrame = definitionFrame >= angle.coverage.startFrame
      && definitionFrame < coverageEnd
      ? angle.sourceStartFrame + definitionFrame - angle.coverage.startFrame
      : angle.sourceStartFrame
    useSourceMonitorStore.getState().setPlayhead(sourceFrame)
    onStatus(`Opened paused ${angle.name} preview at source frame ${sourceFrame}.`)
  }
  return (
    <article className="multicam-angle-card" data-connected={connected ? 'true' : 'false'}>
      <div
        className="multicam-angle-thumbnail"
        aria-hidden="true"
        style={filmstripUrl ? { backgroundImage: `url("${filmstripUrl}")` } : undefined}
      >
        {!filmstripUrl && <span>{index + 1}</span>}
      </div>
      <div className="multicam-angle-copy">
        <strong>{angle.name}</strong>
        <MulticamAngleStatus angleId={angle.id} active={active} />
        <span>{connected ? 'Connected' : 'Offline'} · offset {angle.coverage.startFrame}f</span>
      </div>
      <button
        type="button"
        aria-label={`Cut to ${angle.name}`}
        aria-keyshortcuts={`Alt+${index + 1}`}
        disabled={editingDisabled}
        onClick={onCut}
      >
        Cut {index + 1}
      </button>
      <button type="button" aria-label={`Preview ${angle.name}`} onClick={preview}>
        Preview
      </button>
      <details>
        <summary>Edit</summary>
        <label>
          <span>Angle name</span>
          <input
            value={name}
            maxLength={256}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Start offset (frames)</span>
          <input
            type="number"
            min={0}
            step={1}
            value={offset}
            onChange={(event) => setOffset(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          disabled={editingDisabled}
          onClick={() => {
            const parsed = Number(offset)
            onStatus(onEdit(name, parsed)
              ? `Updated ${name.trim()}.`
              : 'That angle offset would exceed the multicam definition.')
          }}
        >
          Apply angle
        </button>
      </details>
    </article>
  )
}

export default function MulticamControls() {
  const project = useDocumentStore((state) => state.project)
  const doc = useDocumentStore((state) => state.doc)
  const createMulticam = useDocumentStore((state) => state.createMulticam)
  const editDefinition = useDocumentStore((state) => state.editMulticamDefinition)
  const editInstance = useDocumentStore((state) => state.editMulticamInstance)
  const descriptors = useMediaStore((state) => state.descriptors)
  const assets = useMediaStore((state) => state.assets)
  const visuals = useMediaStore((state) => state.visuals)
  const playheadFrame = useTransportStore((state) => state.playheadFrame)
  const selectedInstanceId = useMulticamSelectionStore(
    (state) => state.selectedInstanceId,
  )
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [status, setStatus] = useState('')
  const videoAssets = useMemo(
    () => [...descriptors.values()].filter((descriptor) => descriptor.kind === 'video'),
    [descriptors],
  )
  const selectedInstance = doc.tracks.flatMap((track) => (
    track.multicamInstances ?? []
  )).find((instance) => instance.id === selectedInstanceId) ?? null
  const definition = selectedInstance
    ? (project.multicams ?? []).find((item) => item.id === selectedInstance.multicamId) ?? null
    : null
  const instancePresentation = useMemo(() => (
    definition && selectedInstance
      ? createMulticamInstancePresentation(definition, selectedInstance)
      : null
  ), [definition, selectedInstance])
  const playheadPresentation = instancePresentation?.atPlayhead(playheadFrame) ?? null
  const definitionFrame = playheadPresentation?.definitionFrame ?? 0
  const playheadInside = playheadPresentation?.inside ?? false
  const selectedAngleId = playheadPresentation?.selectedAngleId ?? null
  const definitionLocked = useMemo(() => (
    definition ? multicamDefinitionIsLocked(project, definition.id) : false
  ), [definition, project])

  const setupOpen = setup !== null
  // Layout owns the session before child passive effects register their canvases.
  useLayoutEffect(() => {
    if (selectedInstanceId && !setupOpen) return mountMulticamMonitor(selectedInstanceId)
  }, [selectedInstanceId, setupOpen])

  const cutToAngle = (angleId: string): boolean => {
    if (!definition || !playheadInside) {
      setStatus('Place the playhead inside the multicam item before cutting.')
      return false
    }
    if (definitionLocked) {
      setStatus('Unlock every lane that uses this multicam before editing its definition.')
      return false
    }
    const accepted = editDefinition({
      kind: 'cut',
      definitionId: definition.id,
      frame: definitionFrame,
      angleId,
    })
    setStatus(accepted
      ? `Cut authored at frame ${playheadFrame}.`
      : 'That cut could not be authored.')
    return accepted
  }

  const rollCut = (delta: -1 | 1): void => {
    if (!definition || !selectedInstance || !playheadInside) {
      setStatus('Place the playhead inside the multicam item before rolling a cut.')
      return
    }
    if (definitionLocked) {
      setStatus('Unlock every lane that uses this multicam before editing its definition.')
      return
    }
    const cutFrame = playheadPresentation?.switchFrame ?? 0
    if (cutFrame === 0) {
      setStatus('There is no preceding authored cut to roll at this playhead.')
      return
    }
    const accepted = editDefinition({
      kind: 'roll-cut',
      definitionId: definition.id,
      frame: cutFrame,
      toFrame: cutFrame + delta,
    })
    setStatus(accepted ? `Rolled the preceding cut ${delta > 0 ? 'later' : 'earlier'} by one frame.`
      : 'That roll would cross a neighbouring cut.')
  }

  useEffect(() => {
    if (!definition || !selectedInstance) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || editableTarget(event.target)) return
      if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        rollCut(event.key === 'ArrowLeft' ? -1 : 1)
        return
      }
      const index = Number(event.key) - 1
      const angle = definition.angles[index]
      if (!angle) return
      event.preventDefault()
      cutToAngle(angle.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const beginSetup = (): void => {
    const initial = videoAssets.slice(0, 2).map((descriptor) => descriptor.id)
    setStatus('')
    setSetup({
      projectId: project.id,
      sequenceId: doc.id,
      name: `Multicam ${project.multicams?.length ? project.multicams.length + 1 : 1}`,
      assetIds: initial,
      syncFrames: Object.fromEntries(initial.map((id) => [id, '0'])),
      videoTrackId: doc.tracks.find((track) => track.kind === 'video')?.id ?? '',
      audioTrackId: doc.tracks.find((track) => track.kind === 'audio')?.id ?? '',
      audioPolicy: `fixed:${initial[0]}`,
    })
  }

  useEffect(() => {
    if (
      !setup
      || (setup.projectId === project.id && setup.sequenceId === doc.id)
    ) return
    setSetup(null)
    setStatus('Multicam setup closed because the active project changed.')
  }, [doc.id, project.id, setup])

  const submitSetup = (event: FormEvent): void => {
    event.preventDefault()
    if (!setup) return
    if (setup.projectId !== project.id || setup.sequenceId !== doc.id) {
      setSetup(null)
      setStatus('Multicam setup closed because the active project changed.')
      return
    }
    if (setup.assetIds.length < 2 || setup.assetIds.length > 8) {
      setStatus('Choose between 2 and 8 video angles.')
      return
    }
    const selected = setup.assetIds.flatMap((id) => {
      const descriptor = descriptors.get(id)
      return descriptor?.kind === 'video' ? [descriptor] : []
    })
    if (selected.length !== setup.assetIds.length) {
      setStatus('A selected angle is no longer available. Choose available video sources again.')
      return
    }
    const angles = selected.map((descriptor) => ({
      assetId: descriptor.id,
      name: descriptor.fileName,
      durationFrames: multicamAssetDurationFrames(
        descriptor.durationMicroseconds,
        doc.frameRate,
      ),
      syncFrame: Number(setup.syncFrames[descriptor.id] ?? '0'),
    }))
    const fixedAssetId = setup.audioPolicy.startsWith('fixed:')
      ? setup.audioPolicy.slice('fixed:'.length)
      : null
    const fixedIndex = fixedAssetId === null
      ? null
      : setup.assetIds.indexOf(fixedAssetId)
    if (fixedIndex !== null && fixedIndex < 0) {
      setStatus('Choose a connected fixed audio angle or use audio-follows-video.')
      return
    }
    const created = createMulticam({
      name: setup.name,
      startFrame: playheadFrame,
      videoTrackId: setup.videoTrackId,
      audioTrackId: setup.audioTrackId || null,
      angles,
      audioPolicy: fixedIndex === null
        ? { kind: 'follow-video' }
        : { kind: 'fixed', angleIndex: fixedIndex },
    })
    if (!created) {
      setStatus('The multicam could not be placed. Check sync marks, locks, and overlaps.')
      return
    }
    useMulticamSelectionStore.getState().setSelectedInstanceId(created.videoInstanceId)
    setSetup(null)
    setStatus(`Created ${setup.name.trim()} with ${angles.length} angles.`)
  }

  return (
    <section className="multicam-controls" aria-label="Manual-sync multicam">
      <div className="multicam-controls-heading">
        <span>Multicam</span>
        <button
          type="button"
          onClick={beginSetup}
          disabled={videoAssets.length < 2}
          title={videoAssets.length < 2 ? 'Import at least two video sources first' : undefined}
        >
          New multicam
        </button>
      </div>

      {setup && (
        <form className="multicam-setup" onSubmit={submitSetup}>
          <label>
            <span>Multicam name</span>
            <input
              autoFocus
              maxLength={256}
              value={setup.name}
              onChange={(event) => setSetup({ ...setup, name: event.currentTarget.value })}
            />
          </label>
          <fieldset>
            <legend>Angles (choose 2–8)</legend>
            {videoAssets.map((descriptor) => {
              const checked = setup.assetIds.includes(descriptor.id)
              return (
                <div className="multicam-setup-angle" key={descriptor.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && setup.assetIds.length >= 8}
                      onChange={(event) => {
                        const assetIds = event.currentTarget.checked
                          ? [...setup.assetIds, descriptor.id]
                          : setup.assetIds.filter((id) => id !== descriptor.id)
                        const audioPolicy = setup.audioPolicy === `fixed:${descriptor.id}`
                          ? (assetIds[0] ? `fixed:${assetIds[0]}` : 'follow')
                          : setup.audioPolicy
                        setSetup({
                          ...setup,
                          assetIds,
                          audioPolicy,
                          syncFrames: {
                            ...setup.syncFrames,
                            [descriptor.id]: setup.syncFrames[descriptor.id] ?? '0',
                          },
                        })
                      }}
                    />
                    <span>{descriptor.fileName}</span>
                  </label>
                  {checked && (
                    <label>
                      <span>Sync frame for {descriptor.fileName}</span>
                      <input
                        aria-label={`Sync frame for ${descriptor.fileName}`}
                        type="number"
                        min={0}
                        step={1}
                        value={setup.syncFrames[descriptor.id] ?? '0'}
                        onChange={(event) => setSetup({
                          ...setup,
                          syncFrames: {
                            ...setup.syncFrames,
                            [descriptor.id]: event.currentTarget.value,
                          },
                        })}
                      />
                    </label>
                  )}
                </div>
              )
            })}
          </fieldset>
          <div className="multicam-setup-routing">
            <label>
              <span>Video track</span>
              <select
                value={setup.videoTrackId}
                onChange={(event) => setSetup({ ...setup, videoTrackId: event.currentTarget.value })}
              >
                {doc.tracks.filter((track) => track.kind === 'video').map((track) => (
                  <option key={track.id} value={track.id}>{track.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Audio track</span>
              <select
                value={setup.audioTrackId}
                onChange={(event) => setSetup({ ...setup, audioTrackId: event.currentTarget.value })}
              >
                <option value="">No audio item</option>
                {doc.tracks.filter((track) => track.kind === 'audio').map((track) => (
                  <option key={track.id} value={track.id}>{track.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Initial audio</span>
              <select
                aria-label="Initial audio policy"
                value={setup.audioPolicy}
                onChange={(event) => setSetup({ ...setup, audioPolicy: event.currentTarget.value })}
              >
                {setup.assetIds.map((assetId) => (
                  <option key={assetId} value={`fixed:${assetId}`}>
                    Fixed: {descriptors.get(assetId)?.fileName ?? assetId}
                  </option>
                ))}
                <option value="follow">Audio follows video</option>
              </select>
            </label>
          </div>
          <div className="multicam-setup-actions">
            <button type="submit">Create multicam</button>
            <button
              type="button"
              aria-label="Cancel multicam setup"
              onClick={() => setSetup(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {!setup && definition && selectedInstance && (
        <div className="multicam-editor" aria-label={`Edit multicam ${definition.name}`}>
          <div className="multicam-editor-heading">
            <strong>{definition.name}</strong>
            <span>
              Frame {definitionFrame} · active {definition.angles.find(
                (angle) => angle.id === selectedAngleId,
              )?.name}
            </span>
          </div>
          {definitionLocked && (
            <p className="multicam-lock-notice" role="note">
              Unlock every lane that uses this multicam to edit cuts, offsets, or audio policy.
            </p>
          )}
          <MulticamMonitorControls definition={definition} instanceId={selectedInstance.id}
            activeAngleId={selectedAngleId} disabled={definitionLocked || !playheadInside}
            onCut={(id) => { cutToAngle(id) }} />
          <div className="multicam-angle-grid">
            {definition.angles.map((angle, index) => (
              <AngleEditor
                key={`${selectedInstance.id}:${angle.id}`}
                active={angle.id === selectedAngleId}
                angle={angle}
                index={index}
                definitionFrame={definitionFrame}
                connected={assets.has(angle.assetId)}
                filmstripUrl={visuals.get(angle.assetId)?.filmstrip?.url ?? null}
                editingDisabled={definitionLocked}
                onCut={() => { cutToAngle(angle.id) }}
                onStatus={setStatus}
                onEdit={(name, coverageStartFrame) => editDefinition({
                  kind: 'set-angle',
                  definitionId: definition.id,
                  angleId: angle.id,
                  name,
                  coverageStartFrame,
                })}
              />
            ))}
          </div>
          <div className="multicam-edit-row">
            <MulticamAlignmentControls key={definition.id} definition={definition} />
          </div>
          <div className="multicam-edit-row">
            <label>
              <span>Audio policy</span>
              <select
                aria-label="Multicam audio policy"
                disabled={definitionLocked}
                value={definition.audioPolicy.kind === 'follow-video'
                  ? 'follow'
                  : definition.audioPolicy.angleId}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  const accepted = editDefinition({
                    kind: 'set-audio-policy',
                    definitionId: definition.id,
                    audioPolicy: value === 'follow'
                      ? { kind: 'follow-video' }
                      : { kind: 'fixed', angleId: value },
                  })
                  setStatus(accepted ? 'Updated multicam audio policy.' : 'Audio policy was rejected.')
                }}
              >
                <option value="follow">Audio follows video</option>
                {definition.angles.map((angle) => (
                  <option key={angle.id} value={angle.id}>Fixed: {angle.name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-keyshortcuts="Alt+Shift+ArrowLeft"
              disabled={definitionLocked || !playheadInside || !playheadPresentation?.switchFrame}
              onClick={() => rollCut(-1)}
            >
              Roll preceding cut earlier
            </button>
            <button
              type="button"
              aria-keyshortcuts="Alt+Shift+ArrowRight"
              disabled={definitionLocked || !playheadInside || !playheadPresentation?.switchFrame}
              onClick={() => rollCut(1)}
            >
              Roll preceding cut later
            </button>
          </div>
          <div className="multicam-edit-row" role="group" aria-label="Multicam item actions">
            <button
              type="button"
              disabled={selectedInstance.timelineRange.startFrame === 0}
              onClick={() => setStatus(editInstance({
                kind: 'move',
                instanceId: selectedInstance.id,
                startFrame: selectedInstance.timelineRange.startFrame - 1,
              }) ? 'Moved multicam earlier.' : 'The multicam cannot move there.')}
            >
              Move earlier
            </button>
            <button
              type="button"
              onClick={() => setStatus(editInstance({
                kind: 'move',
                instanceId: selectedInstance.id,
                startFrame: selectedInstance.timelineRange.startFrame + 1,
              }) ? 'Moved multicam later.' : 'The multicam cannot move there.')}
            >
              Move later
            </button>
            <button
              type="button"
              disabled={selectedInstance.timelineRange.durationFrames <= 1}
              onClick={() => setStatus(editInstance({
                kind: 'trim',
                instanceId: selectedInstance.id,
                timelineRange: {
                  startFrame: selectedInstance.timelineRange.startFrame + 1,
                  durationFrames: selectedInstance.timelineRange.durationFrames - 1,
                },
                sourceStartFrame: selectedInstance.sourceStartFrame + 1,
              }) ? 'Trimmed multicam start.' : 'The multicam cannot be trimmed.')}
            >
              Trim start
            </button>
            <button
              type="button"
              disabled={selectedInstance.timelineRange.durationFrames <= 1}
              onClick={() => setStatus(editInstance({
                kind: 'trim',
                instanceId: selectedInstance.id,
                timelineRange: {
                  ...selectedInstance.timelineRange,
                  durationFrames: selectedInstance.timelineRange.durationFrames - 1,
                },
                sourceStartFrame: selectedInstance.sourceStartFrame,
              }) ? 'Trimmed multicam end.' : 'The multicam cannot be trimmed.')}
            >
              Trim end
            </button>
            <button
              type="button"
              disabled={!playheadInside
                || playheadFrame === selectedInstance.timelineRange.startFrame}
              onClick={() => setStatus(editInstance({
                kind: 'split',
                instanceId: selectedInstance.id,
                frame: playheadFrame,
              }) ? 'Split multicam at the playhead.' : 'The multicam cannot split there.')}
            >
              Split multicam
            </button>
            <button
              type="button"
              onClick={() => setStatus(editInstance({
                kind: 'duplicate',
                instanceId: selectedInstance.id,
                startFrame: selectedInstance.timelineRange.startFrame
                  + selectedInstance.timelineRange.durationFrames,
              }) ? 'Duplicated multicam.' : 'The multicam duplicate would collide.')}
            >
              Duplicate multicam
            </button>
          </div>
        </div>
      )}
      <span className="visually-hidden" role="status" aria-label="Multicam edit status" aria-live="polite">
        {status}
      </span>
    </section>
  )
}
