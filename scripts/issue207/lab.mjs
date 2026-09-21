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
import { playbackWindowStart } from './protocol.mjs'

const FRAME_RATE = 30
const SEEK_FRAMES = Object.freeze([0, 15])
const SEQUENTIAL_CAP = 64
const FIXTURE_RGB = Object.freeze([0x31, 0x5b, 0x7d])
const COLOR_TOLERANCE = 40
const SILENCE_PEAK = 0.05

function errorMessage(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function closeSample(sample) {
  try { sample?.close?.() } catch { /* already closed */ }
}

function heapBytes() {
  const value = performance.memory?.usedJSHeapSize
  return typeof value === 'number' ? value : null
}

function isVideoSample(sample) {
  return typeof sample?.draw === 'function'
}

async function inspectVideo(sample) {
  const canvas = new OffscreenCanvas(1, 1)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return { kind: 'video', error: 'no-2d-context' }
  sample.draw(context, 0, 0, 1, 1)
  const pixel = context.getImageData(0, 0, 1, 1).data
  const rgb = [pixel[0], pixel[1], pixel[2]]
  const delta = rgb.map((value, index) => Math.abs(value - FIXTURE_RGB[index]))
  return {
    kind: 'video',
    rgb,
    alpha: pixel[3],
    matchesFixtureColor: delta.every((value) => value <= COLOR_TOLERANCE),
    maxChannelDelta: Math.max(...delta),
  }
}

function inspectAudio(sample) {
  const frames = Math.min(sample.numberOfFrames, 256)
  const data = new Float32Array(frames)
  sample.copyTo(data, {
    planeIndex: 0,
    format: 'f32-planar',
    frameCount: frames,
  })
  let peak = 0
  let finite = true
  for (const value of data) {
    if (!Number.isFinite(value)) finite = false
    else peak = Math.max(peak, Math.abs(value))
  }
  return {
    kind: 'audio',
    finite,
    peak,
    frames,
    nearSilence: finite && peak <= SILENCE_PEAK,
  }
}

async function inspectSample(sample) {
  try {
    if (isVideoSample(sample)) return await inspectVideo(sample)
    return inspectAudio(sample)
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

function knownBytes(sample) {
  if (isVideoSample(sample)) {
    const width = sample.displayWidth || sample.codedWidth || 0
    const height = sample.displayHeight || sample.codedHeight || 0
    return { rgba: width * height * 4, pcm: 0 }
  }
  const frames = sample.numberOfFrames || 0
  const channels = sample.numberOfChannels || 0
  return { rgba: 0, pcm: frames * channels * 4 }
}

async function trackWindowStart(track) {
  try {
    const first = await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true })
    return playbackWindowStart(first?.timestamp)
  } catch {
    return 0
  }
}

async function sequentialDecode(sink, windowStart) {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const iterator = sink.samples(windowStart, windowStart + 1)
  let count = 0
  let owned = 0
  let audioFrames = 0
  let closedRgba = 0
  let closedPcm = 0
  let peakOwnedRgba = 0
  let firstTimestamp = null
  let lastTimestamp = null
  let correctness = null
  let heapPeak = heapBytes()
  try {
    while (count < SEQUENTIAL_CAP) {
      const next = await iterator.next()
      if (next.done) break
      const sample = next.value
      if (!sample) continue
      owned += 1
      try {
        count += 1
        if (firstTimestamp == null) firstTimestamp = sample.timestamp
        lastTimestamp = sample.timestamp
        if (isVideoSample(sample)) {
          const bytes = knownBytes(sample)
          peakOwnedRgba = Math.max(peakOwnedRgba, bytes.rgba)
          closedRgba += bytes.rgba
        } else {
          audioFrames += sample.numberOfFrames || 0
          closedPcm += knownBytes(sample).pcm
        }
        if (count === 1) correctness = await inspectSample(sample)
        const heap = heapBytes()
        if (heap != null && (heapPeak == null || heap > heapPeak)) heapPeak = heap
      } finally {
        closeSample(sample)
        owned -= 1
      }
    }
    const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started
    return {
      ok: count > 0 && owned === 0,
      count,
      audioFrames,
      capped: count >= SEQUENTIAL_CAP,
      ownedAfter: owned,
      firstTimestamp,
      lastTimestamp,
      durationMs,
      samplesPerSecond: durationMs > 0 ? (count * 1000) / durationMs : null,
      audioFramesPerSecond: durationMs > 0 ? (audioFrames * 1000) / durationMs : null,
      closedRgbaBytes: closedRgba,
      closedPcmBytes: closedPcm,
      peakOwnedRgbaBytes: peakOwnedRgba,
      heapPeak,
      correctness,
      windowStart,
    }
  } catch (error) {
    return {
      ok: false,
      count,
      audioFrames,
      ownedAfter: owned,
      error: errorMessage(error),
      correctness,
      durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
    }
  } finally {
    try { await iterator.return?.() } catch { /* decoder teardown */ }
  }
}

async function describeTrack(track) {
  const kind = track.isVideoTrack() ? 'video' : track.isAudioTrack() ? 'audio' : track.type
  const codec = await track.getCodec()
  const native = await track.canDecode()
  return { kind, codec, nativeCanDecode: native }
}

async function seekAndDecode(track, windowStart) {
  const kind = track.isVideoTrack() ? 'video' : 'audio'
  const sink = kind === 'video' ? new VideoSampleSink(track) : new AudioSampleSink(track)
  const frames = []
  let owned = 0
  try {
    for (const frame of SEEK_FRAMES) {
      const timestamp = windowStart + frame / FRAME_RATE
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
      windowStart,
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error), ownedAfter: owned, frames }
  }
}

async function packetSeek(track, windowStart) {
  const sink = new EncodedPacketSink(track)
  const points = []
  for (const frame of SEEK_FRAMES) {
    const timestamp = windowStart + frame / FRAME_RATE
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
  if (!video?.frames || !audio?.frames || video.skipped || audio.skipped) {
    return { applicable: false, reason: video?.skipped || audio.skipped || 'missing-leg' }
  }
  const pairs = []
  for (const frame of SEEK_FRAMES) {
    const videoHit = video.frames?.find((entry) => entry.frame === frame)
    const audioHit = audio.frames?.find((entry) => entry.frame === frame)
    const requested = videoHit?.requestedSeconds ?? audioHit?.requestedSeconds ?? frame / FRAME_RATE
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

async function audioClockFrame(videoTrack, windowStart) {
  const context = new AudioContext()
  let videoSample = null
  try {
    if (context.state === 'suspended') await context.resume().catch(() => {})
    const origin = context.currentTime
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    const elapsed = context.currentTime - origin
    const derivedFrame = Math.max(0, Math.floor(elapsed * FRAME_RATE))
    const requestedSeconds = windowStart + derivedFrame / FRAME_RATE
    videoSample = await new VideoSampleSink(videoTrack).getSample(requestedSeconds)
    const videoTimestamp = videoSample?.timestamp ?? null
    const delta = videoTimestamp == null ? null : Math.abs(videoTimestamp - requestedSeconds)
    return {
      applicable: true,
      productPlayback: false,
      clockAdvanced: elapsed > 0.02,
      audioContextState: context.state,
      elapsedSeconds: elapsed,
      derivedFrame,
      windowStart,
      requestedSeconds,
      videoTimestamp,
      withinOneFrame: delta != null && delta <= (1 / FRAME_RATE) + 1e-4,
    }
  } catch (error) {
    return { applicable: false, productPlayback: false, reason: errorMessage(error) }
  } finally {
    closeSample(videoSample)
    await context.close().catch(() => {})
  }
}

export async function cancelDuringDecode(bytes) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) })
  let owned = 0
  let iterator = null
  try {
    const tracks = await input.getTracks()
    const video = tracks.find((track) => track.isVideoTrack())
    const audio = tracks.find((track) => track.isAudioTrack())
    const track = video ?? audio
    if (!track) return { skipped: 'no-track', disposed: input.disposed, ownedAfter: 0 }
    if (await track.canDecode() !== true) {
      return { skipped: 'not-decodable', disposed: input.disposed, ownedAfter: 0 }
    }
    const sink = video ? new VideoSampleSink(video) : new AudioSampleSink(audio)
    const windowStart = await trackWindowStart(track)
    iterator = sink.samples(windowStart, windowStart + 1)
    const first = await iterator.next()
    if (first.value) {
      owned += 1
      closeSample(first.value)
      owned -= 1
    }
    input.dispose()
    let rejected = false
    let error = null
    try {
      const next = await iterator.next()
      if (next.value) {
        owned += 1
        closeSample(next.value)
        owned -= 1
      }
    } catch (caught) {
      rejected = true
      error = errorMessage(caught)
    }
    return { rejected, disposed: input.disposed === true, ownedAfter: owned, error, started: true }
  } catch (error) {
    return {
      rejected: true,
      disposed: input.disposed === true,
      ownedAfter: owned,
      error: errorMessage(error),
    }
  } finally {
    try { await iterator?.return?.() } catch { /* decoder teardown */ }
    input.dispose()
  }
}

export async function measureBytes(bytes, options = {}) {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const heapBefore = heapBytes()
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
    const videoNative = described.find((track) => track.kind === 'video')?.nativeCanDecode === true
    const audioNative = described.find((track) => track.kind === 'audio')?.nativeCanDecode === true
    const videoStart = video ? await trackWindowStart(video) : 0
    const audioStart = audio ? await trackWindowStart(audio) : 0
    const videoDecode = video && videoNative
      ? await seekAndDecode(video, videoStart)
      : { ok: false, skipped: !video ? 'no-video' : 'not-decodable', windowStart: videoStart }
    const audioDecode = audio && audioNative
      ? await seekAndDecode(audio, audioStart)
      : { ok: false, skipped: !audio ? 'no-audio' : 'not-decodable', windowStart: audioStart }
    const videoSequential = video && videoNative
      ? await sequentialDecode(new VideoSampleSink(video), videoStart)
      : { ok: false, skipped: !video ? 'no-video' : 'not-decodable', windowStart: videoStart }
    const audioSequential = audio && audioNative
      ? await sequentialDecode(new AudioSampleSink(audio), audioStart)
      : { ok: false, skipped: !audio ? 'no-audio' : 'not-decodable', windowStart: audioStart }
    const audioClock = options.audioClock && video && audio && videoNative
      ? await audioClockFrame(video, videoStart)
      : { applicable: false, reason: options.audioClock ? 'missing-decodable-video' : 'not-requested', productPlayback: false }

    const cancel = options.cancel ? await cancelDuringOpen(bytes.slice(0)) : null
    const heapAfter = heapBytes()
    const heapPeak = [heapBefore, heapAfter, videoSequential.heapPeak, audioSequential.heapPeak]
      .filter((value) => typeof value === 'number')
      .reduce((peak, value) => Math.max(peak, value), heapBefore ?? 0)
    return {
      canRead: true,
      format: { name: format.name, mimeType: format.mimeType },
      tracks: described,
      packetSeek: {
        video: video ? await packetSeek(video, videoStart) : null,
        audio: audio ? await packetSeek(audio, audioStart) : null,
      },
      decode: {
        video: videoDecode,
        audio: audioDecode,
        ok: (videoDecode.ok === true || videoDecode.skipped) && (audioDecode.ok === true || audioDecode.skipped)
          && (videoDecode.ok === true || audioDecode.ok === true),
      },
      sequential: { video: videoSequential, audio: audioSequential },
      correctness: {
        video: videoSequential.correctness ?? null,
        audio: audioSequential.correctness ?? null,
      },
      throughput: {
        videoSamplesPerSecond: videoSequential.samplesPerSecond ?? null,
        audioSamplesPerSecond: audioSequential.samplesPerSecond ?? null,
        audioFramesPerSecond: audioSequential.audioFramesPerSecond ?? null,
        videoDurationMs: videoSequential.durationMs ?? null,
        audioDurationMs: audioSequential.durationMs ?? null,
      },
      knownResources: {
        peakOwnedRgbaBytes: Math.max(videoSequential.peakOwnedRgbaBytes ?? 0, 0),
        closedRgbaBytes: videoSequential.closedRgbaBytes ?? 0,
        closedPcmBytes: audioSequential.closedPcmBytes ?? 0,
        nativeRss: 'unmeasured',
      },
      avSync: avSync(videoDecode, audioDecode),
      audioClock,
      cancel,
      ownedAfter: {
        video: (videoDecode.ownedAfter ?? 0) + (videoSequential.ownedAfter ?? 0),
        audio: (audioDecode.ownedAfter ?? 0) + (audioSequential.ownedAfter ?? 0),
      },
      heapBefore,
      heapAfter,
      heapPeak: heapBefore == null ? null : heapPeak,
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
    registerMs: compileMs,
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
