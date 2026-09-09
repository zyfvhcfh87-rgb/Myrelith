import { useEffect, useRef, useState } from 'react'
import type { Clip } from '../domain/schema'
import type { TitleEditCommand, TitleEditTarget } from '../domain/titleEditing'
import { beginTitleEdit, type TitleEditSession } from '../app/titleEditingController'
import { titleMotionReplacements } from '../state/titleEditorStore'
import { containTitleDialogKey } from './titleDialogFocus'
import './titleEditor.css'
export default function TitleMotionDialog({ target, ids, clip, onClose }: { target: TitleEditTarget; ids: readonly string[]; clip: Clip; onClose(): void }) {
  const [pinnedTarget] = useState(target)
  const [direction, setDirection] = useState<'up' | 'down' | 'left' | 'right'>('up')
  const [start, setStart] = useState(0), [end, setEnd] = useState(clip.timelineRange.durationFrames - 1), [sample, setSample] = useState(Math.floor(clip.timelineRange.durationFrames / 2))
  const [replace, setReplace] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null), session = useRef<TitleEditSession | null>(null)
  useEffect(() => {
    const node = dialog.current, prior = document.activeElement
    if (node?.showModal) node.showModal(); else node?.setAttribute('open', '')
    let live = true, owned: TitleEditSession | null = null
    try {
      owned = beginTitleEdit(pinnedTarget, () => {
        if (!live) return
        session.current = null; setStale(true)
      })
      session.current = owned; setStale(false); setError('')
    } catch (cause) { setError(String(cause)); setStale(true) }
    return () => {
      // Effect teardown (including StrictMode rehearsal) releases this owner;
      // only an end while the effect is live invalidates the visible review.
      live = false
      if (session.current === owned) session.current = null
      owned?.cancel()
      if (prior instanceof HTMLElement) prior.focus()
    }
  }, [pinnedTarget])
  const replacements = titleMotionReplacements(clip, ids, direction)
  const command: TitleEditCommand = { kind: 'motion', ids, direction, start, end, replace }
  const ready = !stale && (!replacements.length || replace)
  return <dialog ref={dialog} className="title-dialog" aria-labelledby="title-motion-heading" onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={containTitleDialogKey}>
    <h2 id="title-motion-heading">Roll / crawl</h2>
    <p>Generate two linear position keys per selected element. The group starts and ends fully offscreen; its spacing is preserved. Keys remain editable and keep their frame numbers after trimming.</p>
    <label className="title-field">Direction<select value={direction} onChange={(event) => { setDirection(event.target.value as typeof direction); setReplace(false) }}><option value="up">Roll up</option><option value="down">Roll down</option><option value="left">Crawl left</option><option value="right">Crawl right</option></select></label>
    <div className="title-field-grid"><label>Start frame<input type="number" value={start} min={0} step={1} onChange={(event) => setStart(event.target.valueAsNumber)} /></label><label>End frame<input type="number" value={end} min={1} max={clip.timelineRange.durationFrames - 1} step={1} onChange={(event) => setEnd(event.target.valueAsNumber)} /></label></div>
    {!!replacements.length && <><p>Reapply replaces these complete movement tracks:</p><ul>{replacements.map((lane) => <li key={lane.elementId}>{lane.elementId} · {lane.property} · {lane.keyframes.length} keys</li>)}</ul><label><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />Replace all listed movement tracks</label></>}
    <label className="title-field">Preview local frame<input type="number" value={sample} min={0} max={clip.timelineRange.durationFrames - 1} step={1} onChange={(event) => setSample(event.target.valueAsNumber)} /></label>
    <p>Preview samples title elements at this local frame. Put the playhead inside the title first.</p>
    {error && <p role="alert">{error}</p>}{stale && <p role="status">This review has ended. Close and reopen it to edit again.</p>}
    <div className="title-actions"><button type="button" disabled={!ready} onClick={() => setError(session.current?.preview(command, sample) ?? '')}>Preview motion</button>
      <button type="button" disabled={!ready} onClick={() => { const error = session.current ? session.current.commit(command) : 'The review has ended.'; if (error) setError(error); else onClose() }}>{replacements.length ? 'Reapply motion' : 'Apply motion'}</button>
      <button type="button" onClick={onClose}>Cancel</button></div>
  </dialog>
}
