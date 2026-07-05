/**
 * ui/TransportBar.tsx — frame-step + play/pause controls, in the slim row
 * between the Preview and the Timeline. Phase 4.0.5.
 *
 * Subscribes ONLY to isPlaying (icon swap on play/pause — rare); the
 * playhead itself is read inside the controller on demand, so playback
 * and scrubbing still re-render Playhead + Preview only (invariant 6).
 * All behavior lives in app/transportController — this component is the
 * dumb facade caller ARCHITECTURE.md sanctions.
 */

import { useTransportStore } from '../state/transportStore'
import { stepFrame, togglePlayback } from '../app/transportController'

export default function TransportBar() {
  const isPlaying = useTransportStore((s) => s.isPlaying)

  return (
    <div className="transport-bar" data-testid="transport-bar">
      <button
        className="transport-button"
        aria-label="one frame back"
        title="one frame back"
        onClick={() => stepFrame(-1)}
      >
        ◁
      </button>
      <button
        className="transport-button transport-play"
        aria-label={isPlaying ? 'pause' : 'play'}
        title={isPlaying ? 'pause' : 'play'}
        onClick={togglePlayback}
      >
        {isPlaying ? '❚❚' : '▶'}
      </button>
      <button
        className="transport-button"
        aria-label="one frame forward"
        title="one frame forward"
        onClick={() => stepFrame(1)}
      >
        ▷
      </button>
    </div>
  )
}
