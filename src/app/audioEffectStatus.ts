/** App-owned projection of audio-effect status into UI-readable state. */

import {
  audioEffectHostCapabilities,
  resolveAudioEffectStack,
  type AudioEffectCapability,
  type AudioEffectResolution,
} from '../domain/audioEffectStack'
import {
  clipAudioEffects,
  masterAudioEffects,
  trackAudioEffects,
} from '../domain/audioEffectBounds'
import type { AudioEffectDescriptor, AudioEffectId, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import {
  useAudioEffectStatusStore,
  type AudioEffectHostStatuses,
  type AudioEffectStatus,
} from '../state/audioEffectStatusStore'

export function playbackAudioEffectCapabilities(
  host: { readonly createScriptProcessor?: unknown } | undefined =
    globalThis.AudioContext?.prototype,
): ReadonlySet<AudioEffectCapability> {
  return audioEffectHostCapabilities({
    jsStereoBlock: typeof host?.createScriptProcessor === 'function',
  })
}

export function exportAudioEffectCapabilities(): ReadonlySet<AudioEffectCapability> {
  return audioEffectHostCapabilities({ jsStereoBlock: true })
}

export function projectAudioEffectStatuses(
  doc: TimelineDoc,
  playbackCapabilities: ReadonlySet<AudioEffectCapability> =
    playbackAudioEffectCapabilities(),
  exportCapabilities: ReadonlySet<AudioEffectCapability> =
    exportAudioEffectCapabilities(),
): ReadonlyMap<AudioEffectId, AudioEffectHostStatuses> {
  const statuses = new Map<AudioEffectId, AudioEffectHostStatuses>()
  const recordStack = (
    effects: readonly AudioEffectDescriptor[],
    stackPlaybackCapabilities: ReadonlySet<AudioEffectCapability>,
  ): void => {
    const exportResolutions = new Map<AudioEffectId, AudioEffectResolution>(
      resolveAudioEffectStack(effects, exportCapabilities)
        .map((resolution) => [resolution.effect.id, resolution] as const),
    )
    for (const resolution of resolveAudioEffectStack(effects, stackPlaybackCapabilities)) {
      const exportResolution = exportResolutions.get(resolution.effect.id)
      if (!exportResolution) continue
      const toStatus = (item: AudioEffectResolution): AudioEffectStatus => ({
        label: item.label,
        status: item.status,
        detail: item.detail,
      })
      statuses.set(resolution.effect.id, {
        playback: toStatus(resolution),
        export: toStatus(exportResolution),
      })
    }
  }
  recordStack(masterAudioEffects(doc.masterAudio), playbackCapabilities)
  for (const track of doc.tracks) {
    recordStack(trackAudioEffects(track), playbackCapabilities)
    for (const clip of track.clips) {
      // Clip stacks are rendered into bounded PCM blocks without relying on
      // the deprecated live ScriptProcessor host.
      recordStack(clipAudioEffects(clip), exportCapabilities)
    }
  }
  return statuses
}

export function initAudioEffectStatusProjection(): () => void {
  const publish = (doc: TimelineDoc): void => {
    useAudioEffectStatusStore.getState().setStatuses(projectAudioEffectStatuses(doc))
  }
  publish(useDocumentStore.getState().doc)
  return useDocumentStore.subscribe((state, previous) => {
    if (state.doc !== previous.doc) publish(state.doc)
  })
}
