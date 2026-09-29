/**
 * app/sourceReviewDocument.ts — the Source Monitor's one-clip review
 * TimelineDoc. It is worker/audio protocol only: it never enters
 * documentStore, recovery, or undo.
 */

import { defaultClipTransform } from '../domain/clipInspector'
import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'
import type { MediaAsset, TimelineDoc } from '../domain/schema'
import type { SourceMonitorSession } from '../domain/sourceMonitor'

/**
 * Build the review document for the Source preview (`video`: one visual
 * track for video and still sources, none for audio-only sources) or the
 * Source audio audition (`audio`: one timed audio track).
 */
export function sourceReviewDocument(
  session: SourceMonitorSession,
  asset: MediaAsset | undefined,
  kind: 'video' | 'audio',
): TimelineDoc {
  const { source } = session
  const still = kind === 'video' && source.kind === 'image'
  const hasTrack = kind === 'audio' || source.kind === 'video' || still
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: `source-review:${source.assetId}`,
    name: source.fileName,
    frameRate: source.rate,
    width: Math.max(1, asset?.width ?? 1920),
    height: Math.max(1, asset?.height ?? 1080),
    audioSampleRate: kind === 'audio' ? asset?.audioSampleRate ?? 48_000 : 48_000,
    tracks: hasTrack
      ? [{
          id: kind === 'audio' ? 'source-review-A1' : 'source-review-V1',
          kind,
          name: 'Source',
          clips: [{
            id: kind === 'audio' ? 'source-review-audio' : 'source-review-clip',
            assetId: source.assetId,
            name: source.fileName,
            sourceMode: still ? 'still' : 'timed',
            sourceRange: {
              startFrame: 0,
              durationFrames: still ? 1 : source.durationFrames,
            },
            timelineRange: {
              startFrame: 0,
              durationFrames: source.durationFrames,
            },
            transform: defaultClipTransform(),
            opacity: 1,
            volume: 1,
            effects: [],
          }],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        }]
      : [],
  }
}
