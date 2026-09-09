import { lazy, useEffect, useRef, useState } from 'react'
import type { Clip } from '../domain/schema'
import type { TitleEditCommand, TitleElementPatch } from '../domain/titleEditing'
import type { TitleElement } from '../domain/titleElements'
import { useTitleEditorStore, readTitleDefinition, readTitleElement, resolveTitleFont, TITLE_ANIMATION_PROPERTIES, titleAnimationPropertySpec, TEXT_FONT_FAMILIES } from '../state/titleEditorStore'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { commitTitleEdit } from '../app/titleEditingController'
import { createTitleUpgradeController } from '../app/titleUpgradeController'
import LazySurfaceBoundary from './LazySurfaceBoundary'
import { NumberField } from './inspector/InspectorFields'
import './titleEditor.css'

const TitleMotionDialog = lazy(() => import('./TitleMotionDialog'))
const TitleTemplateDialog = lazy(() => import('./TitleTemplateDialog'))
const upgradeController = createTitleUpgradeController()
function TextField({ label, value, multiline, onCommit }: { label: string; value: string; multiline?: boolean; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <label className="title-field">{label}{multiline ? <textarea value={draft} maxLength={20000} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft) }} />
    : <input value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (draft !== value) onCommit(draft) } }} />}</label>
}
export default function TitleInspector({ clip, locked }: { clip: Clip; locked: boolean }) {
  const sequenceId = useDocumentStore((state) => state.activeSequenceId)
  const selectionClip = useTitleEditorStore((state) => state.clipId), ids = useTitleEditorStore((state) => state.ids)
  const safeGuides = useTitleEditorStore((state) => state.safeGuides)
  const playing = useTransportStore((state) => state.isPlaying || state.isScrubbing)
  const [error, setError] = useState(''), [dialog, setDialog] = useState<'motion' | 'save' | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const parsed = clip.title ? readTitleDefinition(clip.title) : null
  const elements = parsed?.status === 'supported' ? parsed.title.elements : []
  const selected = selectionClip === clip.id ? ids.filter((id) => elements.some((element) => element.id === id)) : []
  const firstElementId = elements[0]?.id
  const reconciledIds = JSON.stringify(selected.length ? selected : firstElementId ? [firstElementId] : [])
  const currentIds = JSON.stringify(ids)
  useEffect(() => {
    if (firstElementId && (selectionClip !== clip.id || currentIds !== reconciledIds)) useTitleEditorStore.getState().select(clip.id, JSON.parse(reconciledIds) as string[])
  }, [clip.id, firstElementId, selectionClip, currentIds, reconciledIds]) // Data replacement reconciles stable element identities.
  const apply = (command: TitleEditCommand) => setError(commitTitleEdit({ sequenceId, clipId: clip.id }, command) ?? '')
  const patch = (patch: TitleElementPatch) => apply({ kind: 'patch', ids: selected, patch })
  const supported = selected.flatMap((id) => { const raw = elements.find((element) => element.id === id); const result = raw ? readTitleElement(raw) : null; return result?.status === 'supported' ? [result.element] : [] })
  const first = supported[0]
  const disabled = locked || playing
  const close = () => { setDialog(null); requestAnimationFrame(() => opener.current?.focus()) }
  if (clip.text) return <section className="title-inspector" aria-label="Title authoring">
    <p>Compact text · supported as saved. Upgrade to add elements or element animation.</p>
    <button type="button" disabled={disabled} onClick={() => setError(upgradeController.upgrade(upgradeController.begin(clip.id)) ?? '')}>Upgrade to title</button>
    {error && <p role="alert">{error}</p>}
  </section>
  if (!clip.title) return null
  if (parsed?.status !== 'supported') return <p role="status">{parsed?.reason} Stored title intent is preserved.</p>
  function toggleSelection(id: string, checked: boolean) { useTitleEditorStore.getState().select(clip.id, checked ? [...selected, id] : selected.filter((item) => item !== id)) }
  function reorder(id: string, delta: number) {
    const order = elements.map((element) => element.id), index = order.indexOf(id), next = index + delta
    if (next < 0 || next >= order.length) return
    ;[order[index], order[next]] = [order[next], order[index]]
    apply({ kind: 'reorder', ids: order })
  }
  return <section className="title-inspector" aria-label="Title authoring">
    <h3>Title elements</h3><p>Back to front. Select several elements for a shared edit.</p>
    <ol className="title-element-list">{elements.map((element, index) => <li key={element.id}>
      <label><input type="checkbox" checked={selected.includes(element.id)} onChange={(event) => toggleSelection(element.id, event.target.checked)} />{element.name} <small>{element.kind}{element.enabled ? '' : ' · hidden'}</small></label>
      <button type="button" aria-label={`Move ${element.name} backward`} disabled={disabled || index === 0} onClick={() => reorder(element.id, -1)}>↓</button>
      <button type="button" aria-label={`Move ${element.name} forward`} disabled={disabled || index === elements.length - 1} onClick={() => reorder(element.id, 1)}>↑</button>
    </li>)}</ol>
    <fieldset disabled={disabled}><legend className="visually-hidden">Edit title elements</legend>
      <div className="title-actions">{(['text', 'rectangle', 'ellipse'] as const).map((kind) => <button key={kind} type="button" disabled={elements.length >= 16} onClick={() => apply({ kind: 'add', elementKind: kind })}>Add {kind}</button>)}</div>
      <div className="title-actions"><button type="button" disabled={!selected.length || elements.length + selected.length > 16} onClick={() => apply({ kind: 'duplicate', ids: selected })}>Duplicate elements</button>
        <button type="button" disabled={!selected.length || selected.length === elements.length} onClick={() => apply({ kind: 'delete', ids: selected })}>Delete elements</button></div>
      {first && supported.length === selected.length ? <>
        <p>Base values{selected.length > 1 ? ` · applies to ${selected.length} elements; first selected value shown` : ''}. Existing keys override these at animated frames.</p>
        {selected.length === 1 && <TextField label="Element name" value={first.name} onCommit={(name) => patch({ name })} />}
        <label><input type="checkbox" checked={first.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />Enabled</label>
        <div className="title-field-grid">{TITLE_ANIMATION_PROPERTIES.map((property) => {
          const spec = titleAnimationPropertySpec(first, 1, property)
          if (spec.status !== 'available' || supported.some((element) => titleAnimationPropertySpec(element, 1, property).status !== 'available')) return null
          const keyed = clip.animation?.titleTracks?.some((lane) => selected.includes(lane.elementId) && lane.property === property && lane.keyframes.length)
          return <div key={property}><NumberField testId={`title-${property}`} label={spec.spec.label} value={spec.fallback} step={spec.spec.step} min={spec.spec.min} max={spec.spec.max} onCommit={(value) => apply({ kind: 'values', ids: selected, values: { [property]: value } })} />{keyed && <small>Animated</small>}</div>
        })}</div>
        <label><input type="checkbox" checked={first.visual.scaleLocked} onChange={(event) => patch({ visual: { scaleLocked: event.target.checked } })} />Lock scale ratio (X when enabling)</label>
        <div className="title-field-grid">{(['anchorX', 'anchorY'] as const).map((key) => <NumberField testId={`title-${key}`} key={key} label={key === 'anchorX' ? 'Anchor X' : 'Anchor Y'} value={first.transform[key]} min={0} max={1} step={0.01} onCommit={(value) => patch({ transform: { [key]: value } })} />)}
          {(['left', 'right', 'top', 'bottom'] as const).map((edge) => <NumberField testId={`title-crop-${edge}`} key={edge} label={`Crop ${edge}`} value={first.visual.crop[edge]} min={0} max={0.99} step={0.01} onCommit={(value) => patch({ visual: { crop: { [edge]: value } } })} />)}</div>
        {(['flipHorizontal', 'flipVertical'] as const).map((key) => <label key={key}><input type="checkbox" checked={first.visual[key]} onChange={(event) => patch({ visual: { [key]: event.target.checked } })} />{key === 'flipHorizontal' ? 'Flip horizontal' : 'Flip vertical'}</label>)}
        {supported.every((element) => element.kind === first.kind) && <ElementStyle element={first} multiple={selected.length > 1} patch={patch} />}
      </> : <p>Select supported elements to edit their properties. Unavailable elements keep their stored data.</p>}
      <div className="title-actions"><button type="button" disabled={!selected.length || supported.length !== selected.length || clip.timelineRange.durationFrames < 2} onClick={(event) => { opener.current = event.currentTarget; setDialog('motion') }}>Roll / crawl…</button>
        <button type="button" onClick={(event) => { opener.current = event.currentTarget; setDialog('save') }}>Save title template…</button></div>
    </fieldset>
    <label><input type="checkbox" checked={safeGuides} onChange={(event) => useTitleEditorStore.getState().setSafeGuides(event.target.checked)} />Safe guides · title 90% / action 95%</label>
    {disabled && <p>{locked ? 'Track locked.' : 'Pause playback to edit.'}</p>}{error && <p role="alert">{error}</p>}
    {dialog && <LazySurfaceBoundary variant="dialog" loadingLabel="Loading title tools…" failureTitle="Title tools could not load" onClose={close}>{dialog === 'motion' ? <TitleMotionDialog target={{ sequenceId, clipId: clip.id }} ids={selected} clip={clip} onClose={close} /> : <TitleTemplateDialog captureTarget={{ sequenceId, clipId: clip.id }} onClose={close} />}</LazySurfaceBoundary>}
  </section>
}
function ElementStyle({ element, multiple, patch }: { element: TitleElement; multiple: boolean; patch(patch: TitleElementPatch): void }) {
  if (element.kind !== 'text') return <>
    <TextField label="Fill color" value={element.shape.fillColor} onCommit={(fillColor) => patch({ shape: { fillColor } })} />
    <label><input type="checkbox" checked={element.shape.outlineEnabled} onChange={(event) => patch({ shape: { outlineEnabled: event.target.checked } })} />Outline</label>
    <TextField label="Outline color" value={element.shape.outlineColor} onCommit={(outlineColor) => patch({ shape: { outlineColor } })} />
  </>
  const { text, font } = element, fontStatus = resolveTitleFont(font)
  return <>
    {!multiple && <TextField label="Text content" value={text.content} multiline onCommit={(content) => patch({ text: { content } })} />}
    <p role="status">{fontStatus.status === 'unavailable' ? `${font.family} is unavailable. Choose a fallback below.` : `${fontStatus.family} · platform-dependent${fontStatus.usesFallback ? ` fallback for ${font.family}` : ''}.`}</p>
    <label className="title-field">Font family<select value={font.family} onChange={(event) => patch({ font: { family: event.target.value, fallbackFamily: null } })}>{!TEXT_FONT_FAMILIES.some((family) => family === font.family) && <option>{font.family}</option>}{TEXT_FONT_FAMILIES.map((family) => <option key={family}>{family}</option>)}</select></label>
    <label className="title-field">Explicit font fallback<select value={font.fallbackFamily ?? ''} onChange={(event) => patch({ font: { ...font, fallbackFamily: (event.target.value || null) as typeof font.fallbackFamily } })}><option value="">No fallback</option>{TEXT_FONT_FAMILIES.map((family) => <option key={family}>{family}</option>)}</select></label>
    <label className="title-field">Text alignment<select value={text.align} onChange={(event) => patch({ text: { align: event.target.value as typeof text.align } })}>{['left', 'center', 'right'].map((align) => <option key={align}>{align}</option>)}</select></label>
    <TextField label="Text color" value={text.color} onCommit={(color) => patch({ text: { color } })} />
    <NumberField testId="title-padding" label="Text padding" value={text.paddingPx} min={0} max={1024} step={1} onCommit={(paddingPx) => patch({ text: { paddingPx } })} />
    {(['bold', 'italic', 'backgroundEnabled', 'outlineEnabled', 'shadowEnabled'] as const).map((key) => <label key={key}><input type="checkbox" checked={text[key]} onChange={(event) => patch({ text: { [key]: event.target.checked } })} />{{ bold: 'Bold', italic: 'Italic', backgroundEnabled: 'Background', outlineEnabled: 'Outline', shadowEnabled: 'Shadow' }[key]}</label>)}
    {(['backgroundColor', 'outlineColor', 'shadowColor'] as const).map((key) => <TextField key={key} label={{ backgroundColor: 'Background color', outlineColor: 'Outline color', shadowColor: 'Shadow color' }[key]} value={text[key]} onCommit={(value) => patch({ text: { [key]: value } })} />)}
  </>
}
