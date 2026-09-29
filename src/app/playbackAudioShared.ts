/**
 * app/playbackAudioShared.ts — helpers shared by the Program transport and
 * Source Monitor playback owners. Each owner keeps its own state, messages
 * and ordering; this module only removes their copied mechanics.
 */

import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'
import {
  createSourceBoundsCatalog,
  type SourceBoundsCatalog,
} from '../domain/crossfadePlan'
import type { AssetId, MediaAsset, TimelineDoc } from '../domain/schema'
import type { PlaybackClock } from '../engine/playback-engine'
import {
  startTimelineAudioPlayback,
  type PlaybackAssetResolver,
  type StartTimelineAudioOptions,
  type TimelineAudioPlaybackSession,
  type TimelineAudioPlaybackWarning,
} from '../pipeline/playback-audio'
import { useMediaStore } from '../state/mediaStore'
import type { MediaResourceLease } from './mediaResourceAdmission'

/** Production audio start; the injected clock is the real AudioContext. */
export function startPlaybackAudio(
  context: PlaybackClock,
  doc: TimelineDoc,
  fromFrame: number,
  resolveAsset: PlaybackAssetResolver,
  options: StartTimelineAudioOptions,
): Promise<TimelineAudioPlaybackSession> {
  return startTimelineAudioPlayback(
    context as AudioContext,
    doc,
    fromFrame,
    resolveAsset,
    options,
  )
}

/** Durable descriptor bounds, so offline sources keep their exact facts. */
export function descriptorSourceBoundsCatalog(): SourceBoundsCatalog {
  return createSourceBoundsCatalog(
    useMediaStore.getState().descriptors.values(),
  )
}

/**
 * Resolve from the immutable media snapshot; the live source owns caching.
 * `label` prefixes resolver errors ("Playback", "Source playback").
 */
export function createPlaybackAssetResolver(
  assets: ReadonlyMap<AssetId, MediaAsset>,
  fetchBlob: (url: string) => Promise<Blob>,
  label: string,
): PlaybackAssetResolver {
  return (assetId) => {
    const asset = assets.get(assetId)
    if (!asset) {
      throw new Error(
        `${label} media asset "${assetId}" is missing from the media pool`,
      )
    }
    if (!asset.hasAudio) {
      throw new Error(
        `${label} media asset "${asset.fileName}" has no imported audio track`,
      )
    }
    try {
      return Promise.resolve(fetchBlob(asset.objectUrl)).then((blob) => ({
        blob,
        budget: mediaAssetDecoderBudget(asset, blob.size),
      }))
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
}

/** Console text for one playback warning; `prefix` names the owner ("source "). */
export function playbackAudioWarningMessage(
  warning: TimelineAudioPlaybackWarning,
  prefix = '',
): string {
  if (warning.scope === 'media') {
    if (warning.stage === 'source-open') {
      return `${prefix}audio clip "${warning.clipId}" source open failed`
    }
    if (warning.stage === 'decoded-timing') {
      return `${prefix}audio clip "${warning.clipId}" produced invalid decoded timing`
    }
    return `${prefix}audio clip "${warning.clipId}" decode failed`
  }
  if (warning.stage === 'output-schedule') {
    return `${prefix}audio output scheduling failed`
  }
  if (warning.stage === 'pump') return `${prefix}audio refill failed`
  return `${prefix}audio cleanup failed`
}

/**
 * Stop one adopted audio session. A replacement may start while it is still
 * closing, so its lease stays counted until the stop settles; optional
 * previews must yield if that overlap exceeds their allowance rather than
 * undercounting audio owners.
 */
export function stopPlaybackAudioSession(
  session: TimelineAudioPlaybackSession,
  lease: MediaResourceLease | null,
): Promise<unknown> {
  let pending: Promise<unknown>
  try {
    pending = Promise.resolve(session.stop())
  } catch (cause) {
    pending = Promise.reject(cause)
  }
  return pending.finally(() => lease?.release())
}

/** Startup/admission tasks and audio cleanup that a monitor drain retires. */
export class PlaybackTasks {
  readonly playback = new Set<Promise<void>>()
  readonly cleanup = new Set<Promise<void>>()

  /** Track one startup or admission task that never rejects. */
  track(task: Promise<void>): void {
    this.playback.add(task)
    void task.then(() => this.playback.delete(task))
  }

  /** Track cleanup until it settles; failures are reported, never rethrown. */
  trackCleanup(
    operation: Promise<unknown>,
    onFailure: (cause: unknown) => void,
  ): Promise<void> {
    const cleanup = operation.then(() => undefined, onFailure)
    this.cleanup.add(cleanup)
    void cleanup.then(() => this.cleanup.delete(cleanup))
    return cleanup
  }

  hasWork(): boolean {
    return this.playback.size > 0 || this.cleanup.size > 0
  }

  /** Every task outstanding right now. */
  pending(): Promise<void>[] {
    return [...this.playback, ...this.cleanup]
  }

  async drain(): Promise<void> {
    // Snapshot playback once. A later admission here may wait on the other
    // monitor's drain, which can wait on an admission that waits on this
    // drain. Re-checking playback tasks would pull that cycle in and hang.
    await Promise.all(this.pending())
    while (this.cleanup.size > 0) {
      await Promise.all([...this.cleanup])
    }
  }
}
