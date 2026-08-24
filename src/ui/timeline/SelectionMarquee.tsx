import { useTransportStore } from '../../state/transportStore'

export default function SelectionMarquee() {
  const preview = useTransportStore((state) => state.selectionMarquee)
  if (!preview) return null
  return (
    <div
      className="timeline-selection-marquee"
      data-testid="timeline-selection-marquee"
      data-selection-count={preview.clipIds.length}
      aria-hidden="true"
      style={{
        transform: `translate(${preview.left}px, ${preview.top}px)`,
        width: preview.width,
        height: preview.height,
      }}
    />
  )
}
