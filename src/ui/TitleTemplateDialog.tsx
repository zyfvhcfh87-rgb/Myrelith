import { useEffect, useRef, useState } from 'react'
import type { TitleEditTarget } from '../domain/titleEditing'
import type { TitleTemplateV1 } from '../domain/titleTemplates'
import { titleTemplateController, pinTitleTemplateDialog } from '../app/titleTemplateController'
import { builtInTitleTemplates, titleTemplateConversion } from '../state/titleEditorStore'
import { useTitleTemplateStore } from '../state/titleTemplateStore'
import './titleEditor.css'
export default function TitleTemplateDialog({ captureTarget, onClose }: { captureTarget?: TitleEditTarget; onClose(): void }) {
  const [pin] = useState(pinTitleTemplateDialog), [builtins] = useState(builtInTitleTemplates)
  const sequence = pin.project.sequences.find((item) => item.id === pin.sequenceId)!
  const [name, setName] = useState('Untitled title'), [trackId, setTrackId] = useState(sequence.tracks.find((track) => track.kind === 'video' && !track.locked)?.id ?? '')
  const [chosen, setChosen] = useState<TitleTemplateV1 | null>(builtins[0]), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const library = useTitleTemplateStore(), dialog = useRef<HTMLDialogElement>(null), readRevision = useRef(0)
  useEffect(() => {
    const prior = document.activeElement, node = dialog.current, revision = readRevision
    if (node?.showModal) node.showModal(); else node?.setAttribute('open', '')
    void titleTemplateController.load()
    return () => { revision.current++; if (prior instanceof HTMLElement) prior.focus() }
  }, [])
  async function chooseLocal(id: string) {
    const revision = ++readRevision.current; setLoading(true); setError(''); setChosen(null)
    try { const template = await titleTemplateController.read(id); if (revision === readRevision.current) setChosen(template) }
    catch (cause) { if (revision === readRevision.current) setError(String(cause)) }
    finally { if (revision === readRevision.current) setLoading(false) }
  }
  const conversion = chosen ? titleTemplateConversion(chosen, sequence) : null
  return <dialog ref={dialog} className="title-dialog" aria-labelledby="title-template-heading" onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={(event) => event.stopPropagation()}>
    <h2 id="title-template-heading">{captureTarget ? 'Save title template' : 'Title templates'}</h2>
    <p>Local to this browser. Used titles are independent editable copies saved with the project.</p>
    {captureTarget ? <><label className="title-field">Template name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label><button type="button" disabled={library.busy || !!library.readOnlyReason} onClick={async () => { if (await titleTemplateController.save(pin, captureTarget, name)) onClose() }}>Save template</button></>
      : <><h3>Built-in titles</h3><div className="title-actions">{builtins.map((template) => <button type="button" key={template.id} aria-pressed={chosen === template} onClick={() => { readRevision.current++; setLoading(false); setChosen(template) }}>{template.name}</button>)}</div>
        <h3>My templates</h3>{library.templates.length === 0 && <p>No saved templates yet.</p>}<ul className="title-template-list">{library.templates.map((template) => <li key={template.id}><button type="button" onClick={() => void chooseLocal(template.id)}>{template.name}</button><small>{template.elements} elements · {template.durationFrames} frames</small><button type="button" disabled={library.busy} aria-label={`Delete template ${template.name}`} onClick={async () => { if (await titleTemplateController.delete(template.id)) { if (chosen?.id === template.id) setChosen(null) } }}>Delete</button></li>)}</ul>
        <p>Deleting a template leaves all used copies unchanged.</p>
        {chosen && conversion && <div className="title-template-review"><strong>{chosen.name}</strong><p>{chosen.canvasWidth} × {chosen.canvasHeight} → {sequence.width} × {sequence.height}. {conversion.converted ? `Uniform fit ×${conversion.factor.toFixed(4)}, centered. Geometry and pixel-valued keys are scaled.` : 'Same canvas; geometry is preserved.'}</p><p>{chosen.durationFrames} frames at the destination rate · {conversion.durationSeconds.toFixed(3)} seconds.{conversion.rateChanged ? ' Frame rates differ. Exact local frame numbers are preserved.' : ''}</p></div>}
        <label className="title-field">Destination track<select value={trackId} onChange={(event) => setTrackId(event.target.value)}>{sequence.tracks.filter((track) => track.kind === 'video').map((track) => <option key={track.id} value={track.id} disabled={track.locked}>{track.name}{track.locked ? ' (locked)' : ''}</option>)}</select></label><p>Insert at frame {pin.frame}.</p>
        <button type="button" disabled={!chosen || loading || !trackId} onClick={() => { if (!chosen) return; const failure = titleTemplateController.insert(pin, trackId, chosen); if (failure) setError(failure); else onClose() }}>Apply template</button>
      </>}
    {!!library.unavailable.length && <p role="status">{library.unavailable.length} unavailable records are preserved in the library.</p>}{library.readOnlyReason && <p role="alert">{library.readOnlyReason}</p>}{(error || library.error) && <p role="alert">{error || library.error}</p>}
    <button type="button" onClick={onClose}>Cancel</button>
  </dialog>
}
