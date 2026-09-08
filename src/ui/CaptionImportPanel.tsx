import { useEffect, useRef, useState } from 'react'
import type { CaptionImportSnapshot } from '../app/captionImportController'
import type { TextFontFamily } from '../domain/schema'
import { TEXT_FONT_FAMILIES } from '../domain/textOverlay'
import CaptionReviewPanel from './CaptionReviewPanel'

export default function CaptionImportPanel({ snapshot, onCancel, onFonts, onApply }: {
  snapshot: CaptionImportSnapshot; onCancel(): void;
  onFonts(substitutions: Readonly<Record<string, TextFontFamily>>): void; onApply(accepted: boolean): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [fonts, setFonts] = useState<Record<string, TextFontFamily | ''>>({})
  useEffect(() => { if (!snapshot.review) heading.current?.focus() }, [snapshot.revision, snapshot.review])
  const ready = snapshot.fonts.every(font => !!fonts[font])
  return <section className="caption-import-panel" data-caption-review>
    {!snapshot.review && <h3 id="caption-import-heading" tabIndex={-1} ref={heading}>Caption import</h3>}
    <p>{snapshot.message}</p>
    {snapshot.diagnostics.length > 0 && <ul className="caption-import-diagnostics" aria-label="Import conversion details">
      {snapshot.diagnostics.map((detail, index) => <li key={index}>{detail}</li>)}
    </ul>}
    {snapshot.omittedDiagnostics > 0 && <p>{snapshot.omittedDiagnostics} additional conversion details omitted from this bounded report.</p>}
    {snapshot.phase === 'fonts' && <>
      <p>ASS imports create a new track. Font substitutions can change appearance and will be included in the loss review.</p>
      <div className="caption-import-fonts">{snapshot.fonts.map(font => <label key={font}>
        Replace “{font}”<select value={fonts[font] ?? ''} onChange={event => {
          const value = TEXT_FONT_FAMILIES.find(choice => choice === event.target.value) ?? ''
          setFonts(previous => ({ ...previous, [font]: value }))
        }}><option value="">Choose a local font</option>{TEXT_FONT_FAMILIES.map(choice => <option key={choice}>{choice}</option>)}</select>
      </label>)}</div>
      <button type="button" disabled={!ready} onClick={() => {
        const choices = Object.fromEntries(snapshot.fonts.map(font => [font, fonts[font]!]))
        if (Object.values(choices).every(value => value !== '')) onFonts(choices as Record<string, TextFontFamily>)
      }}>Review font substitutions</button>
    </>}
    {snapshot.review ? <CaptionReviewPanel review={snapshot.review} onCancel={onCancel} onApply={onApply} />
      : <button type="button" onClick={onCancel}>Cancel import</button>}
  </section>
}
