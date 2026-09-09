import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import type { CaptionDownloadFormat } from '../app/captionFileController'
import { CaptionReviewController } from '../app/captionReviewController'
import { CaptionImportController } from '../app/captionImportController'
import { CaptionExportController } from '../app/captionExportController'
import { inspectSavedCaptionAppearance } from '../app/captionAppearance'
import { captionReadingSpeed } from '../domain/captionBatch'
import CaptionReviewPanel from './CaptionReviewPanel'
import CaptionBatchTools from './CaptionBatchTools'
import CaptionStyleTools from './CaptionStyleTools'
import CaptionImportPanel from './CaptionImportPanel'
import CaptionExportPanel from './CaptionExportPanel'
import { CAPTION_STYLE_PRESETS, CAPTION_TRACK_ROLES, createCaptionTrack } from '../domain/captions'
import type { CaptionItem, CaptionItemId, CaptionTrackId } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

const CaptionTranscriptionPanel = lazy(() => import('./CaptionTranscriptionPanel'))
const MAX_RENDERED_CUES = 200
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface CaptionEditorProps {
  onClose(): void
}

function id(prefix: 'caption_track' | 'caption_item'): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function formatCue(item: CaptionItem): string {
  const end = item.range.startFrame + item.range.durationFrames
  const singleLine = item.text.replace(/\s+/gu, ' ')
  return `${item.range.startFrame}–${end} · ${singleLine}`
}

export default function CaptionEditor({ onClose }: CaptionEditorProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const doc = useDocumentStore((state) => state.doc)
  const documentScope = useDocumentStore(state => `${state.projectGeneration}:${state.activeSequenceId}`)
  const controller = useMemo(() => new CaptionReviewController(), [])
  const review = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const importer = useMemo(() => new CaptionImportController(), [])
  const imported = useSyncExternalStore(importer.subscribe, importer.getSnapshot, importer.getSnapshot)
  const exporter = useMemo(() => new CaptionExportController(), [])
  const exported = useSyncExternalStore(exporter.subscribe, exporter.getSnapshot, exporter.getSnapshot)
  const [speechOpen, setSpeechOpen] = useState(false)
  const reviewing = speechOpen || review.label !== null || imported.phase !== 'idle' || exported.phase !== 'idle'
  const returnFocus = useRef<HTMLElement | null>(null)
  const wasReviewing = useRef(false)
  const selectionAnchor = useRef<string | null>(null)
  const playhead = useTransportStore((state) => state.playheadFrame)
  const setPlayhead = useTransportStore((state) => state.setPlayheadFrame)
  const [trackId, setTrackId] = useState<CaptionTrackId | null>(doc.captionTracks?.[0]?.id ?? null)
  const [itemId, setItemId] = useState<CaptionItemId | null>(doc.captionTracks?.[0]?.items[0]?.id ?? null)
  const [trackNameDraft, setTrackNameDraft] = useState('')
  const [trackLanguageDraft, setTrackLanguageDraft] = useState('und')
  const [draftText, setDraftText] = useState('')
  const [draftStart, setDraftStart] = useState('0')
  const [draftEnd, setDraftEnd] = useState('1')
  const [selection, setSelection] = useState<{ trackId: string | null; ids: string[] }>({ trackId: doc.captionTracks?.[0]?.id ?? null, ids: doc.captionTracks?.[0]?.items[0] ? [doc.captionTracks[0].items[0].id] : [] })
  const [readingAdvisory, setReadingAdvisory] = useState('17')
  const [status, setStatus] = useState('Caption editor ready.')
  const [appearance, setAppearance] = useState<readonly string[]>([])
  const tracks = useMemo(() => doc.captionTracks ?? [], [doc.captionTracks])
  const track = tracks.find((candidate) => candidate.id === trackId) ?? null
  const selectedIndex = track?.items.findIndex((item) => item.id === itemId) ?? -1
  const item = selectedIndex >= 0 ? track?.items[selectedIndex] ?? null : null
  const currentIds = useMemo(() => new Set(track?.items.map(cue => cue.id) ?? []), [track])
  const selectedIds = selection.trackId === track?.id ? selection.ids.filter(cueId => currentIds.has(cueId)) : []
  const selectedSet = new Set(selectedIds)
  const reading = item && Number(readingAdvisory) > 0 && Number.isFinite(Number(readingAdvisory))
    ? captionReadingSpeed(item, doc.frameRate, Number(readingAdvisory)) : null

  useEffect(() => { setAppearance([]) }, [doc, trackId, itemId])

  useEffect(() => {
    const first = useDocumentStore.getState().doc.captionTracks?.[0]
    setTrackId(first?.id ?? null); setItemId(first?.items[0]?.id ?? null)
    setSelection({ trackId: first?.id ?? null, ids: first?.items[0] ? [first.items[0].id] : [] })
    selectionAnchor.current = first?.items[0]?.id ?? null
  }, [documentScope])
  useEffect(() => {
    if (wasReviewing.current && !reviewing) returnFocus.current?.focus()
    wasReviewing.current = reviewing
  }, [reviewing])
  const closeEditor = (): void => { controller.cancel(); importer.cancel(); exporter.cancel(); onClose() }
  const beginReview = (action: () => boolean): void => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    try { setStatus(action() ? 'Review ready. Nothing has been applied.' : 'No captions would change.') }
    catch (error) { setStatus(errorMessage(error)) }
  }
  const cancelReview = (): void => { controller.cancel(); setStatus('Caption review cancelled.') }
  const cancelImport = (): void => { importer.cancel(); setStatus('Caption import cancelled.') }
  const cancelExport = (): void => { exporter.cancel(); setStatus('Caption download cancelled.') }
  const exportFile = (format: CaptionDownloadFormat, button: HTMLButtonElement): void => {
    if (!track) return
    returnFocus.current = button
    controller.cancel(); importer.cancel()
    exporter.begin(track.id, format)
  }


  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    if (trackId && tracks.some((candidate) => candidate.id === trackId)) return
    const nextTrack = tracks[0] ?? null
    setTrackId(nextTrack?.id ?? null)
    setItemId(nextTrack?.items[0]?.id ?? null)
    setSelection({ trackId: nextTrack?.id ?? null, ids: nextTrack?.items[0] ? [nextTrack.items[0].id] : [] })
    selectionAnchor.current = nextTrack?.items[0]?.id ?? null
  }, [trackId, tracks])

  useEffect(() => {
    if (!track) return
    if (itemId && track.items.some((candidate) => candidate.id === itemId)) return
    setItemId(track.items[0]?.id ?? null)
    setSelection({ trackId: track.id, ids: track.items[0] ? [track.items[0].id] : [] })
    selectionAnchor.current = track.items[0]?.id ?? null
  }, [itemId, track])

  useEffect(() => {
    setTrackNameDraft(track?.name ?? '')
    setTrackLanguageDraft(track?.language ?? 'und')
  }, [track?.id, track?.language, track?.name])

  useEffect(() => {
    if (!item) {
      setDraftText('')
      setDraftStart('0')
      setDraftEnd('1')
      return
    }
    setDraftText(item.text)
    setDraftStart(String(item.range.startFrame))
    setDraftEnd(String(item.range.startFrame + item.range.durationFrames))
  }, [item])

  const windowedItems = useMemo(() => {
    if (!track) return []
    const anchor = Math.max(0, selectedIndex)
    const start = Math.max(0, Math.min(
      anchor - Math.floor(MAX_RENDERED_CUES / 2),
      track.items.length - MAX_RENDERED_CUES,
    ))
    return track.items.slice(start, start + MAX_RENDERED_CUES)
  }, [selectedIndex, track])

  const run = (success: string, action: () => void): void => {
    try {
      action()
      setStatus(success)
    } catch (error) {
      setStatus(errorMessage(error))
    }
  }

  const selectItem = (next: CaptionItem | null, mode: 'single' | 'extend' | 'toggle' | 'focus' = 'single'): void => {
    controller.cancel()
    if (!track || !next) { setItemId(null); setSelection({ trackId: track?.id ?? null, ids: [] }); return }
    if (mode === 'extend') {
      const anchor = track.items.findIndex(cue => cue.id === (selectionAnchor.current ?? itemId))
      const index = track.items.indexOf(next)
      const from = anchor < 0 ? index : anchor
      setSelection({ trackId: track.id, ids: track.items.slice(Math.min(from, index), Math.max(from, index) + 1).map(cue => cue.id) })
    } else if (mode === 'toggle') {
      const nextIds = new Set(selectedIds)
      if (nextIds.has(next.id)) nextIds.delete(next.id); else nextIds.add(next.id)
      setSelection({ trackId: track.id, ids: [...nextIds] }); selectionAnchor.current = next.id
    } else if (mode === 'single') {
      setSelection({ trackId: track.id, ids: [next.id] }); selectionAnchor.current = next.id
    }
    setItemId(next.id); setPlayhead(next.range.startFrame)
  }

  const moveSelection = (direction: -1 | 1 | 'first' | 'last', mode: 'single' | 'extend' | 'focus' = 'single'): void => {
    if (!track || track.items.length === 0) return
    const nextIndex = direction === 'first' ? 0 : direction === 'last' ? track.items.length - 1
      : Math.max(0, Math.min(track.items.length - 1, selectedIndex + direction))
    selectItem(track.items[nextIndex] ?? null, mode)
  }
  const onCueListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); controller.cancel()
      if (track) setSelection({ trackId: track.id, ids: track.items.map(cue => cue.id) })
      return
    }
    if (event.key === ' ') { event.preventDefault(); selectItem(item, 'toggle'); return }
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1
      : event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : null
    if (direction === null) return
    event.preventDefault()
    moveSelection(direction, event.shiftKey ? 'extend' : event.ctrlKey || event.metaKey ? 'focus' : 'single')
  }

  const saveCue = (): void => {
    if (!track || !item) return
    const start = Number(draftStart)
    const end = Number(draftEnd)
    run('Caption saved.', () => useDocumentStore.getState().updateCaptionItem(
      track.id,
      item.id,
      { range: { startFrame: start, durationFrames: end - start }, text: draftText },
    ))
  }

  const commitTrackName = (): void => {
    if (!track) return
    const next = trackNameDraft.trim()
    if (next === track.name) {
      setTrackNameDraft(next)
      return
    }
    run('Track name updated.', () => {
      useDocumentStore.getState().updateCaptionTrack(track.id, { name: next })
    })
  }

  const commitTrackLanguage = (): void => {
    if (!track) return
    const next = trackLanguageDraft.trim()
    if (next === track.language) {
      setTrackLanguageDraft(next)
      return
    }
    run('Track language updated.', () => {
      useDocumentStore.getState().updateCaptionTrack(track.id, { language: next })
    })
  }

  const addCue = (): void => {
    if (!track) return
    const duration = Math.max(1, Math.round(doc.frameRate.num / doc.frameRate.den) * 2)
    const next: CaptionItem = {
      id: id('caption_item'),
      range: { startFrame: playhead, durationFrames: duration },
      text: 'New caption',
    }
    run('Caption added at the playhead.', () => {
      useDocumentStore.getState().addCaptionItem(track.id, next)
      selectItem(next)
    })
  }

  const addTrack = (): void => {
    const nextId = id('caption_track')
    const next = createCaptionTrack(nextId, `Captions ${tracks.length + 1}`)
    run('Caption track added.', () => {
      useDocumentStore.getState().addCaptionTrack(next)
      setTrackId(nextId)
      setItemId(null)
      setSelection({ trackId: nextId, ids: [] })
      selectionAnchor.current = null
    })
  }

  const importFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const lower = file.name.toLowerCase()
    const format = lower.endsWith('.vtt') ? 'vtt' : lower.endsWith('.srt') ? 'srt' : lower.endsWith('.ass') ? 'ass' : null
    if (!format) {
      setStatus('Choose an .srt, .vtt or .ass caption file.')
      return
    }
    returnFocus.current = event.currentTarget
    controller.cancel(); exporter.cancel()
    void importer.begin(file, format, track?.id ?? null, {
      name: file.name.replace(/\.(?:srt|vtt|ass)$/iu, '').slice(0, 128) || 'Imported captions',
      language: 'und', role: 'captions', stylePreset: 'classic',
    }).catch(error => setStatus(errorMessage(error)))
  }

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keep modal-owned keys from reaching window edit/history/palette shortcuts.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      if (speechOpen) setSpeechOpen(false)
      else if (exported.phase !== 'idle') cancelExport()
      else if (imported.phase !== 'idle') cancelImport()
      else if (review.label !== null) cancelReview(); else closeEditor()
      return
    }
    if (event.key !== 'Tab') return
    const focusScope = reviewing ? dialogRef.current?.querySelector('[data-caption-review]') : dialogRef.current
    const focusable = Array.from(focusScope?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && (document.activeElement === first || ['caption-review-heading', 'caption-import-heading', 'caption-export-heading', 'caption-speech-heading'].includes(document.activeElement?.id ?? ''))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="caption-editor-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeEditor()
    }}>
      <div
        ref={dialogRef}
        className="caption-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={speechOpen ? 'caption-speech-heading' : exported.phase !== 'idle' ? 'caption-export-heading' : review.label !== null || imported.review ? 'caption-review-heading' : imported.phase !== 'idle' ? 'caption-import-heading' : 'caption-editor-title'}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div inert={reviewing}>
        <header className="caption-editor-header">
          <div>
            <p className="caption-editor-kicker">Semantic captions</p>
            <h2 id="caption-editor-title">Caption editor</h2>
          </div>
          <button type="button" aria-label="Close caption editor" onClick={closeEditor}>×</button>
        </header>

        <div className="caption-track-bar">
          <label>
            Track
            <select value={trackId ?? ''} onChange={(event) => {
              controller.cancel()
              const next = tracks.find(candidate => candidate.id === event.target.value)
              setTrackId(next?.id ?? null); setItemId(next?.items[0]?.id ?? null)
              setSelection({ trackId: next?.id ?? null, ids: next?.items[0] ? [next.items[0].id] : [] })
              selectionAnchor.current = next?.items[0]?.id ?? null
            }}>
              {tracks.length === 0 && <option value="">No caption tracks</option>}
              {tracks.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={addTrack}>Add track</button>
          <button type="button" onClick={event => { returnFocus.current = event.currentTarget; setSpeechOpen(true) }}>Transcribe local audio</button>
          <label className="caption-import-button">
            Import SRT/VTT/ASS
            <input
              type="file"
              accept=".srt,.vtt,.ass,text/vtt,application/x-subrip"
              onChange={importFile}
            />
          </label>
          {(['srt', 'vtt', 'ass'] as const).map(format => <button key={format} type="button"
            disabled={!track?.items.length} onClick={event => exportFile(format, event.currentTarget)}>Export {format.toUpperCase()}</button>)}
        </div>

        {track && (
          <fieldset className="caption-track-settings">
            <legend>Track settings</legend>
            <label>
              Name
              <input
                value={trackNameDraft}
                onChange={(event) => setTrackNameDraft(event.target.value)}
                onBlur={commitTrackName}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  event.currentTarget.blur()
                }}
              />
            </label>
            <label>
              Language
              <input
                value={trackLanguageDraft}
                aria-describedby="caption-language-help"
                onChange={(event) => setTrackLanguageDraft(event.target.value)}
                onBlur={commitTrackLanguage}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  event.currentTarget.blur()
                }}
              />
            </label>
            <span id="caption-language-help" className="visually-hidden">Use a BCP-47 tag such as en, en-US, or und.</span>
            <label>
              Role
              <select value={track.role} onChange={(event) => run('Track role updated.', () => {
                useDocumentStore.getState().updateCaptionTrack(track.id, {
                  role: event.target.value as typeof track.role,
                })
              })}>
                {CAPTION_TRACK_ROLES.map((role) => <option key={role}>{role}</option>)}
              </select>
            </label>
            <label>
              Style
              <select value={track.stylePreset} onChange={(event) => run('Track style updated.', () => {
                useDocumentStore.getState().updateCaptionTrack(track.id, {
                  stylePreset: event.target.value as typeof track.stylePreset,
                })
              })}>
                {CAPTION_STYLE_PRESETS.map((preset) => <option key={preset}>{preset}</option>)}
              </select>
            </label>
            <label className="caption-checkbox">
              <input type="checkbox" checked={track.hidden} onChange={(event) => run(
                event.target.checked ? 'Caption track hidden.' : 'Caption track visible.',
                () => useDocumentStore.getState().updateCaptionTrack(track.id, { hidden: event.target.checked }),
              )} />
              Hidden
            </label>
            <button type="button" className="caption-danger" onClick={() => {
              if (!window.confirm(`Delete ${track.name} and all its captions?`)) return
              run('Caption track deleted.', () => useDocumentStore.getState().deleteCaptionTrack(track.id))
            }}>Delete track</button>
          </fieldset>
        )}

        <div className="caption-editor-body">
          <section className="caption-cue-panel" aria-labelledby="caption-cues-heading">
            <div className="caption-section-heading">
              <h3 id="caption-cues-heading">Cues</h3>
              <span>{track?.items.length ?? 0} total · {windowedItems.length} rendered</span>
            </div>
            <div
              className="caption-cue-list"
              role="listbox"
              aria-label="Caption cues"
              aria-multiselectable="true"
              aria-describedby="caption-selection-help"
              aria-activedescendant={itemId ? `caption-option-${itemId}` : undefined}
              tabIndex={0}
              onKeyDown={onCueListKeyDown}
            >
              {windowedItems.length === 0 && <p>No cues yet. Add one at the playhead or import a file.</p>}
              {windowedItems.map((candidate) => (
                <button
                  id={`caption-option-${candidate.id}`}
                  key={candidate.id}
                  type="button"
                  role="option"
                  aria-selected={selectedSet.has(candidate.id)}
                  data-active={candidate.id === itemId || undefined}
                  tabIndex={-1}
                  onClick={event => {
                    selectItem(candidate, event.shiftKey ? 'extend' : event.ctrlKey || event.metaKey ? 'toggle' : 'single')
                    event.currentTarget.parentElement?.focus()
                  }}
                >
                  {formatCue(candidate)}
                </button>
              ))}
            </div>
            <p id="caption-selection-help">{selectedIds.length} selected. Shift + arrows extends the selection; Space toggles a cue; Ctrl/⌘ + A selects all.</p>
            <div className="caption-row-actions">
              <button type="button" onClick={addCue} disabled={!track}>Add at playhead</button>
              <button type="button" onClick={() => moveSelection(-1)} disabled={selectedIndex <= 0}>Previous</button>
              <button type="button" onClick={() => moveSelection(1)} disabled={!track || selectedIndex < 0 || selectedIndex >= track.items.length - 1}>Next</button>
            </div>
          </section>

          <section className="caption-cue-form" aria-labelledby="caption-edit-heading">
            <h3 id="caption-edit-heading">Edit cue</h3>
            <label>
              Text
              <textarea spellCheck={false} rows={5} value={draftText} disabled={!item} onChange={(event) => setDraftText(event.target.value)} />
            </label>
            <div className="caption-timing-grid">
              <label>
                Start frame
                <input type="number" min="0" step="1" value={draftStart} disabled={!item} onChange={(event) => setDraftStart(event.target.value)} />
              </label>
              <label>
                End frame (exclusive)
                <input type="number" min="1" step="1" value={draftEnd} disabled={!item} onChange={(event) => setDraftEnd(event.target.value)} />
              </label>
            </div>
            <div className="caption-row-actions">
              <button type="button" disabled={!item} onClick={saveCue}>Save cue</button>
              <button type="button" disabled={!item || playhead <= (item?.range.startFrame ?? 0) || playhead >= ((item?.range.startFrame ?? 0) + (item?.range.durationFrames ?? 0))} onClick={() => {
                if (!track || !item) return
                const rightId = id('caption_item')
                run('Caption split at the playhead.', () => {
                  useDocumentStore.getState().splitCaptionItem(track.id, item.id, playhead, rightId)
                  const right = useDocumentStore.getState().doc.captionTracks?.find(candidate => candidate.id === track.id)
                    ?.items.find(candidate => candidate.id === rightId)
                  selectItem(right ?? null)
                })
              }}>Split at playhead</button>
              <button type="button" disabled={!track || selectedIndex < 0 || selectedIndex >= track.items.length - 1} onClick={() => {
                if (!track || !item) return
                run('Touching captions merged.', () => useDocumentStore.getState().mergeCaptionWithNext(track.id, item.id))
              }}>Merge next</button>
              <button type="button" className="caption-danger" disabled={!item} onClick={() => {
                if (!track || !item) return
                run('Caption deleted.', () => useDocumentStore.getState().deleteCaptionItem(track.id, item.id))
              }}>Delete cue</button>
            </div>

            <div className="caption-reading-advisory">
              <label>Reading speed advisory (characters/second)<input type="number" min="1" step="1" value={readingAdvisory} onChange={event => setReadingAdvisory(event.target.value)} /></label>
              {reading && <p>Saved cue: {reading.characters} characters · {reading.charactersPerSecond.toFixed(1)} characters/second{reading.aboveAdvisory ? ' · Above advisory' : ''}</p>}
              <p>Counts Unicode characters and spaces, excluding line breaks. This is an advisory, not a guarantee of readability. Local spellcheck and translation are unavailable without reviewed language packs.</p>
              <button type="button" disabled={!track || !item} onClick={() => {
                if (track && item) setAppearance(inspectSavedCaptionAppearance(track.id, item.id))
              }}>Check saved cue appearance</button>
              {appearance.length > 0 && <ul aria-label="Caption appearance advisories">{appearance.map((message, index) => <li key={index}>{message}</li>)}</ul>}
            </div>
            {track && <>
              <CaptionBatchTools key={`batch-${track.id}`} trackId={track.id} total={track.items.length} selectedIds={selectedIds} activeId={itemId} controller={controller} onReview={beginReview} />
              <CaptionStyleTools key={`style-${track.id}`} track={track} selectedIds={selectedIds} controller={controller} onReview={beginReview} />
            </>}
          </section>
        </div>

        </div>
        {review.label !== null && <CaptionReviewPanel review={review} onCancel={cancelReview} onApply={accepted => {
          const error = controller.apply(review.revision, accepted)
          setStatus(error ?? 'Caption edit applied. Undo restores the previous captions.')
        }} />}
        {imported.phase !== 'idle' && <CaptionImportPanel key={imported.revision} snapshot={imported} onCancel={cancelImport}
          onFonts={fonts => importer.chooseFonts(imported.revision, fonts)} onApply={accepted => {
            const result = importer.apply(imported.revision, accepted)
            if (result.error) { setStatus(result.error); return }
            const next = useDocumentStore.getState().doc.captionTracks?.find(candidate => candidate.id === result.trackId)
            setTrackId(next?.id ?? null); setItemId(next?.items[0]?.id ?? null)
            setSelection({ trackId: next?.id ?? null, ids: next?.items[0] ? [next.items[0].id] : [] })
            selectionAnchor.current = next?.items[0]?.id ?? null
            setStatus('Caption import applied. Undo restores the previous captions.')
          }} />}
        {exported.phase !== 'idle' && <CaptionExportPanel key={exported.revision} snapshot={exported} onCancel={cancelExport}
          onDownload={accepted => setStatus(exporter.download(exported.revision, accepted) ?? 'Caption file downloaded. The project is unchanged.')} />}
        <footer className="caption-editor-footer">
          <p role="status" aria-live="polite" aria-atomic="true">{status}</p>
          <span>Frame {playhead} · half-open ranges · plain text only</span>
        </footer>
        {speechOpen && <Suspense fallback={<section data-caption-review><h3 id="caption-speech-heading">Loading transcription tools…</h3><button type="button" onClick={() => setSpeechOpen(false)}>Close transcription</button></section>}>
          <CaptionTranscriptionPanel onClose={() => setSpeechOpen(false)} />
        </Suspense>}
      </div>
    </div>
  )
}
