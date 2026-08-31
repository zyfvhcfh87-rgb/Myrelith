import type { ClipAudioPatch } from '../../domain/operations'
import type { Clip } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import {
  clipAudioSettings,
  DEFAULT_CLIP_AUDIO_SETTINGS,
  resolveClipAnimationAtFrame,
} from '../../state/editorUi'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import {
  InspectorSection,
  NumberField,
  RangeNumberField,
  ToggleField,
} from './InspectorFields'

export default function AudioInspectorSection({ clip, locked }: { clip: Clip; locked: boolean }) {
  const playheadFrame = useTransportStore((state) => state.playheadFrame)
  const resolved = resolveClipAnimationAtFrame(clip, playheadFrame)
  const audio = clipAudioSettings(resolved)
  const channels = useMediaStore((state) =>
    state.assets.get(clip.assetId)?.audioChannels
      ?? state.descriptors.get(clip.assetId)?.audioChannels
      ?? null,
  )
  const balanceApplicable = channels !== 1
  const controlsDisabled = locked || !audio.enabled
  const patch = (next: ClipAudioPatch): void =>
    useDocumentStore.getState().updateClipAudioAtFrame(clip.id, playheadFrame, next)

  return (
    <div className="inspector-section-stack" key={`audio:${clip.id}`}>
      <div className="inspector-context-label">Audio · {clip.name}</div>
      <InspectorSection
        title="Audio"
        resetLabel="Reset audio settings"
        disabled={locked}
        onReset={() => patch({
          volume: 1,
          audio: { ...DEFAULT_CLIP_AUDIO_SETTINGS },
        })}
      >
        <div className="inspector-grid">
          <ToggleField label="Audio enabled" checked={audio.enabled} disabled={locked} testId="inspector-audio-enabled" onChange={(enabled) => patch({ audio: { enabled } })} />
          <RangeNumberField label="Volume" value={resolved.volume} step={0.01} min={0} max={2} testId="inspector-volume" disabled={controlsDisabled} onCommit={(volume) => patch({ volume })} />
          <RangeNumberField label="Balance" value={audio.balance} step={0.01} min={-1} max={1} testId="inspector-balance" disabled={controlsDisabled || !balanceApplicable} onCommit={(balance) => patch({ audio: { balance } })} />
          <NumberField label="Fade in (frames)" value={audio.fadeInFrames} step={1} min={0} max={clip.timelineRange.durationFrames} testId="inspector-fade-in" disabled={controlsDisabled} clamp onCommit={(fadeInFrames) => patch({ audio: { fadeInFrames } })} />
          <NumberField label="Fade out (frames)" value={audio.fadeOutFrames} step={1} min={0} max={clip.timelineRange.durationFrames} testId="inspector-fade-out" disabled={controlsDisabled} clamp onCommit={(fadeOutFrames) => patch({ audio: { fadeOutFrames } })} />
        </div>
        <span className="inspector-note">
          {balanceApplicable
            ? 'Balance attenuates the opposite source channel; fades use project frames.'
            : 'This source is mono, so stereo balance is unavailable.'}
        </span>
      </InspectorSection>
    </div>
  )
}
