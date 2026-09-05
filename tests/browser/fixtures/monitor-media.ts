/** Browser-only encoded workload. Independent local Files share this generated content. */
export async function encodeMonitorMedia(options: { seconds: number; width: number; height: number; codec?: 'avc' | 'vp9'; keyFrameInterval?: number }): Promise<string> {
  const path = '/node_modules/.vite/deps/mediabunny.js'
  const { Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat, VideoSampleSource, VideoSample, AudioSampleSource, AudioSample } = await import(path)
  const target = new BufferTarget(), codec = options.codec ?? 'avc'
  const output = new Output({ format: codec === 'avc' ? new Mp4OutputFormat() : new WebMOutputFormat(), target })
  const video = new VideoSampleSource({ codec, bitrate: 1_000_000, keyFrameInterval: options.keyFrameInterval ?? 1 })
  const audio = new AudioSampleSource({ codec: codec === 'avc' ? 'aac' : 'opus', bitrate: 96_000 })
  output.addVideoTrack(video, { frameRate: 30 }); output.addAudioTrack(audio)
  const canvas = new OffscreenCanvas(options.width, options.height), ctx = canvas.getContext('2d')!
  await output.start()
  try {
    await Promise.all([(async () => {
      for (let frame = 0; frame < options.seconds * 30; frame++) {
        ctx.fillStyle = `hsl(${frame * 3 % 360} 65% 25%)`; ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'; ctx.fillText(`Frame ${frame}`, 30, 90)
        ctx.fillRect(frame * 13 % canvas.width, canvas.height / 2, 50, 50)
        const sample = new VideoSample(canvas, { timestamp: frame / 30, duration: 1 / 30 })
        try { await video.add(sample) } finally { sample.close() }
      }
    })(), (async () => {
      for (let start = 0; start < options.seconds * 48000; start += 4096) {
        const pcm = new Float32Array(Math.min(4096, options.seconds * 48000 - start))
        // Deliberately silent: retain the audio track and scheduling workload
        // without introducing an audible test tone.
        const sample = new AudioSample({ data: pcm, format: 'f32-planar', sampleRate: 48000, numberOfChannels: 1, timestamp: start / 48000 })
        try { await audio.add(sample) } finally { sample.close() }
      }
    })()])
    await output.finalize()
  } catch (cause) { await output.cancel(); throw cause }
  const bytes = new Uint8Array(target.buffer); let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  canvas.width = canvas.height = 0
  return btoa(binary)
}
