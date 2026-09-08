import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { ANIMATION_EDIT_LIMITS, animationKeyAt, animationKeyKey, animationLaneKey, animationLowerBound, animationValueAt, buildAnimationLaneIndex, resolveAnimationFocusedLane, filterAnimationLanes, type AnimationBatchCommand, type AnimationKeyAddress, type AnimationLaneFilter, type AnimationLaneRow, type AnimationPasteMapping } from '../../state/animationEditor'
import { animationEditorController, getAnimationEditorContext, subscribeAnimationDeclarations } from '../../app/animationEditorController'
import { animationCommandResult, bindAnimationLane, closeAnimationWorkspace } from '../../app/animationWorkspaceController'
import { calculateTimelineZoomGeometry, clampTimelineZoom } from '../timeline/timelineZoom'
import AnimationGrid from './AnimationGrid'
import AnimationKeyControls from './AnimationKeyControls'
import './animation.css'

export default function AnimationWorkspace({ onClose = closeAnimationWorkspace }: { onClose?: () => void }) {
  const document = useDocumentStore((state) => state.doc)
  const context = useSyncExternalStore(subscribeAnimationDeclarations, getAnimationEditorContext)
  const index = useMemo(() => buildAnimationLaneIndex(document, context), [document, context])
  const selection = useTransportStore((state) => state.animationSelection), focus = useTransportStore((state) => state.animationFocus)
  const laneAddress = useTransportStore((state) => state.animationFocusedLane)
  const text = useTransportStore((state) => state.animationFilter)
  const clipIds = useTransportStore((state) => state.selectedClipIds), adjustmentId = useTransportStore((state) => state.selectedAdjustmentId)
  const playing = useTransportStore((state) => state.isPlaying), scrubbing = useTransportStore((state) => state.isScrubbing)
  const status = useTransportStore((state) => state.animationStatus)
  const [animatedOnly, setAnimatedOnly] = useState(false), [selectedOnly, setSelectedOnly] = useState(false)
  const [kind, setKind] = useState<AnimationLaneFilter['kind']>('all'), [mode, setMode] = useState<'sheet' | 'curve'>('sheet')
  const [reveal, setReveal] = useState(0), [requestedFrame, setRequestedFrame] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null), anchor = useRef<AnimationKeyAddress | null>(null)
  const owners = useMemo(() => selectedOnly ? new Set([...clipIds, ...(adjustmentId ? [adjustmentId] : [])]) : undefined, [selectedOnly, clipIds, adjustmentId])
  const rows = useMemo(() => filterAnimationLanes(index, { text, animatedOnly, kind, ownerIds: owners }), [index, text, animatedOnly, kind, owners])
  const explicitFocus = useMemo(() => laneAddress ? resolveAnimationFocusedLane(index, laneAddress, context) : undefined, [index, laneAddress, context])
  const focused = laneAddress ? explicitFocus : rows[0]
  const frame = focus && focused?.id === animationLaneKey(focus.lane) ? focus.frame : null
  const disabled = playing || scrubbing || !!focused?.owner.track.locked
  const clipboard = animationEditorController.getClipboard()
  const [mappingOpen, setMappingOpen] = useState(false), [mappingPage, setMappingPage] = useState(0)
  const [mapping, setMapping] = useState<readonly AnimationPasteMapping[]>([])
  useEffect(() => { setMapping([]); setMappingPage(0) }, [clipboard])
  useEffect(() => () => animationEditorController.cancel(), [])
  useEffect(() => { root.current?.querySelector<HTMLElement>('[role="grid"]')?.focus() }, [])
  const revealFocus = useCallback(() => { setRequestedFrame(null); setReveal((value) => value + 1) }, [])
  function changeMode(next: typeof mode) {
    // End the outgoing gesture while its captured input still exists. Removed
    // glyphs cannot be relied on to receive a later lost-capture event.
    if (next !== mode) animationEditorController.cancel()
    setMode(next); revealFocus()
  }
  const edit = useCallback((command: AnimationBatchCommand, success: string) => {
    const error = animationEditorController.edit(command)
    animationCommandResult(error, success)
    if (!error) revealFocus()
  }, [revealFocus])
  const select = useCallback((row: AnimationLaneRow, offset: number, extend: boolean, toggle: boolean) => {
    const key = animationKeyAt(row, offset)
    if (!key) return
    const transport = useTransportStore.getState(), current = transport.animationSelection
    let next: readonly AnimationKeyAddress[]
    if (extend && anchor.current && animationLaneKey(anchor.current.lane) === row.id) {
      const first = animationLowerBound(row.frames, Math.min(anchor.current.frame, key.frame)), end = animationLowerBound(row.frames, Math.max(anchor.current.frame, key.frame)) + 1
      if (end - first > ANIMATION_EDIT_LIMITS.selectedKeys) { animationCommandResult('Select at most 4,096 keys at once.', ''); return }
      next = Array.from({ length: end - first }, (_, offset) => animationKeyAt(row, first + offset)!)
    } else {
      const id = animationKeyKey(key), exists = current.some((item) => animationKeyKey(item) === id)
      next = toggle ? exists ? current.filter((item) => animationKeyKey(item) !== id) : [...current, key] : [key]
      anchor.current = key
    }
    if (next.length > ANIMATION_EDIT_LIMITS.selectedKeys || new Set(next.map((key) => animationLaneKey(key.lane))).size > ANIMATION_EDIT_LIMITS.lanes) {
      animationCommandResult('Select at most 4,096 keys across 128 lanes.', ''); return
    }
    transport.setAnimationFocusedLane(row.address)
    transport.setAnimationSelection(next, next.some((item) => animationKeyKey(item) === animationKeyKey(key)) ? key : next.at(-1) ?? null)
  }, [])
  const onLane = useCallback((row: AnimationLaneRow) => {
    const transport = useTransportStore.getState()
    transport.setAnimationSelection([]); transport.setAnimationFocusedLane(row.address); anchor.current = null
  }, [])
  const add = useCallback(() => {
    if (!focused) return
    const global = useTransportStore.getState().playheadFrame, value = animationValueAt(focused, global)
    if (value === null) { animationCommandResult(focused.reason ?? 'This property cannot create scalar keys.', ''); return }
    const error = animationEditorController.setKey(focused.address, global - focused.owner.item.timelineRange.startFrame, value)
    animationCommandResult(error, 'Key set at the playhead.'); if (!error) revealFocus()
  }, [focused, revealFocus])
  const paste = useCallback((originalTime = false, mapped?: readonly AnimationPasteMapping[]) => {
    const error = animationEditorController.paste(mapped, originalTime)
    animationCommandResult(error, 'Keys pasted.'); if (!error) revealFocus()
  }, [revealFocus])
  function navigate(direction: 'previous' | 'next' | 'first' | 'last', extend = false) {
    if (!focused?.frames.length) return
    const at = frame === null ? -1 : animationLowerBound(focused.frames, frame)
    const offset = direction === 'first' ? 0 : direction === 'last' ? focused.frames.length - 1 : direction === 'next' ? Math.min(focused.frames.length - 1, at + 1) : Math.max(0, at - 1)
    select(focused, offset, extend, false); revealFocus()
  }
  function selectAll() {
    let count = 0, lanes = 0
    for (const row of rows) { count += row.frames.length; lanes += Number(!!row.frames.length) }
    if (count > ANIMATION_EDIT_LIMITS.selectedKeys || lanes > ANIMATION_EDIT_LIMITS.lanes) { animationCommandResult('Narrow the filters to select at most 4,096 keys across 128 lanes.', ''); return }
    const keys = rows.flatMap((row) => row.frames.map((_, offset) => animationKeyAt(row, offset)!))
    useTransportStore.getState().setAnimationSelection(keys, keys[0] ?? null)
  }
  function viewport(action: 'in' | 'out' | 'fit' | 'reset' | 'left' | 'right') {
    animationEditorController.cancel()
    const transport = useTransportStore.getState(), width = Math.max(1, (root.current?.querySelector<HTMLElement>('[role="grid"]')?.clientWidth || 600) - 248)
    let first = Infinity, last = 0
    for (const row of rows) if (row.frames.length) { first = Math.min(first, row.globalFrames[0]); last = Math.max(last, row.globalFrames.at(-1)!) }
    if (!Number.isFinite(first)) first = 0
    const bounds = calculateTimelineZoomGeometry(width, Math.max(1, last - Math.max(0, first) + 1), document.frameRate)
    const visibleStart = transport.animationVisibleRange?.startFrame ?? transport.timelineOriginFrame
    if (action === 'left' || action === 'right') setRequestedFrame(Math.max(0, Math.round(visibleStart + (action === 'left' ? -.8 : .8) * width / transport.zoom)))
    else {
      transport.setZoom(action === 'fit' ? bounds.fullZoom : action === 'reset' ? bounds.detailZoom : clampTimelineZoom(transport.zoom * (action === 'in' ? 1.25 : .8), bounds.minZoom, bounds.maxZoom))
      setRequestedFrame(action === 'fit' ? Math.max(0, first) : action === 'reset' ? 0 : Math.max(0, Math.round(visibleStart)))
    }
    setReveal((value) => value + 1)
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable)) { event.stopPropagation(); return }
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) { event.stopPropagation(); return }
    const mod = event.metaKey || event.ctrlKey, key = event.key.toLowerCase()
    let handled = true
    if (key === 'escape') animationEditorController.cancel()
    else if (mod && (key === 'z' || key === 'y')) { animationEditorController.cancel(); if (key === 'y' || event.shiftKey) useDocumentStore.getState().redo(); else useDocumentStore.getState().undo() }
    else if (mod && key === 'c') animationCommandResult(animationEditorController.copy(), 'Keys copied.')
    else if (mod && key === 'x') animationCommandResult(animationEditorController.cut(), 'Keys cut.')
    else if (mod && key === 'v') paste(event.shiftKey)
    else if (mod && key === 'd') edit({ kind: 'duplicate', deltaFrames: 1 }, 'Keys duplicated one frame later.')
    else if (mod && key === 'a') selectAll()
    else if (key === 'delete' || key === 'backspace') edit({ kind: 'delete' }, 'Selected keys deleted.')
    else if (mod && (key === 'arrowleft' || key === 'arrowright')) edit({ kind: 'move', deltaFrames: (key === 'arrowleft' ? -1 : 1) * (event.shiftKey ? 10 : 1) }, 'Selected keys moved.')
    else if (key === 'arrowleft' || key === 'arrowright') navigate(key === 'arrowleft' ? 'previous' : 'next', event.shiftKey)
    else if (key === 'home' || key === 'end') navigate(key === 'home' ? 'first' : 'last', event.shiftKey)
    else if (key === 'arrowup' || key === 'arrowdown') { const offset = Math.max(0, Math.min(rows.length - 1, rows.indexOf(focused!) + (key === 'arrowup' ? -1 : 1))); if (rows[offset]) { onLane(rows[offset]); revealFocus() } }
    else if (key === 'k') add()
    else if (key === '+' || key === '=') viewport('in')
    else if (key === '-') viewport('out')
    else handled = false
    if (handled) { event.preventDefault(); event.stopPropagation() }
  }
  const copiedLane = clipboard?.lanes[mappingPage]
  return <section ref={root} className="animation-workspace" aria-label="Animation workspace" onKeyDown={onKeyDown}>
    <div className="animation-toolbar">
      <strong>Animation</strong><button type="button" aria-pressed={mode === 'sheet'} onClick={() => changeMode('sheet')}>Dope sheet</button><button type="button" aria-pressed={mode === 'curve'} onClick={() => changeMode('curve')}>Curve</button>
      <input aria-label="Filter animation lanes" placeholder="Find track, item or property" value={text} onChange={(event) => useTransportStore.getState().setAnimationFilter(event.target.value)} />
      <label><input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} />Selected items</label>
      <label><input type="checkbox" checked={animatedOnly} onChange={(event) => setAnimatedOnly(event.target.checked)} />Animated only</label>
      <select aria-label="Animation lane kind" value={kind} onChange={(event) => setKind(event.target.value as AnimationLaneFilter['kind'])}><option value="all">All properties</option><option value="scalar">Clip / audio</option><option value="effect">Effects</option><option value="title">Title elements</option><option value="path">Held paths</option></select>
      <button type="button" onClick={onClose}>Back to Timeline</button>
    </div>
    <div className="animation-toolbar animation-tools" aria-label="Animation commands">
      <button type="button" onClick={() => navigate('first')}>First</button><button type="button" onClick={() => navigate('previous')}>Previous</button><button type="button" onClick={() => navigate('next')}>Next</button><button type="button" onClick={() => navigate('last')}>Last</button>
      {[-10, -1, 1, 10].map((delta) => <button key={delta} type="button" disabled={disabled || !selection.length} onClick={() => edit({ kind: 'move', deltaFrames: delta }, 'Selected keys moved.')}>{delta > 0 ? '+' : ''}{delta}f</button>)}
      <button type="button" disabled={!selection.length} onClick={() => animationCommandResult(animationEditorController.copy(), 'Keys copied.')}>Copy</button>
      <button type="button" disabled={disabled || !selection.length} onClick={() => animationCommandResult(animationEditorController.cut(), 'Keys cut.')}>Cut</button>
      <button type="button" disabled={playing || scrubbing || !clipboard} onClick={() => paste()}>Paste</button><button type="button" disabled={playing || scrubbing || !clipboard} onClick={() => paste(true)}>Paste original time</button>
      <button type="button" disabled={!clipboard} onClick={() => setMappingOpen((value) => !value)}>Map paste…</button>
      <button type="button" disabled={disabled || !selection.length} onClick={() => edit({ kind: 'delete' }, 'Selected keys deleted.')}>Delete</button>
      <button type="button" aria-label="Horizontal zoom out" onClick={() => viewport('out')}>X−</button><button type="button" aria-label="Horizontal zoom in" onClick={() => viewport('in')}>X+</button>
      <button type="button" aria-label="Pan animation left" onClick={() => viewport('left')}>←</button><button type="button" aria-label="Pan animation right" onClick={() => viewport('right')}>→</button><button type="button" onClick={() => viewport('fit')}>Fit keys</button><button type="button" onClick={() => viewport('reset')}>Reset view</button>
    </div>
    {mappingOpen && clipboard && copiedLane && <div className="animation-mapping" aria-label="Paste destination mapping">
      <span>Copied lane {mappingPage + 1}/{clipboard.lanes.length}: {index.byId.get(animationLaneKey(copiedLane.address))?.group ?? copiedLane.address.owner.id} · {copiedLane.address.kind === 'effect' || copiedLane.address.kind === 'path' ? copiedLane.address.parameter : copiedLane.address.property}</span>
      <button type="button" disabled={mappingPage === 0} onClick={() => setMappingPage((value) => value - 1)}>Previous copied lane</button><button type="button" disabled={mappingPage + 1 === clipboard.lanes.length} onClick={() => setMappingPage((value) => value + 1)}>Next copied lane</button>
      <button type="button" disabled={!focused} onClick={() => setMapping((current) => [...current.filter((entry) => animationLaneKey(entry.from) !== animationLaneKey(copiedLane.address)), { from: copiedLane.address, to: focused!.address }])}>Assign focused property</button>
      <span>Destination: {(() => { const target = mapping.find((entry) => animationLaneKey(entry.from) === animationLaneKey(copiedLane.address))?.to; const row = target && index.byId.get(animationLaneKey(target)); return row ? `${row.group} / ${row.label}` : 'Choose a property in the sheet, then assign it.' })()}</span>
      <button type="button" disabled={playing || scrubbing || mapping.length !== clipboard.lanes.length} onClick={() => paste(false, mapping)}>Paste mapped lanes ({mapping.length}/{clipboard.lanes.length})</button>
    </div>}
    <div className="animation-main"><AnimationGrid index={index} rows={rows} focused={focused} frame={frame} mode={mode} selection={selection} onSelect={select} onLane={onLane} reveal={reveal} requestedFrame={requestedFrame} />
      <AnimationKeyControls row={focused} frame={frame} selectedCount={selection.length} disabled={disabled} edit={edit} add={add} bind={() => { if (focused) animationCommandResult(bindAnimationLane(focused.address), 'Plugin lane bound to the current declaration.') }} /></div>
    <footer className="animation-footer"><span>{rows.length} lanes · {index.keyCount} keys · {selection.length} selected{focused && !rows.includes(focused) ? ' · Focused property is outside the filters' : ''}</span>
      <details><summary>Keyboard help</summary><p>↑↓ properties; ←→ previous/next key; Home/End first/last; Shift extends selection; Ctrl/Cmd-click toggles keys. Ctrl/Cmd+←→ moves 1 frame, add Shift for 10. K sets at playhead; Delete removes; Ctrl/Cmd+C/X/V copies/cuts/pastes; Shift+paste keeps original time; Ctrl/Cmd+D duplicates 1 frame later; Ctrl/Cmd+A selects filtered keys; Ctrl/Cmd+Z undoes; +/− zooms. Escape or lost pointer capture cancels a drag. Alt bypasses snapping. Inputs keep their normal keyboard behavior.</p></details>
      <span key={status.revision} role="status" aria-live="polite">{status.message || (playing || scrubbing ? 'Pause playback to edit keys.' : rows.length ? 'Ready' : 'No properties match these filters.')}</span></footer>
  </section>
}
