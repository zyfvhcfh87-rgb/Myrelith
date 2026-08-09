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

import { CaretLeft, CaretRight, Pause, Play } from '@phosphor-icons/react'
import { useTransportStore } from '../state/transportStore'
import { stepFrame, togglePlayback } from '../app/transportController'
import { shortcutForCommand } from '../app/editorCommands'

export default function TransportBar() {
  const isPlaying = useTransportStore((s) => s.isPlaying)
  const previousShortcut = shortcutForCommand('transport.previous-frame')!
  const nextShortcut = shortcutForCommand('transport.next-frame')!

  return (
    <div className="transport-bar" data-testid="transport-bar">
      <button
        className="transport-button"
        aria-label="one frame back"
        aria-keyshortcuts={previousShortcut.ariaKeyShortcuts}
        title={`one frame back (${previousShortcut.label})`}
        onClick={() => stepFrame(-1)}
      >
        <CaretLeft aria-hidden="true" size={16} weight="fill" />
      </button>
      <button
        className="transport-button transport-play"
        aria-label={isPlaying ? 'pause' : 'play'}
        title={isPlaying ? 'pause' : 'play'}
        onClick={togglePlayback}
      >
        {isPlaying
          ? <Pause aria-hidden="true" size={16} weight="fill" />
          : <Play aria-hidden="true" size={16} weight="fill" />}
      </button>
      <button
        className="transport-button"
        aria-label="one frame forward"
        aria-keyshortcuts={nextShortcut.ariaKeyShortcuts}
        title={`one frame forward (${nextShortcut.label})`}
        onClick={() => stepFrame(1)}
      >
        <CaretRight aria-hidden="true" size={16} weight="fill" />
      </button>
    </div>
  )
}
