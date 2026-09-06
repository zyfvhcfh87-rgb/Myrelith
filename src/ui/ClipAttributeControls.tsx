import { useEffect, useId, useRef, useState } from 'react'
import { CLIP_ATTRIBUTE_LABELS } from '../state/editorUi'
import { useClipAttributeStore } from '../state/clipAttributeStore'
import {
  applyAttributeEdit, copyClipAttributes, openAttributeEdit,
  type AttributeEditSession,
} from '../app/clipAttributeController'
import type { ClipAttributeGroup, StackPasteMode } from '../domain/clipAttributes'

function AttributeDialog({ session, mode, onClose }: {
  session: AttributeEditSession
  mode: 'paste' | 'reset'
  onClose(): void
}) {
  const [groups, setGroups] = useState<readonly ClipAttributeGroup[]>(session.groups)
  const [includeAnimation, setIncludeAnimation] = useState(true)
  const [effectsMode, setEffectsMode] = useState<StackPasteMode>('append')
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const detailId = useId()
  const action = mode === 'paste' ? 'Paste' : 'Reset'
  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    if (dialog?.showModal) dialog.showModal()
    else dialog?.setAttribute('open', '')
    const frame = requestAnimationFrame(() => dialog?.querySelector<HTMLInputElement>('input')?.focus())
    return () => {
      cancelAnimationFrame(frame)
      if (dialog?.open && dialog.close) dialog.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  return (
    <dialog ref={ref} className="text-overlay-dialog attribute-dialog" aria-labelledby={titleId} aria-describedby={detailId}
      onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={(event) => event.stopPropagation()}>
      <form className="text-overlay-dialog-card" onSubmit={(event) => {
        event.preventDefault()
        const failure = applyAttributeEdit(session, mode, { groups, includeAnimation, effectsMode })
        if (failure) setError(failure)
        else onClose()
      }}>
        <header><h2 id={titleId}>{action} attributes</h2>
          <button type="button" className="text-overlay-dialog-close" aria-label="Close attribute dialog" onClick={onClose}>×</button>
        </header>
        <p id={detailId}>{action} on {session.targetNames.length} selected clip{session.targetNames.length === 1 ? '' : 's'}: {session.targetNames.join(', ')}.</p>
        <fieldset className="attribute-groups"><legend>Attribute groups</legend>
          {session.groups.map((group) => <label key={group}>
            <input type="checkbox" checked={groups.includes(group)} onChange={(event) => {
              setGroups(event.target.checked ? [...groups, group] : groups.filter((item) => item !== group))
              setError(null)
            }} /> {CLIP_ATTRIBUTE_LABELS[group]}
          </label>)}
        </fieldset>
        {session.groups.length === 0 && <p role="status">No compatible attribute groups. Select clips of the same kind.</p>}
        {mode === 'paste' ? <>
          <label className="attribute-option"><input type="checkbox" checked={includeAnimation}
            onChange={(event) => setIncludeAnimation(event.target.checked)} /> Include animation</label>
          <p>Keys keep their frame offsets from each clip's start, including keys outside its duration. Unchecking clears animation on the replaced attributes.</p>
          {groups.includes('effects') && <label className="text-overlay-dialog-field"><span>Effect stack</span>
            <select value={effectsMode} onChange={(event) => setEffectsMode(event.target.value as StackPasteMode)}>
              <option value="append">Append copied effects</option><option value="replace">Replace entire effect stack and its keys</option>
            </select>
          </label>}
        </> : <p>Reset restores defaults and clears the chosen attributes' animation. Unknown effects must be removed explicitly.</p>}
        <p>All selected clips change together in one undo step. Linked partners are affected only if selected.</p>
        {error && <p role="alert">{error}</p>}
        <footer className="text-overlay-dialog-actions">
          <button type="button" className="text-overlay-dialog-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="text-overlay-dialog-submit" disabled={!groups.length || !session.targetIds.length}>Apply {mode === 'paste' ? 'paste' : 'reset'}</button>
        </footer>
      </form>
    </dialog>
  )
}

export default function ClipAttributeControls({ clipId }: { clipId: string }) {
  const sourceName = useClipAttributeStore((state) => state.sourceName)
  const message = useClipAttributeStore((state) => state.message)
  const [dialog, setDialog] = useState<{ session: AttributeEditSession; mode: 'paste' | 'reset' } | null>(null)
  return <section className="inspector-section" aria-label="Clip attribute actions">
    <div className="inspector-effect-actions">
      <button type="button" onClick={() => copyClipAttributes(clipId)}>Copy attributes</button>
      <button type="button" disabled={!sourceName} onClick={() => setDialog({ mode: 'paste', session: openAttributeEdit('paste') })}>Paste attributes…</button>
      <button type="button" onClick={() => setDialog({ mode: 'reset', session: openAttributeEdit('reset') })}>Reset attributes…</button>
    </div>
    {message && <p role="status">{message}</p>}
    {dialog && <AttributeDialog {...dialog} onClose={() => setDialog(null)} />}
  </section>
}
