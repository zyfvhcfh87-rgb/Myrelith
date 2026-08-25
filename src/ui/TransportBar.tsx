/**
 * ui/TransportBar.tsx — frame-step + play/pause controls, in the slim row
 * between the Preview and the Timeline. Phase 4.0.5.
 *
 * Subscribes to isPlaying and rare sequence-edit eligibility (marks/targets),
 * never to the playhead, so playback still re-renders Playhead + Preview only
 * (invariant 6).
 * All behavior lives in app/transportController — this component is the
 * dumb facade caller ARCHITECTURE.md sanctions.
 */

import { CaretLeft, CaretRight, Pause, Play } from '@phosphor-icons/react'
import { useTransportStore } from '../state/transportStore'
import { stepFrame, togglePlayback } from '../app/transportController'
import {
  executeEditorCommand,
  resolveEditorCommand,
  shortcutForCommand,
} from '../app/editorCommands'
import AudioMeter from './AudioMeter'

export default function TransportBar() {
  const isPlaying = useTransportStore((s) => s.isPlaying)
  useTransportStore((s) => s.timelineInFrame)
  useTransportStore((s) => s.timelineOutExclusive)
  useTransportStore((s) => s.videoTargetTrackId)
  useTransportStore((s) => s.audioTargetTrackId)
  useTransportStore((s) => s.trackTargetsTouched)
  const previousShortcut = shortcutForCommand('transport.previous-frame')!
  const nextShortcut = shortcutForCommand('transport.next-frame')!
  const insertCommand = resolveEditorCommand('timeline.insert')
  const overwriteCommand = resolveEditorCommand('timeline.overwrite')
  const insertDisabled = insertCommand.enabled ? null : insertCommand.disabledReason
  const overwriteDisabled = overwriteCommand.enabled ? null : overwriteCommand.disabledReason

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
      <button
        className="transport-button"
        aria-label="Insert edit"
        aria-keyshortcuts={shortcutForCommand('timeline.insert')?.ariaKeyShortcuts}
        title={insertDisabled ?? `Insert (${shortcutForCommand('timeline.insert')?.label})`}
        aria-disabled={insertDisabled !== null}
        onClick={() => {
          if (insertDisabled) return
          executeEditorCommand('timeline.insert')
        }}
      >
        Insert
      </button>
      <button
        className="transport-button"
        aria-label="Overwrite edit"
        aria-keyshortcuts={shortcutForCommand('timeline.overwrite')?.ariaKeyShortcuts}
        title={overwriteDisabled ?? `Overwrite (${shortcutForCommand('timeline.overwrite')?.label})`}
        aria-disabled={overwriteDisabled !== null}
        onClick={() => {
          if (overwriteDisabled) return
          executeEditorCommand('timeline.overwrite')
        }}
      >
        Overwrite
      </button>
      <AudioMeter />
    </div>
  )
}
