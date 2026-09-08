import { createCaptionTrack } from '../domain/captions'
import type { CaptionIntentDescriptor } from '../domain/captionIntent'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline, type SequenceProject } from '../domain/projectSequences'
import type { CaptionOriginDescriptor } from '../domain/captionOrigin'

export const captionTrackOrigin = (): CaptionOriginDescriptor => ({ version: 1, params: {
  runId: 'run-1', modelId: 'Xenova/whisper-tiny', modelRevision: 'a'.repeat(40), manifestDigest: 'b'.repeat(64),
  runtimeVersion: '4.2.0', language: 'en', sourceAssetId: 'historical-audio', sourceFingerprintAlgorithm: 'sha256-sampled-v1',
  sourceFingerprintDigest: 'c'.repeat(64), sourceSampleRate: 16_000, sourceStartSample: 16_000, sourceSampleCount: 32_000, targetFrameOffset: 0,
} })
export const captionCueOrigin = (start = 16_000, count = 16_000): CaptionOriginDescriptor => ({ version: 1,
  params: { runId: 'run-1', sourceStartSample: start, sourceSampleCount: count } })

export function captionIntentProject(): SequenceProject {
  const root = structuredClone(createTimelineDoc('Captions', DEFAULT_PROJECT_SETTINGS, 'root'))
  root.captionTracks = [{ ...createCaptionTrack('captions', 'Captions', 'en'), origin: captionTrackOrigin(),
    style: { version: 1, params: { shadowEnabled: false, color: '#ffffffff' } }, items: [
      { id: 'cue-a', text: 'Hello world', range: { startFrame: 0, durationFrames: 25 }, origin: captionCueOrigin() },
      { id: 'cue-b', text: 'Again', range: { startFrame: 25, durationFrames: 25 }, origin: captionCueOrigin(32_000) },
    ] }]
  const dormant = structuredClone(createTimelineDoc('Dormant', DEFAULT_PROJECT_SETTINGS, 'dormant'))
  for (const track of dormant.tracks) track.id = `dormant-${track.id}`
  dormant.captionTracks = [{ ...createCaptionTrack('dormant-captions', 'Dormant'), hidden: true, items: [
    { id: 'dormant-cue', text: 'Future', range: { startFrame: 0, durationFrames: 1 },
      style: { version: 99, params: { future: true, color: 'not-interpreted' } }, origin: { version: 99, params: { future: 'origin' } } },
  ] }]
  return { ...sequenceProjectFromTimeline(root), sequences: [root, dormant] }
}

/** Exact ASCII serialized bytes, using valid bounded opaque primitive envelopes. */
export function opaqueCaptionBytes(size: number): CaptionIntentDescriptor {
  const params: Record<string, string> = {}
  const descriptor = { version: 9, params }
  if (size < JSON.stringify(descriptor).length || size > 4096) throw new RangeError('Bad fixture size')
  while (JSON.stringify(descriptor).length < size) {
    const remaining = size - JSON.stringify(descriptor).length
    const existing = Object.keys(params).at(-1)
    if (existing && params[existing]!.length < 128) {
      params[existing] += 'x'.repeat(Math.min(128 - params[existing]!.length, remaining))
    } else {
      const index = Object.keys(params).length
      const overhead = index ? 6 : 5
      if (remaining < overhead + 1) throw new RangeError('Unreachable fixture size')
      const key = String(index).padStart(Math.min(128, remaining - overhead), 'k')
      params[key] = ''
    }
  }
  if (Object.keys(params).length > 24) throw new RangeError('Too many fixture keys')
  return descriptor
}
export function captionBudgetProject(size: number): SequenceProject {
  const base = captionIntentProject()
  const descriptors: CaptionIntentDescriptor[] = []
  while (size > 0) {
    let chunk = Math.min(size, 4096)
    if (size > chunk && size - chunk < 32) chunk -= 32
    descriptors.push(opaqueCaptionBytes(chunk))
    size -= chunk
  }
  return { ...base, sequences: base.sequences.map((sequence, sequenceIndex) => ({ ...sequence,
    captionTracks: [{ ...createCaptionTrack(`${sequence.id}-captions`, 'Budget'), hidden: true,
      items: descriptors.filter((_, i) => i % 2 === sequenceIndex).map((style, i) => ({
        id: `${sequence.id}-cue-${i}`, text: 'Budget', range: { startFrame: i, durationFrames: 1 }, style,
      })),
    }],
  })) }
}
