/** Track and master mixer gains shared by live playback and export. */

import type {
  AudioEffectDescriptor,
  MasterAudioSettings,
  TimelineDoc,
  Track,
  TrackId,
} from './schema'
import { cloneAudioEffectStack } from './audioEffectStack'
import {
  MAX_AUDIO_BALANCE,
  MAX_CLIP_VOLUME,
  MIN_AUDIO_BALANCE,
  MIN_CLIP_VOLUME,
  stereoBalanceGains,
} from './clipInspector'

export const DEFAULT_TRACK_VOLUME = 1
export const DEFAULT_TRACK_BALANCE = 0

const DEFAULT_MASTER_AUDIO_EFFECTS: AudioEffectDescriptor[] = []
Object.freeze(DEFAULT_MASTER_AUDIO_EFFECTS)

export const DEFAULT_MASTER_AUDIO: Readonly<MasterAudioSettings> = Object.freeze({
  volume: DEFAULT_TRACK_VOLUME,
  balance: DEFAULT_TRACK_BALANCE,
  muted: false,
  audioEffects: DEFAULT_MASTER_AUDIO_EFFECTS,
})

export interface MixerGains {
  readonly volume: number
  readonly balance: number
  readonly leftGain: number
  readonly rightGain: number
}

export interface TimelineAudioTrackBus extends MixerGains {
  readonly trackId: TrackId
  /** Nested graphs route this bus into another bus; absent means root master. */
  readonly parentTrackId?: TrackId
  readonly audioEffects: readonly AudioEffectDescriptor[]
}

export interface TimelineAudioMasterBus extends MixerGains {
  readonly muted: boolean
  readonly audioEffects: readonly AudioEffectDescriptor[]
}

export function defaultMasterAudio(): MasterAudioSettings {
  return {
    volume: DEFAULT_MASTER_AUDIO.volume,
    balance: DEFAULT_MASTER_AUDIO.balance,
    muted: DEFAULT_MASTER_AUDIO.muted,
    audioEffects: [],
  }
}

export function trackVolume(track: Track): number {
  return track.volume ?? DEFAULT_TRACK_VOLUME
}

export function trackBalance(track: Track): number {
  return track.balance ?? DEFAULT_TRACK_BALANCE
}

export function masterAudioSettings(doc: TimelineDoc): MasterAudioSettings {
  const authored = doc.masterAudio
  if (authored === undefined) return defaultMasterAudio()
  return {
    volume: authored.volume,
    balance: authored.balance,
    muted: authored.muted,
    audioEffects: cloneAudioEffectStack(authored.audioEffects),
  }
}

function finite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

export function mixerGains(volume: number, balance: number): MixerGains {
  const [leftGain, rightGain] = stereoBalanceGains(balance)
  return { volume, balance, leftGain, rightGain }
}

export function trackMixerGains(track: Track): MixerGains {
  return mixerGains(trackVolume(track), trackBalance(track))
}

export function masterMixerGains(doc: TimelineDoc): TimelineAudioMasterBus {
  const master = masterAudioSettings(doc)
  return {
    ...mixerGains(master.volume, master.balance),
    muted: master.muted,
    audioEffects: master.audioEffects ?? [],
  }
}

export function mixerVolumeValidationError(volume: number): string | null {
  if (!finite(volume) || volume < MIN_CLIP_VOLUME || volume > MAX_CLIP_VOLUME) {
    return `volume must be a finite number from ${MIN_CLIP_VOLUME} to ${MAX_CLIP_VOLUME}`
  }
  return null
}

export function mixerBalanceValidationError(balance: number): string | null {
  if (
    !finite(balance)
    || balance < MIN_AUDIO_BALANCE
    || balance > MAX_AUDIO_BALANCE
  ) {
    return `balance must be a finite number from ${MIN_AUDIO_BALANCE} to ${MAX_AUDIO_BALANCE}`
  }
  return null
}

export function trackMixerValidationError(
  volume: number,
  balance: number,
): string | null {
  return mixerVolumeValidationError(volume) ?? mixerBalanceValidationError(balance)
}

export function masterAudioValidationError(
  settings: Pick<MasterAudioSettings, 'volume' | 'balance' | 'muted'>,
): string | null {
  const gainError = trackMixerValidationError(settings.volume, settings.balance)
  if (gainError) return gainError
  if (typeof settings.muted !== 'boolean') return 'muted must be a boolean'
  return null
}

/** Audio lanes in compositing array order, including muted and empty tracks. */
export function mixerAudioTracks(doc: TimelineDoc): Track[] {
  return doc.tracks.filter((track) => track.kind === 'audio')
}

export function timelineAudioMixerGraph(doc: TimelineDoc): {
  tracks: TimelineAudioTrackBus[]
  master: TimelineAudioMasterBus
} {
  const tracks = mixerAudioTracks(doc).map((track) => {
    const gains = trackMixerGains(track)
    const error = trackMixerValidationError(gains.volume, gains.balance)
    if (error) {
      throw new RangeError(`Audio track "${track.id}" ${error}`)
    }
    return {
      trackId: track.id,
      ...gains,
      audioEffects: cloneAudioEffectStack(track.audioEffects),
    }
  })
  const master = masterMixerGains(doc)
  const masterError = masterAudioValidationError(master)
  if (masterError) throw new RangeError(`Master audio ${masterError}`)
  return { tracks, master }
}
