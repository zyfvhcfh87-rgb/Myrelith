/** App-owned projection of audio-effect status into UI-readable state. */

import {
  audioEffectHostCapabilities,
  resolveAudioEffectStack,
  type AudioEffectCapability,
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
  type AudioEffectStatus,
} from '../state/audioEffectStatusStore'

export function playbackAudioEffectCapabilities(): ReadonlySet<AudioEffectCapability> {
  return audioEffectHostCapabilities({ jsStereoBlock: true })
}

export function exportAudioEffectCapabilities(): ReadonlySet<AudioEffectCapability> {
  return audioEffectHostCapabilities({ jsStereoBlock: true })
}

export function projectAudioEffectStatuses(
  doc: TimelineDoc,
  capabilities: ReadonlySet<AudioEffectCapability> = playbackAudioEffectCapabilities(),
): ReadonlyMap<AudioEffectId, AudioEffectStatus> {
  const statuses = new Map<AudioEffectId, AudioEffectStatus>()
  const recordStack = (effects: readonly AudioEffectDescriptor[]): void => {
    for (const resolution of resolveAudioEffectStack(effects, capabilities)) {
      statuses.set(resolution.effect.id, {
        label: resolution.label,
        status: resolution.status,
        detail: resolution.detail,
      })
    }
  }
  recordStack(masterAudioEffects(doc.masterAudio))
  for (const track of doc.tracks) {
    recordStack(trackAudioEffects(track))
    for (const clip of track.clips) {
      recordStack(clipAudioEffects(clip))
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
