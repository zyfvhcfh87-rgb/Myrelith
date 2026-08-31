/** Small serializable projection of audio-effect host status for Inspector. */

import { create } from 'zustand'
import type { AudioEffectResolutionStatus } from '../domain/audioEffectStack'
import type { AudioEffectId } from '../domain/schema'

export interface AudioEffectStatus {
  readonly label: string
  readonly status: AudioEffectResolutionStatus
  readonly detail: string
}

export interface AudioEffectHostStatuses {
  readonly playback: AudioEffectStatus
  readonly export: AudioEffectStatus
}

export interface AudioEffectStatusState {
  statuses: ReadonlyMap<AudioEffectId, AudioEffectHostStatuses>
  setStatuses(statuses: ReadonlyMap<AudioEffectId, AudioEffectHostStatuses>): void
  resetAudioEffectStatuses(): void
}

export const PENDING_AUDIO_EFFECT_DETAIL =
  'Audio host status has not been projected yet; the effect is preserved and bypassed.'

const EMPTY_STATUSES: ReadonlyMap<AudioEffectId, AudioEffectHostStatuses> = new Map()

export const useAudioEffectStatusStore = create<AudioEffectStatusState>()((set) => ({
  statuses: EMPTY_STATUSES,
  setStatuses: (statuses) => set({ statuses: new Map(statuses) }),
  resetAudioEffectStatuses: () => set({ statuses: EMPTY_STATUSES }),
}))
