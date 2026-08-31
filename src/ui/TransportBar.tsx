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
import {
  executeEditorCommand,
  resolveEditorCommand,
  shortcutForCommand,
  type EditorCommandId,
} from '../app/editorCommands'
import { stepFrame, togglePlayback } from '../app/transportController'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { useTransportStore } from '../state/transportStore'
import AudioMeter from './AudioMeter'

function SequenceEditButton({
  commandId,
  label,
}: {
  commandId: EditorCommandId
  label: string
}) {
  const command = resolveEditorCommand(commandId)
  const disabled = command.enabled ? null : command.disabledReason
  const shortcut = shortcutForCommand(commandId)
  return (
    <button
      className="transport-button transport-sequence-edit"
      aria-label={command.label}
      aria-keyshortcuts={shortcut?.ariaKeyShortcuts}
      title={disabled ?? `${command.label}${shortcut ? ` (${shortcut.label})` : ''}`}
      aria-disabled={disabled !== null}
      onClick={() => {
        if (disabled) return
        executeEditorCommand(commandId)
      }}
    >
      {label}
    </button>
  )
}

export default function TransportBar() {
  const isPlaying = useTransportStore((s) => s.isPlaying)
  useTransportStore((s) => s.timelineInFrame)
  useTransportStore((s) => s.timelineOutExclusive)
  useTransportStore((s) => s.videoTargetTrackId)
  useTransportStore((s) => s.audioTargetTrackId)
  useTransportStore((s) => s.trackTargetsTouched)
  useTransportStore((s) => s.selectedClipId)
  useSourceMonitorStore((s) => s.session)
  useSourceMonitorStore((s) => s.patchVideo)
  useSourceMonitorStore((s) => s.patchAudio)
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
      <SequenceEditButton commandId="timeline.insert" label="Insert" />
      <SequenceEditButton commandId="timeline.overwrite" label="Overwrite" />
      <SequenceEditButton commandId="timeline.lift" label="Lift" />
      <SequenceEditButton commandId="timeline.extract" label="Extract" />
      <SequenceEditButton commandId="timeline.replace" label="Replace" />
      <AudioMeter />
    </div>
  )
}
