/**
 * Disposable Chromium lab for Issue #207. Not a product surface.
 * Close every VideoSample / AudioSample in finally. Integer-frame timestamps
 * only; seconds appear solely at the decoder boundary.
 */

import {
  ALL_FORMATS,
  AudioSampleSink,
  BufferSource,
  EncodedPacketSink,
  Input,
  VideoSampleSink,
} from 'mediabunny'

const FRAME_RATE = 30
const SEEK_FRAMES = Object.freeze([0, 15])

function errorMessage(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function closeSample(sample) {
  try { sample?.close?.() } catch { /* already closed */ }
}

async function describeTrack(track) {
  const kind = track.isVideoTrack() ? 'video' : track.isAudioTrack() ? 'audio' : track.type
  const codec = await track.getCodec()
  const native = await track.canDecode()
  return { kind, codec, nativeCanDecode: native }
}

async function seekAndDecode(track) {
  const kind = track.isVideoTrack() ? 'video' : 'audio'
  const sink = kind === 'video' ? new VideoSampleSink(track) : new AudioSampleSink(track)
  const frames = []
  let owned = 0
  try {
    for (const frame of SEEK_FRAMES) {
      const timestamp = frame / FRAME_RATE
      let sample = null
      try {
        sample = await sink.getSample(timestamp)
        if (sample) owned += 1
        frames.push({
          frame,
          requestedSeconds: timestamp,
          timestamp: sample?.timestamp ?? null,
          duration: sample?.duration ?? null,
          closed: false,
        })
      } catch (error) {
        frames.push({ frame, requestedSeconds: timestamp, error: errorMessage(error) })
      } finally {
        if (sample) {
          closeSample(sample)
          owned -= 1
          frames[frames.length - 1].closed = true
        }
      }
    }
    return {
      ok: frames.length === SEEK_FRAMES.length && frames.every((entry) => entry.closed === true),
      frames,
      ownedAfter: owned,
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error), ownedAfter: owned, frames }
  }
}

async function packetSeek(track) {
  const sink = new EncodedPacketSink(track)
  const points = []
  for (const frame of SEEK_FRAMES) {
    const timestamp = frame / FRAME_RATE
    try {
      const packet = await sink.getPacket(timestamp, { metadataOnly: true })
      points.push({
        frame,
        requestedSeconds: timestamp,
        timestamp: packet?.timestamp ?? null,
        type: packet?.type ?? null,
      })
    } catch (error) {
      points.push({ frame, requestedSeconds: timestamp, error: errorMessage(error) })
    }
  }
  return points
}

function avSync(video, audio) {
  if (!video || !audio) return { applicable: false }
  const pairs = []
  for (const frame of SEEK_FRAMES) {
    const requested = frame / FRAME_RATE
    const videoHit = video.frames?.find((entry) => entry.frame === frame)
    const audioHit = audio.frames?.find((entry) => entry.frame === frame)
    if (!videoHit || !audioHit || videoHit.timestamp == null || audioHit.timestamp == null) {
      pairs.push({ frame, ok: false, reason: 'missing-sample' })
      continue
    }
    const delta = Math.abs(videoHit.timestamp - audioHit.timestamp)
    pairs.push({
      frame,
      requestedSeconds: requested,
      videoTimestamp: videoHit.timestamp,
      audioTimestamp: audioHit.timestamp,
      deltaSeconds: delta,
      ok: delta <= (1 / FRAME_RATE) + 1e-6,
    })
  }
  return { applicable: true, withinOneFrame: pairs.every((pair) => pair.ok), pairs }
}

async function cancelDuringOpen(bytes) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) })
  const pending = input.getTracks()
  input.dispose()
  try {
    await pending
    return { rejected: false, disposed: input.disposed }
  } catch (error) {
    return { rejected: true, disposed: input.disposed, error: errorMessage(error) }
  }
}

export async function measureBytes(bytes, options = {}) {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const heapBefore = performance.memory?.usedJSHeapSize ?? null
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(bytes),
  })
  try {
    let canRead
    try {
      canRead = await input.canRead()
    } catch (error) {
      return {
        canRead: false,
        failClosed: true,
        error: errorMessage(error),
        durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
      }
    }
    if (!canRead) {
      return {
        canRead: false,
        format: null,
        tracks: [],
        durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
      }
    }
    const format = await input.getFormat()
    const tracks = await input.getTracks()
    const described = []
    for (const track of tracks) described.push(await describeTrack(track))

    const video = tracks.find((track) => track.isVideoTrack())
    const audio = tracks.find((track) => track.isAudioTrack())
    const videoDecode = video && described.find((track) => track.kind === 'video')?.nativeCanDecode
      ? await seekAndDecode(video)
      : { ok: false, skipped: !video ? 'no-video' : 'not-decodable' }
    const audioDecode = audio && described.find((track) => track.kind === 'audio')?.nativeCanDecode
      ? await seekAndDecode(audio)
      : { ok: false, skipped: !audio ? 'no-audio' : 'not-decodable' }

    const cancel = options.cancel ? await cancelDuringOpen(bytes.slice(0)) : null
    return {
      canRead: true,
      format: { name: format.name, mimeType: format.mimeType },
      tracks: described,
      packetSeek: {
        video: video ? await packetSeek(video) : null,
        audio: audio ? await packetSeek(audio) : null,
      },
      decode: {
        video: videoDecode,
        audio: audioDecode,
        ok: (videoDecode.ok === true || videoDecode.skipped) && (audioDecode.ok === true || audioDecode.skipped)
          && (videoDecode.ok === true || audioDecode.ok === true),
      },
      avSync: avSync(videoDecode, audioDecode),
      cancel,
      ownedAfter: {
        video: videoDecode.ownedAfter ?? 0,
        audio: audioDecode.ownedAfter ?? 0,
      },
      heapBefore,
      heapAfter: performance.memory?.usedJSHeapSize ?? null,
      durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
    }
  } catch (error) {
    return {
      canRead: false,
      error: errorMessage(error),
      durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
    }
  } finally {
    input.dispose()
  }
}

export async function measureEncoders() {
  const videoConfigs = [
    { id: 'avc', codec: 'avc1.42001e', width: 320, height: 180, bitrate: 100_000, framerate: 30 },
    { id: 'vp9', codec: 'vp09.00.10.08', width: 320, height: 180, bitrate: 100_000, framerate: 30 },
    { id: 'av1', codec: 'av01.0.04M.08', width: 320, height: 180, bitrate: 100_000, framerate: 30 },
    { id: 'hevc', codec: 'hvc1.1.6.L93.B0', width: 320, height: 180, bitrate: 100_000, framerate: 30 },
    { id: 'prores', codec: 'apcn', width: 320, height: 180, bitrate: 100_000, framerate: 30 },
  ]
  const audioConfigs = [
    { id: 'aac', codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 },
    { id: 'opus', codec: 'opus', numberOfChannels: 2, sampleRate: 48000 },
    { id: 'ac3', codec: 'ac-3', numberOfChannels: 2, sampleRate: 48000 },
  ]
  const video = []
  for (const config of videoConfigs) {
    if (typeof VideoEncoder === 'undefined') {
      video.push({ ...config, supported: false, reason: 'VideoEncoder-undefined' })
      continue
    }
    try {
      const { id, ...requested } = config
      const support = await VideoEncoder.isConfigSupported(requested)
      video.push({ id, codec: config.codec, supported: support.supported === true })
    } catch (error) {
      video.push({ id: config.id, codec: config.codec, supported: false, error: errorMessage(error) })
    }
  }
  const audio = []
  for (const config of audioConfigs) {
    if (typeof AudioEncoder === 'undefined') {
      audio.push({ ...config, supported: false, reason: 'AudioEncoder-undefined' })
      continue
    }
    try {
      const { id, ...requested } = config
      const support = await AudioEncoder.isConfigSupported(requested)
      audio.push({ id, codec: config.codec, supported: support.supported === true })
    } catch (error) {
      audio.push({ id: config.id, codec: config.codec, supported: false, error: errorMessage(error) })
    }
  }
  return { video, audio, localEncoderFallbackAttempted: false }
}

export async function measureExistingFallbacks(proresBytes, ac3Bytes) {
  const before = {
    prores: await measureBytes(proresBytes),
    ac3: await measureBytes(ac3Bytes),
  }
  const { registerProresDecoder } = await import('@mediabunny/prores')
  const { registerAc3Decoder } = await import('@mediabunny/ac3')
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
  registerProresDecoder()
  registerAc3Decoder()
  const compileMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started
  const after = {
    prores: await measureBytes(proresBytes),
    ac3: await measureBytes(ac3Bytes),
  }
  return {
    compileMs,
    direct: before,
    fallback: after,
    encoderRegistration: false,
  }
}

export async function hostFacts() {
  const hevc = typeof VideoDecoder === 'undefined'
    ? { supported: false }
    : await VideoDecoder.isConfigSupported({
      codec: 'hvc1.1.6.L93.B0',
      codedWidth: 320,
      codedHeight: 180,
    }).catch((error) => ({ supported: false, error: errorMessage(error) }))
  const av1 = typeof VideoDecoder === 'undefined'
    ? { supported: false }
    : await VideoDecoder.isConfigSupported({
      codec: 'av01.0.04M.08',
      codedWidth: 320,
      codedHeight: 180,
    }).catch((error) => ({ supported: false, error: errorMessage(error) }))
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    webCodecs: {
      VideoDecoder: typeof VideoDecoder !== 'undefined',
      AudioDecoder: typeof AudioDecoder !== 'undefined',
      VideoEncoder: typeof VideoEncoder !== 'undefined',
      AudioEncoder: typeof AudioEncoder !== 'undefined',
    },
    hevcHardwareObservation: hevc.supported === true,
    av1HardwareObservation: av1.supported === true,
  }
}
