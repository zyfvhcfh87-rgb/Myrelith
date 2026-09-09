import { useEffect, useRef, useState } from 'react'
import type { CaptionReviewSnapshot } from '../app/captionReviewController'

export default function CaptionReviewPanel({ review, onApply, onCancel }: {
  review: CaptionReviewSnapshot; onApply(acceptLoss: boolean): void; onCancel(): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [acceptedRevision, setAcceptedRevision] = useState<number | null>(null)
  const accepted = acceptedRevision === review.revision
  useEffect(() => { heading.current?.focus() }, [review.revision])
  return <section className="caption-review-panel" aria-labelledby="caption-review-heading" data-caption-review>
    <h3 id="caption-review-heading" tabIndex={-1} ref={heading}>{review.label}</h3>
    <p>{review.changedCueCount} cues in this edit. {review.replacementCount > 0 && `${review.replacementCount} text matches. `}Nothing has been applied.</p>
    {review.lossDisclosure && <p>{review.lossDisclosure}</p>}
    <div className="caption-review-rows">
      {review.preview.map((row, index) => <div className="caption-review-row" key={index}>
        <div><strong>Before</strong>{row.before.map((text, i) => <p key={i}>{text}</p>)}
          {row.omittedBeforeItems > 0 && <p>{row.omittedBeforeItems} more original cues omitted.</p>}</div>
        <div><strong>After</strong>{row.after.map((text, i) => <p key={i}>{text}</p>)}
          {row.omittedAfterItems > 0 && <p>{row.omittedAfterItems} more proposed cues omitted.</p>}</div>
      </div>)}
      {review.omittedPreviewRows > 0 && <p>{review.omittedPreviewRows} more changed rows are included in this edit. The review shows the first 100.</p>}
    </div>
    {review.requiresLossAcceptance && <label className="caption-checkbox">
      <input type="checkbox" checked={accepted} onChange={event => setAcceptedRevision(event.target.checked ? review.revision : null)} />
      I accept the disclosed caption losses
    </label>}
    <div className="caption-review-actions">
      <button type="button" onClick={onCancel}>Cancel review</button>
      <button type="button" disabled={review.requiresLossAcceptance && !accepted} onClick={() => onApply(accepted)}>Apply caption edit</button>
    </div>
  </section>
}
