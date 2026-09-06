import { AudioSample, AudioSampleSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat, Input, BlobSource, ALL_FORMATS } from 'mediabunny'
import { importMedia } from '../../src/app/mediaImportController'
import { fingerprintProxyOriginal } from '../../src/app/proxyController'

export const PROFILES = [
  { id: 'avc-1080', codec: 'avc', width: 1920, height: 1080, bitrate: 8_000_000 },
  { id: 'vp9-1080', codec: 'vp9', width: 1920, height: 1080, bitrate: 6_000_000 },
  { id: 'avc-2160', codec: 'avc', width: 3840, height: 2160, bitrate: 20_000_000 },
] as const
export async function generate(profileId: string, angle: number) {
  const profile = PROFILES.find((p) => p.id === profileId)
  if (!profile || angle < 0 || angle > 7) throw new Error('Invalid fixture')
  const { width, height, codec, bitrate } = profile
  const seconds = 8, frames = seconds * 30
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d')!
  const target = new BufferTarget()
  const output = new Output({ target, format: codec === 'vp9' ? new WebMOutputFormat() : new Mp4OutputFormat() })
  const video = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 1 })
  const audio = new AudioSampleSource({ codec: codec === 'vp9' ? 'opus' : 'aac', bitrate: 96_000 })
  output.addVideoTrack(video, { frameRate: 30 }); output.addAudioTrack(audio)
  await output.start()
  try {
    await Promise.all([(async () => {
      for (let frame = 0; frame < frames; frame++) {
        context.fillStyle = `hsl(${angle * 43 + frame * 2} 55% 24%)`
        context.fillRect(0, 0, width, height)
        // Moving, spatially detailed deterministic tiles; each camera differs.
        for (let i = 0; i < 160; i++) {
          context.fillStyle = `hsl(${i * 37 + angle * 43} 75% ${25 + (i % 5) * 12}%)`
          context.fillRect((i * 173 + frame * (7 + angle)) % width,
            (i * 97 + frame * 5) % height, width / 28, height / 18)
        }
        context.fillStyle = 'white'; context.font = `${height / 12}px sans-serif`
        context.fillText(`Camera ${angle + 1} / ${frame}`, width / 12, height / 2)
        await video.add(frame / 30, 1 / 30)
      }
    })(), (async () => {
      for (let start = 0; start < seconds * 48_000; start += 4096) {
        const count = Math.min(4096, seconds * 48_000 - start), data = new Float32Array(count)
        // Silent audio keeps the decoder/scheduler workload without test tones.
        const sample = new AudioSample({ data, format: 'f32-planar', sampleRate: 48_000, numberOfChannels: 1, timestamp: start / 48_000 })
        try { await audio.add(sample) } finally { sample.close() }
      }
    })()])
    await output.finalize()
  } catch (cause) { await output.cancel(); throw cause }
  finally { canvas.width = 0; canvas.height = 0 }
  if (!target.buffer) throw new Error('No fixture output')
  const file = new File([target.buffer], `${profile.id}-camera-${angle + 1}.${codec === 'vp9' ? 'webm' : 'mp4'}`,
    { type: codec === 'vp9' ? 'video/webm' : 'video/mp4', lastModified: 195 })
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  let decoderConfig: VideoDecoderConfig | null, frameStats: unknown
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('Missing fixture track')
    decoderConfig = await track.getDecoderConfig()
    frameStats = await track.computePacketStats(1000)
  } finally { input.dispose() }
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', target.buffer)), (b) => b.toString(16).padStart(2, '0')).join('')
  const fingerprint = await fingerprintProxyOriginal(file, { fileName: file.name, size: file.size, lastModified: file.lastModified })
  const imported = await importMedia(file)
  if (imported.status !== 'imported') throw new Error(`Fixture import: ${JSON.stringify(imported)}`)
  return { assetId: imported.assetId, profile, fileName: file.name, bytes: file.size, sha256, fingerprint, decoderConfig, frameStats, frames, seconds }
}
