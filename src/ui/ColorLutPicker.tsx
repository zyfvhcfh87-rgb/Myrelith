import { useEffect, useRef, useState } from 'react'
import { colorLutController, reuseColorLut, removeUnusedProjectColorLuts } from '../app/colorLutController'
import type { ColorGradingTarget } from '../app/colorGradingController'
import { useDocumentStore } from '../state/documentStore'
import { useColorLutImportStore } from '../state/colorLutImportStore'
import { isColorLutV1 } from '../state/editorUi'

export default function ColorLutPicker({ target, effectId, disabled = false }: { target: ColorGradingTarget; effectId?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" disabled={disabled} onClick={() => setOpen(true)}>{effectId ? 'Choose LUT…' : 'Add LUT…'}</button>
    {open && <LutDialog target={target} effectId={effectId} onClose={() => setOpen(false)} />}
  </>
}

function LutDialog({ target, effectId, onClose }: { target: ColorGradingTarget; effectId?: string; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const catalog = useDocumentStore((state) => state.project.colorLuts), summary = useColorLutImportStore()
  const [selected, setSelected] = useState(''), [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const opener = document.activeElement, dialog = ref.current
    dialog?.showModal()
    return () => { colorLutController.cancel(); dialog?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus() }
  }, [])
  const reuse = () => { const failure = reuseColorLut(target, selected, effectId); setError(failure); if (!failure) onClose() }
  return <dialog ref={ref} className="text-overlay-dialog grading-lut-dialog" aria-label="Choose LUT"
    onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={(event) => event.stopPropagation()}>
    <div className="text-overlay-dialog-card">
      <header><h2>Choose LUT</h2><button type="button" aria-label="Close LUT picker" onClick={onClose}>×</button></header>
      <p>Import a local .cube table or reuse one embedded in this project. Its values travel with your saved project.</p>
      <label className="text-overlay-dialog-field">Local .cube file<input type="file" accept=".cube" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''; setError(null)
        if (file) colorLutController.begin(file, target, effectId)
      }} /></label>
      <p className="inspector-note">1D: 2–4,096 samples. 3D: 2–33 points per axis. Up to 4 MiB per file. Grading uses display sRGB.</p>
      {summary.phase !== 'idle' && <div role={summary.phase === 'error' ? 'alert' : 'status'}><strong>{summary.name}</strong><p>{summary.detail}</p></div>}
      {summary.phase === 'ready' && <button type="button" onClick={() => { const failure = colorLutController.apply(); setError(failure); if (!failure) onClose() }}>Apply imported LUT</button>}
      {summary.phase === 'reading' && <button type="button" onClick={() => colorLutController.cancel()}>Cancel import</button>}
      <label className="text-overlay-dialog-field">Embedded LUT<select aria-label="Embedded LUT" value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">Choose a project table</option>
        {(catalog ?? []).map((table) => <option key={table.id} value={table.id} disabled={!isColorLutV1(table)}>{String(table.name ?? table.id)}{isColorLutV1(table) ? ` · ${table.kind.toUpperCase()} ${table.size}` : ' · unsupported version'}</option>)}
      </select></label>
      <button type="button" disabled={!selected || summary.phase === 'reading'} onClick={reuse}>Use embedded LUT</button>
      <details><summary>Manage project tables</summary>
        <p>Remove tables no effect references. Undo restores them. Unknown effect contracts keep their tables protected.</p>
        <button type="button" disabled={summary.phase === 'reading' || summary.phase === 'ready'} onClick={() => { setError(removeUnusedProjectColorLuts()); setSelected('') }}>Remove unused LUTs</button>
      </details>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button></footer>
    </div>
  </dialog>
}
