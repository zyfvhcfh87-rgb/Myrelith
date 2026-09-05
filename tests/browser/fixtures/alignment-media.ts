/** Executed inside Chromium: encode original local sources, never mock the product decoder. */
export async function encodeAlignmentMedia(options: {
  kind: 'noise' | 'repeated' | 'speech'; offset: number; seconds: number; timecode?: number; speechBase64?: string
}): Promise<string> {
  const mediabunnyPath = '/node_modules/.vite/deps/mediabunny.js'
  const { Output, BufferTarget, Mp4OutputFormat, AudioSampleSource, VideoSampleSource, AudioSample, VideoSample } = await import(mediabunnyPath)
  const fixturePath = '/src/domain/multicamAlignmentResearchFixtures.ts'
  const { researchFixtureSample } = await import(fixturePath)
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target })
  const video = new VideoSampleSource({ codec: 'avc', bitrate: 120_000 })
  const audio = new AudioSampleSource({ codec: 'aac', bitrate: 128_000 })
  output.addVideoTrack(video, { frameRate: 30 })
  output.addAudioTrack(audio)
  const sampleRate = 48_000
  let speech: AudioBuffer | null = null
  if (options.speechBase64) {
    const bytes = Uint8Array.from(atob(options.speechBase64), (character) => character.charCodeAt(0))
    speech = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes.buffer)
  }
  const canvas = new OffscreenCanvas(160, 90)
  const context = canvas.getContext('2d')!
  await output.start()
  try {
    await Promise.all([(async () => {
    for (let start = 0; start < options.seconds * sampleRate; start += 4096) {
      const count = Math.min(4096, options.seconds * sampleRate - start)
      const pcm = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        const time = (start + i) / sampleRate + options.offset
        pcm[i] = options.kind === 'speech' && speech
          ? (speech.getChannelData(0)[Math.floor((time + 2) * speech.sampleRate)] ?? 0) * (options.offset ? 0.5 : 1)
          : researchFixtureSample(options.kind, time, 37) * (options.offset ? 0.5 : 1)
      }
      const sample = new AudioSample({ data: pcm, format: 'f32-planar', sampleRate, numberOfChannels: 1, timestamp: start / sampleRate })
      try { await audio.add(sample) } finally { sample.close() }
    }
    })(), (async () => {
    for (let frame = 0; frame < options.seconds * 30; frame++) {
      context.fillStyle = options.offset ? '#176f91' : '#8c4534'
      context.fillRect(0, 0, 160, 90)
      context.fillStyle = 'white'; context.font = '18px sans-serif'
      context.fillText(`${options.offset ? 'B' : 'A'} ${frame}`, 12, 48)
      const sample = new VideoSample(canvas, { timestamp: frame / 30, duration: 1 / 30 })
      try { await video.add(sample) } finally { sample.close() }
    }
    })()])
    await output.finalize()
  } catch (cause) { await output.cancel(); throw cause }
  let bytes = new Uint8Array(target.buffer)
  if (options.timecode !== undefined) {
    // Keep original media offsets: retire the old moov in place and append a new moov + tmcd sample.
    const join = (...parts: Uint8Array[]) => {
      const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length }; return result
    }
    const words = (...values: number[]) => {
      const result = new Uint8Array(values.length * 4), view = new DataView(result.buffer)
      values.forEach((value, i) => view.setUint32(i * 4, value)); return result
    }
    const atom = (type: string, ...parts: Uint8Array[]) => {
      const data = join(...parts); return join(words(data.length + 8), new TextEncoder().encode(type), data)
    }
    const view = new DataView(bytes.buffer)
    const text = (offset: number) => new TextDecoder().decode(bytes.subarray(offset, offset + 4))
    const children = (start: number, end: number): { type: string; start: number; data: number; end: number }[] => {
      const result = []
      while (start < end) {
        const size32 = view.getUint32(start)
        const size = size32 === 1 ? Number(view.getBigUint64(start + 8)) : size32
        if (size < 8) throw new Error('Bad fixture atom')
        result.push({ type: text(start + 4), start, data: start + (size32 === 1 ? 16 : 8), end: start + size }); start += size
      }
      return result
    }
    const moov = children(0, bytes.length).find((box) => box.type === 'moov')!
    const movie = children(moov.data, moov.end)
    const mvhd = movie.find((box) => box.type === 'mvhd')!
    const scale = view.getUint32(mvhd.data + 12)
    const duration = options.seconds * scale
    let tcScale = 0, delta = 0
    const newMovie = movie.map((box) => {
      if (box.type !== 'trak') return bytes.slice(box.start, box.end)
      const track = children(box.data, box.end), mdia = track.find((item) => item.type === 'mdia')!
      const media = children(mdia.data, mdia.end), handler = media.find((item) => item.type === 'hdlr')!
      if (text(handler.data + 8) !== 'vide') return bytes.slice(box.start, box.end)
      const mdhd = media.find((item) => item.type === 'mdhd')!
      tcScale = view.getUint32(mdhd.data + 12)
      const minf = media.find((item) => item.type === 'minf')!
      const stbl = children(minf.data, minf.end).find((item) => item.type === 'stbl')!
      const stts = children(stbl.data, stbl.end).find((item) => item.type === 'stts')!
      delta = view.getUint32(stts.data + 12)
      return atom('trak', bytes.slice(box.data, box.end), atom('tref', atom('tmcd', words(99))))
    })
    const tc = atom('trak', atom('tkhd', words(3, 0, 0, 99, 0, duration), new Uint8Array(60)),
      atom('mdia', atom('mdhd', words(0, 0, 0, scale, duration, 0)), atom('hdlr', words(0, 0), new TextEncoder().encode('tmcd'), new Uint8Array(12)),
        atom('minf', atom('nmhd', words(0)), atom('dinf', atom('dref', words(0, 1), atom('url ', words(1)))),
          atom('stbl', atom('stsd', words(0, 1), atom('tmcd', words(0, 1, 0, 0, tcScale, delta), new Uint8Array([30, 0, 0, 0]))),
            atom('stts', words(0, 1, 1, duration)), atom('stsc', words(0, 1, 1, 1, 1)),
            atom('stsz', words(0, 4, 1)), atom('stco', words(0, 1, bytes.length + 8))))))
    const replacement = atom('moov', ...newMovie, tc)
    bytes.set(new TextEncoder().encode('free'), moov.start + 4)
    bytes = join(bytes, atom('mdat', words(options.timecode)), replacement)
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(binary)
}
