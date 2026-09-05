import type { MediaAsset } from '../../domain/schema'
export function alignmentAsset(id: string): MediaAsset {
  return { id, fileName: `${id}.mov`, mimeType: 'video/quicktime', size: 5, lastModified: 10,
    objectUrl: `blob:${id}`, kind: 'video', durationFrames: 900, durationMicroseconds: 30_000_000,
    sourceBounds: { video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 30_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 30_000_000 } },
    frameRate: { num: 30, den: 1 }, width: 320, height: 180, hasAudio: true,
    audioSampleRate: 8000, audioChannels: 1, decoderConfigB64: null }
}
