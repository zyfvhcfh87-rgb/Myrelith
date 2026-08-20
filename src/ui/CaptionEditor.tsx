import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import { captionFileController } from '../app/captionFileController'
import { CAPTION_STYLE_PRESETS, CAPTION_TRACK_ROLES, createCaptionTrack } from '../domain/captions'
import type { CaptionItem, CaptionItemId, CaptionTrackId } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

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
  const playhead = useTransportStore((state) => state.playheadFrame)
  const setPlayhead = useTransportStore((state) => state.setPlayheadFrame)
  const [trackId, setTrackId] = useState<CaptionTrackId | null>(doc.captionTracks?.[0]?.id ?? null)
  const [itemId, setItemId] = useState<CaptionItemId | null>(doc.captionTracks?.[0]?.items[0]?.id ?? null)
  const [trackNameDraft, setTrackNameDraft] = useState('')
  const [trackLanguageDraft, setTrackLanguageDraft] = useState('und')
  const [draftText, setDraftText] = useState('')
  const [draftStart, setDraftStart] = useState('0')
  const [draftEnd, setDraftEnd] = useState('1')
  const [shiftFrames, setShiftFrames] = useState('1')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Caption editor ready.')
  const tracks = useMemo(() => doc.captionTracks ?? [], [doc.captionTracks])
  const track = tracks.find((candidate) => candidate.id === trackId) ?? null
  const selectedIndex = track?.items.findIndex((item) => item.id === itemId) ?? -1
  const item = selectedIndex >= 0 ? track?.items[selectedIndex] ?? null : null

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    if (trackId && tracks.some((candidate) => candidate.id === trackId)) return
    const nextTrack = tracks[0] ?? null
    setTrackId(nextTrack?.id ?? null)
    setItemId(nextTrack?.items[0]?.id ?? null)
  }, [trackId, tracks])

  useEffect(() => {
    if (!track) return
    if (itemId && track.items.some((candidate) => candidate.id === itemId)) return
    setItemId(track.items[0]?.id ?? null)
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

  const selectItem = (next: CaptionItem | null): void => {
    setItemId(next?.id ?? null)
    if (next) setPlayhead(next.range.startFrame)
  }

  const moveSelection = (direction: -1 | 1 | 'first' | 'last'): void => {
    if (!track || track.items.length === 0) return
    const nextIndex = direction === 'first'
      ? 0
      : direction === 'last'
        ? track.items.length - 1
        : Math.max(0, Math.min(track.items.length - 1, selectedIndex + direction))
    selectItem(track.items[nextIndex] ?? null)
  }

  const onCueListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const direction = event.key === 'ArrowUp'
      ? -1
      : event.key === 'ArrowDown'
        ? 1
        : event.key === 'Home'
          ? 'first'
          : event.key === 'End'
            ? 'last'
            : null
    if (direction === null) return
    event.preventDefault()
    moveSelection(direction)
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
    })
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const lower = file.name.toLowerCase()
    const format = lower.endsWith('.vtt') ? 'vtt' : lower.endsWith('.srt') ? 'srt' : null
    if (!format) {
      setStatus('Choose an .srt or .vtt caption file.')
      return
    }
    setBusy(true)
    try {
      if (track) {
        const count = await captionFileController.importIntoTrack(file, format, track.id)
        setItemId(useDocumentStore.getState().doc.captionTracks
          ?.find((candidate) => candidate.id === track.id)?.items[0]?.id ?? null)
        setStatus(`Imported ${count} captions into ${track.name}.`)
      } else {
        const importedTrackId = await captionFileController.importAsTrack(file, format, {
          name: file.name.replace(/\.(?:srt|vtt)$/iu, ''),
          language: 'und',
          role: 'captions',
          stylePreset: 'classic',
        })
        setTrackId(importedTrackId)
        setStatus('Imported captions into a new track.')
      }
    } catch (error) {
      setStatus(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keep modal-owned keys from reaching window edit/history/palette shortcuts.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="caption-editor-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        ref={dialogRef}
        className="caption-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="caption-editor-title"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <header className="caption-editor-header">
          <div>
            <p className="caption-editor-kicker">Semantic captions</p>
            <h2 id="caption-editor-title">Caption editor</h2>
          </div>
          <button type="button" aria-label="Close caption editor" onClick={onClose}>×</button>
        </header>

        <div className="caption-track-bar">
          <label>
            Track
            <select value={trackId ?? ''} onChange={(event) => {
              setTrackId(event.target.value || null)
              setItemId(null)
            }}>
              {tracks.length === 0 && <option value="">No caption tracks</option>}
              {tracks.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={addTrack}>Add track</button>
          <label className="caption-import-button">
            Import SRT/VTT
            <input
              type="file"
              accept=".srt,.vtt,text/vtt,application/x-subrip"
              disabled={busy}
              onChange={(event) => void importFile(event)}
            />
          </label>
          <button
            type="button"
            disabled={!track || track.items.length === 0}
            onClick={() => track && run('SRT downloaded.', () => {
              captionFileController.exportTrack(track.id, 'srt')
            })}
          >Export SRT</button>
          <button
            type="button"
            disabled={!track || track.items.length === 0}
            onClick={() => track && run('WebVTT downloaded.', () => {
              captionFileController.exportTrack(track.id, 'vtt')
            })}
          >Export VTT</button>
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
                  aria-selected={candidate.id === itemId}
                  onClick={() => selectItem(candidate)}
                >
                  {formatCue(candidate)}
                </button>
              ))}
            </div>
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
              <textarea rows={5} value={draftText} disabled={!item} onChange={(event) => setDraftText(event.target.value)} />
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
                  setItemId(rightId)
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

            <fieldset className="caption-shift-controls">
              <legend>Batch timing</legend>
              <label>
                Shift frames
                <input type="number" step="1" value={shiftFrames} onChange={(event) => setShiftFrames(event.target.value)} />
              </label>
              <button type="button" disabled={!track || track.items.length === 0} onClick={() => {
                if (!track) return
                run('Shifted every caption in the track.', () => useDocumentStore.getState().shiftCaptionItems(
                  track.id,
                  null,
                  Number(shiftFrames),
                ))
              }}>Shift all</button>
              <button type="button" disabled={!track || !item} onClick={() => {
                if (!track || !item) return
                run('Shifted the selected caption and everything after it.', () => useDocumentStore.getState().shiftCaptionItems(
                  track.id,
                  item.id,
                  Number(shiftFrames),
                ))
              }}>Shift from selected</button>
            </fieldset>
          </section>
        </div>

        <footer className="caption-editor-footer">
          <p role="status" aria-live="polite" aria-atomic="true">{status}</p>
          <span>Frame {playhead} · half-open ranges · plain text only</span>
        </footer>
      </div>
    </div>
  )
}
