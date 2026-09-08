import { useEffect, useRef, useState } from 'react'
import type { CaptionExportSnapshot } from '../app/captionExportController'

export default function CaptionExportPanel({ snapshot, onCancel, onDownload }: {
  snapshot: CaptionExportSnapshot; onCancel(): void; onDownload(accepted: boolean): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [accepted, setAccepted] = useState(false)
  useEffect(() => { heading.current?.focus() }, [snapshot.revision])
  return <section className="caption-review-panel" data-caption-review>
    <h3 id="caption-export-heading" ref={heading} tabIndex={-1}>Review caption download</h3>
    {snapshot.error ? <p role="alert">{snapshot.error}</p> : <>
      <p>{snapshot.fileName} · {snapshot.cueCount} cues. Nothing has been downloaded.</p>
      <ul className="caption-import-diagnostics">{snapshot.diagnostics.map((detail, index) => <li key={index}>{detail}</li>)}</ul>
      {snapshot.omittedDiagnostics > 0 && <p>{snapshot.omittedDiagnostics} additional conversion details omitted from this bounded report.</p>}
      <label className="caption-checkbox"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
        I accept the disclosed download losses
      </label>
    </>}
    <div className="caption-review-actions">
      <button type="button" onClick={onCancel}>Cancel download</button>
      {snapshot.phase === 'review' && <button type="button" disabled={!accepted} onClick={() => onDownload(accepted)}>Download caption file</button>}
    </div>
  </section>
}
