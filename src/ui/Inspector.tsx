/**
 * ui/Inspector.tsx — Transform + opacity editing for the selected clip.
 * Phase 4.3.
 *
 * Commit model (plan-mandated): fields hold a local DRAFT while typing and
 * commit on blur/Enter — never per keystroke — via ONE
 * documentStore.updateClipTransform call per change (= one undo entry).
 * Escape reverts the draft; junk/empty input reverts on commit; a
 * no-change commit is skipped entirely so blurring an untouched field
 * never pollutes history. Out-of-range opacity is clamped by the domain
 * op (the doc can never hold invalid values, whatever gets typed).
 *
 * Subscriptions: selectedClipId (primitive) + the selected clip resolved
 * through domain findClip — structural sharing keeps its reference stable
 * across unrelated edits, so the Inspector re-renders only when ITS clip
 * changes. It never reads playheadFrame (invariant 6 stays intact).
 * Layering: ui/ → state/ + domain selectors only.
 */

import { useEffect, useState } from 'react'
import type { ClipTransformPatch } from '../domain/operations'
import { findClip, trackOfClip } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

interface NumberFieldProps {
  label: string
  value: number
  step: number
  testId: string
  onCommit: (value: number) => void
}

function NumberField({ label, value, step, testId, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value))
  // Re-sync whenever the committed value changes under us (undo/redo, a
  // gesture on the canvas, switching clips) — but never while typing.
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = (): void => {
    const trimmed = draft.trim()
    const parsed = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(parsed)) {
      setDraft(String(value)) // junk: revert, commit nothing
      return
    }
    if (parsed === value) return // unchanged: no history entry
    onCommit(parsed)
  }

  return (
    <label className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <input
        type="number"
        step={step}
        value={draft}
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            setDraft(String(value))
          }
        }}
      />
    </label>
  )
}

export default function Inspector() {
  const selectedClipId = useTransportStore((s) => s.selectedClipId)
  const clip = useDocumentStore((s) =>
    selectedClipId ? findClip(s.doc, selectedClipId) : null,
  )
  // Lane kind decides the field set: audio clips edit VOLUME, video clips
  // the visual transform. A primitive slice, so unrelated edits skip us.
  const laneKind = useDocumentStore((s) =>
    selectedClipId ? (trackOfClip(s.doc, selectedClipId)?.kind ?? null) : null,
  )

  if (!clip) {
    return (
      <div className="panel-placeholder">
        <span className="placeholder-title">Inspector</span>
        <span className="placeholder-note">select a clip to edit it</span>
      </div>
    )
  }

  if (laneKind === 'audio') {
    return (
      <div className="inspector-panel" key={clip.id} data-testid="inspector-panel">
        <div className="inspector-title">{clip.name}</div>
        <div className="inspector-grid">
          <NumberField
            label="Volume"
            value={clip.volume}
            step={0.05}
            testId="inspector-volume"
            onCommit={(volume) =>
              useDocumentStore.getState().setClipVolume(clip.id, volume)
            }
          />
        </div>
        <span className="inspector-note">0 = silent · 1 = original · 2 = max</span>
      </div>
    )
  }

  const patch = (p: ClipTransformPatch): void =>
    useDocumentStore.getState().updateClipTransform(clip.id, p)
  const t = clip.transform

  return (
    /* key: switching clips remounts the fields, dropping stale drafts. */
    <div className="inspector-panel" key={clip.id} data-testid="inspector-panel">
      <div className="inspector-title">{clip.name}</div>
      <div className="inspector-grid">
        <NumberField
          label="Position X"
          value={t.x}
          step={1}
          testId="inspector-x"
          onCommit={(x) => patch({ transform: { x } })}
        />
        <NumberField
          label="Position Y"
          value={t.y}
          step={1}
          testId="inspector-y"
          onCommit={(y) => patch({ transform: { y } })}
        />
        <NumberField
          label="Scale X"
          value={t.scaleX}
          step={0.1}
          testId="inspector-scale-x"
          onCommit={(scaleX) => patch({ transform: { scaleX } })}
        />
        <NumberField
          label="Scale Y"
          value={t.scaleY}
          step={0.1}
          testId="inspector-scale-y"
          onCommit={(scaleY) => patch({ transform: { scaleY } })}
        />
        <NumberField
          label="Rotation °"
          value={t.rotation}
          step={1}
          testId="inspector-rotation"
          onCommit={(rotation) => patch({ transform: { rotation } })}
        />
        <NumberField
          label="Opacity"
          value={clip.opacity}
          step={0.05}
          testId="inspector-opacity"
          onCommit={(opacity) => patch({ opacity })}
        />
      </div>
    </div>
  )
}
