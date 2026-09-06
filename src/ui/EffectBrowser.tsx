import { applyVideoBusEdit, openVideoBusEdit, openVideoBusPresetSave, videoBusEffectIneligibility, videoBusOwner, videoBusRenderBudgetError, type VideoBusTarget } from '../app/videoBusController'
import { useEffect, useId, useRef, useState } from 'react'
import { openAttributeEdit } from '../app/clipAttributeController'
import { applyEffectTemplate, builtInEffectChoices, effectPresetController, openPresetSave, presetEffectAvailability, effectTemplatePreview, resetEffectGeometry, type PresetSaveSession } from '../app/effectPresetController'
import { useEffectPresetStore } from '../state/effectPresetStore'
import { useDocumentStore } from '../state/documentStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import { useTransportStore } from '../state/transportStore'
import { useOptionalPluginAppSnapshot, useOptionalPluginEditorSnapshot, useOptionalPluginUi } from './plugins/PluginUiHooks'

function BrowserDialog({ clipId, busTarget, saving, onClose }: { clipId?: string; busTarget?: VideoBusTarget; saving: boolean; onClose(): void }) {
  const [busSession] = useState(() => busTarget ? openVideoBusEdit(busTarget) : null)
  const [session] = useState(() => openAttributeEdit('reset'))
  const [capture] = useState<{ save: PresetSaveSession | null; error: string | null }>(() => {
    if (!saving) return { save: null, error: null }
    try { return { save: busTarget ? openVideoBusPresetSave(busTarget) : openPresetSave(clipId!), error: null } }
    catch (error) { return { save: null, error: error instanceof Error ? error.message : 'Cannot capture this stack.' } }
  })
  const library = useEffectPresetStore()
  const capabilities = usePreviewStatusStore((state) => state.rendererCapabilities)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [name, setName] = useState('')
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [error, setError] = useState<string | null>(capture.error)
  const [saved, setSaved] = useState(false)
  const pluginUi = useOptionalPluginUi()
  const plugins = useOptionalPluginAppSnapshot()
  const editor = useOptionalPluginEditorSnapshot()
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    void effectPresetController.load()
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
  const matches = (...parts: string[]) => parts.join(' ').toLowerCase().includes(query.toLowerCase().trim())
  const canWrite = library.loaded && !library.busy && !library.readOnlyReason
  const apply = (effects: Parameters<typeof applyEffectTemplate>[1]) => {
    const failure = busSession ? applyVideoBusEdit(busSession, { kind: 'apply', effects, mode }) : applyEffectTemplate(session, effects, mode)
    if (failure) setError(failure)
    else onClose()
  }
  const busReason = (effects: Parameters<typeof applyEffectTemplate>[1]): string | null => {
    if (!busSession) return null
    const owner = videoBusOwner(busSession.project, busSession.target)
    return owner?.locked ? 'This video track is locked.' : effects.map(videoBusEffectIneligibility).find(Boolean)
      ?? (owner ? videoBusRenderBudgetError(owner.sequence.width, owner.sequence.height) : 'The video bus no longer exists.')
  }
  const builtins = builtInEffectChoices().filter((entry) => matches(entry.label, entry.description, entry.effect.type))
  const presets = library.presets.filter((preset) => matches(preset.name, ...preset.effects.map((effect) => effect.type)))
  const contributions = plugins?.contributions.filter((entry) => matches(entry.contributionName, entry.effectType, entry.detail, entry.pluginName)) ?? []
  return <dialog ref={ref} className="text-overlay-dialog attribute-dialog effect-browser" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={(event) => event.stopPropagation()}>
    <div className="text-overlay-dialog-card">
      <header><h2 id={titleId}>{saving ? 'Save effect preset' : 'Effect browser'}</h2>
        <button type="button" className="text-overlay-dialog-close" aria-label="Close effect browser" onClick={onClose}>×</button></header>
      {capture.save && !saved && <form onSubmit={(event) => { event.preventDefault(); void effectPresetController.save(capture.save!, name).then((ok) => { if (ok) setSaved(true) }) }}>
        <p>Save the values from {capture.save.sourceName} at timeline frame {capture.save.frame}. Animation keys are not included.</p>
        <label className="text-overlay-dialog-field">Preset name<input value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} /></label>
        <button type="submit" disabled={!canWrite || !name.trim()}>Save local preset</button>
      </form>}
      <p>Local presets live in this browser. Clearing site data removes them. Preset files cannot be imported or exported in this version.</p>
      <div className="effect-browser-controls">
        <label className="text-overlay-dialog-field">Search effects<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="text-overlay-dialog-field">Show<select aria-label="Show" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All effects</option><option value="builtins">Built-ins</option><option value="plugins">Installed plugins</option><option value="presets">Local presets</option>
        </select></label>
      </div>
      {busSession ? <p>Target: {busSession.name}. Static post-composite effects.</p> : <p>Target: clip effects on {session.targetNames.length} selected clip{session.targetNames.length === 1 ? '' : 's'}: {session.targetNames.join(', ')}.</p>}
      <label className="text-overlay-dialog-field">Apply stack<select aria-label="Apply stack" value={mode} onChange={(event) => setMode(event.target.value as 'append' | 'replace')}>
        <option value="append">Append effects</option><option value="replace">{busSession ? 'Replace entire stack' : 'Replace entire stack and its keys'}</option>
      </select></label>
      {library.readOnlyReason && <p role="alert">{library.readOnlyReason}</p>}
      {(library.error || error) && <p role="alert">{error ?? library.error}</p>}
      <p role="status">{library.busy ? 'Updating local presets…' : library.message}</p>
      {!busSession && (filter === 'all' || filter === 'builtins') && <div className="inspector-effect-actions" aria-label="Geometry utilities">
        {matches('Reset transform geometry position scale rotation anchor') && <button type="button" onClick={() => {
          const failure = resetEffectGeometry(session, 'transform'); if (failure) setError(failure); else onClose()
        }}>Reset transform</button>}
        {matches('Reset crop flips geometry') && <button type="button" onClick={() => {
          const failure = resetEffectGeometry(session, 'crop-and-flip'); if (failure) setError(failure); else onClose()
        }}>Reset crop and flips</button>}
      </div>}
      <ul className="effect-browser-list" aria-label="Matching effects">
        {(filter === 'all' || filter === 'builtins') && builtins.map((entry) => <li key={entry.effect.type}>
          <strong>{entry.label}</strong><span>Built-in · {entry.surfaces.includes('post-composite') ? 'Clips and composites' : 'Clips only'}</span><p>{entry.description}</p>
          {!busReason([entry.effect]) && effectTemplatePreview([entry.effect], capabilities).map((detail) => <p key={detail}>{detail}</p>)}
          <p>{busReason([entry.effect])}</p>
          <button type="button" disabled={!!busReason([entry.effect])} onClick={() => apply([entry.effect])}>Apply {entry.label}</button>
        </li>)}
        {(filter === 'all' || filter === 'presets') && presets.map((preset) => <li key={preset.id}>
          <strong>{preset.name}</strong><span>Local preset · {preset.effects.length} effects · static values</span>
          <p>{preset.effects.map((effect) => effect.type).join(' → ')}</p>
          {presetEffectAvailability(preset).map((reason) => <p key={reason}>{reason}</p>)}
          {!busReason(preset.effects) && effectTemplatePreview(preset.effects, capabilities).map((detail) => <p key={detail}>{detail}</p>)}
          {!busSession && preset.effects.filter((effect) => effect.type.startsWith('plugin:')).map((effect) => {
            const contribution = plugins?.contributions.find((entry) => entry.effectType === effect.type)
            return <p key={effect.id}>{effect.type}: {contribution ? `${contribution.status}. ${contribution.detail}` : 'Plugin is missing; the effect stays preserved and unavailable.'}</p>
          })}
          <div className="inspector-effect-actions">
            <p>{busReason(preset.effects)}</p>
            <button type="button" disabled={!!busReason(preset.effects)} onClick={() => apply(preset.effects)}>Apply preset {preset.name}</button>
            <button type="button" disabled={!canWrite} onClick={() => setRename({ id: preset.id, name: preset.name })}>Rename {preset.name}</button>
            <button type="button" disabled={!canWrite} onClick={() => { void effectPresetController.edit({ kind: 'delete', id: preset.id }) }}>Delete {preset.name}</button>
          </div>
          {rename?.id === preset.id && <form onSubmit={(event) => { event.preventDefault(); void effectPresetController.edit({ kind: 'rename', id: rename.id, name: rename.name.trim() }).then((ok) => { if (ok) setRename(null) }) }}>
            <label className="text-overlay-dialog-field">New preset name<input value={rename.name} maxLength={80} required onChange={(event) => setRename({ ...rename, name: event.target.value })} /></label>
            <button type="submit" disabled={!canWrite}>Save name</button><button type="button" onClick={() => setRename(null)}>Cancel rename</button>
          </form>}
        </li>)}
        {(filter === 'all' || filter === 'plugins') && contributions.map((entry) => <li key={entry.effectType}>
          <strong>{entry.contributionName}</strong><span>{entry.pluginName} · Installed plugin · {entry.status} · Clips only</span>
          <p>{entry.detail}</p><p>{entry.selectAction.disabledReason}</p>
          {!busSession && session.targetIds.length !== 1 && <p>Select one clip to add a plugin contribution, then copy its stack for batch reuse.</p>}
          <p>{busSession && "Installed plugins currently require a clip source layer and cannot be added to video buses."}</p>
          <button type="button" disabled={!!busSession || !entry.selectAction.available || entry.selectAction.pending || !!entry.selectAction.disabledReason || session.targetIds.length !== 1 || !editor?.coherent || editor.catalogGeneration === null || mode !== 'append'} onClick={() => {
            const state = useDocumentStore.getState()
            const selection = useTransportStore.getState().selectedClipIds
            if (state.project !== session.project || state.projectGeneration !== session.generation || selection.length !== 1 || selection[0] !== session.targetIds[0]) { setError('The project or selection changed. Reopen the effect browser.'); return }
            if (!editor || editor.catalogGeneration === null) return
            const result = pluginUi?.controller.addPluginEffect({ documentGeneration: editor.documentGeneration, catalogGeneration: editor.catalogGeneration, clipId: session.targetIds[0], effectType: entry.effectType })
            if (result?.status === 'rejected') setError(result.detail)
            else if (result) onClose()
          }}>Add plugin {entry.contributionName}</button>
          {mode === 'replace' && <p>Plugin contributions use Append. Saved plugin presets also support Replace.</p>}
        </li>)}
      </ul>
      {(filter === 'all' || filter === 'presets') && library.unavailable.map((entry) => <p key={entry.index}>Unavailable preset {entry.index + 1}: {entry.reason}</p>)}
      {!((filter === 'all' || filter === 'builtins') && builtins.length) && !((filter === 'all' || filter === 'presets') && presets.length) && !((filter === 'all' || filter === 'plugins') && contributions.length) && !(!busSession && (filter === 'all' || filter === 'builtins') && (matches('Reset transform geometry position scale rotation anchor') || matches('Reset crop flips geometry'))) && <p>No matching effects.</p>}
      <footer className="text-overlay-dialog-actions"><button type="button" className="text-overlay-dialog-cancel" onClick={onClose}>Close</button></footer>
    </div>
  </dialog>
}
export default function EffectBrowser({ clipId, busTarget, hasEffects }: { clipId?: string; busTarget?: VideoBusTarget; hasEffects: boolean }) {
  const [mode, setMode] = useState<'browse' | 'save' | null>(null)
  return <>
    <button type="button" onClick={() => setMode('browse')}>Browse effects…</button>
    <button type="button" disabled={!hasEffects} onClick={() => setMode('save')}>Save preset…</button>
    {mode && <BrowserDialog clipId={clipId} busTarget={busTarget} saving={mode === 'save'} onClose={() => setMode(null)} />}
  </>
}
