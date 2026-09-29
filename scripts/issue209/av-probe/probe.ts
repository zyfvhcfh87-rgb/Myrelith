/**
 * Disposable Issue #209 Steps 13–15 probe: drives the production capture worker
 * with a real (or Chromium fake) camera/microphone or display source, then
 * reopens the fragmented MP4 with Mediabunny and reports timing facts only.
 * Query: ?mode=camera|screen&seconds=N&crash=1&audio=0|1&mic=1 (screen + microphone)
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import type { AvCaptureRequest, AvCaptureWorkerMessage } from '../../../src/pipeline/avCaptureProtocol'
import { calibrateVideoClock } from '../../../src/app/avClockCalibration'

type Probe = Record<string, unknown>
const params = new URLSearchParams(location.search)
const mode = (params.get('mode') ?? 'camera') as 'camera' | 'screen'
const seconds = Number(params.get('seconds') ?? '8')
const crash = params.get('crash') === '1'
const wantAudio = params.get('audio') !== '0'
const withMic = params.get('mic') === '1'
const analyzeSync = params.get('analyze') === '1'

/** Flash (video luminance rise) and beep (audio onset) times in the file, paired. */
async function analyze(file: File): Promise<Probe> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const videoTrack = await input.getPrimaryVideoTrack()
  const audioTrack = await input.getPrimaryAudioTrack()
  if (!videoTrack || !audioTrack) return { error: 'missing track' }
  const canvas = new OffscreenCanvas(32, 18)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const flashes: number[] = []
  let bright = false
  for await (const sample of new VideoSampleSink(videoTrack).samples()) {
    try {
      sample.draw(context, 0, 0, 32, 18)
      const pixels = context.getImageData(0, 0, 32, 18).data
      let sum = 0
      for (let index = 0; index < pixels.length; index += 4) sum += pixels[index]!
      const mean = sum / (pixels.length / 4)
      if (!bright && mean > 128) flashes.push(sample.timestamp)
      bright = mean > 128
    } finally { sample.close() }
  }
  const beeps: number[] = []
  let last = -Infinity
  let peak = 0
  for await (const sample of new AudioSampleSink(audioTrack).samples()) {
    try {
      const frames = sample.numberOfFrames
      const data = new Float32Array(frames)
      sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' })
      for (let index = 0; index < frames; index++) {
        peak = Math.max(peak, Math.abs(data[index]!))
        const time = sample.timestamp + index / sample.sampleRate
        if (Math.abs(data[index]!) > 0.1 && time - last > 0.5) { beeps.push(time); last = time }
        else if (Math.abs(data[index]!) > 0.1) last = time
      }
    } finally { sample.close() }
  }
  const offsetsMs = beeps.map((beep) => {
    const nearest = flashes.reduce((best, flash) => Math.abs(flash - beep) < Math.abs(best - beep) ? flash : best, Infinity)
    return Number(((beep - nearest) * 1000).toFixed(1))
  }).filter((value) => Math.abs(value) < 500)
  const sorted = [...offsetsMs].sort((a, b) => a - b)
  return { flashes: flashes.length, beeps: beeps.length, audioPeak: Number(peak.toFixed(4)), audioMinusVideoMs: offsetsMs,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? null, spreadMs: sorted.length ? sorted.at(-1)! - sorted[0]! : null }
}

function workerRpc() {
  const worker = new Worker(new URL('/src/workers/av-capture.worker.ts', location.origin), { type: 'module' })
  let next = 0
  const waiting = new Map<number, (message: AvCaptureWorkerMessage) => void>()
  const events: AvCaptureWorkerMessage[] = []
  worker.onmessage = ({ data }: MessageEvent<AvCaptureWorkerMessage>) => {
    if ('requestId' in data) { waiting.get(data.requestId)?.(data); waiting.delete(data.requestId) }
    else events.push(data)
  }
  const send = (request: Omit<AvCaptureRequest, 'requestId'>, transfer: Transferable[] = []) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = ++next
      waiting.set(requestId, (message) => 'error' in message
        ? reject(new Error(`${message.error.name}: ${message.error.message}`))
        : resolve((message as { result: Record<string, unknown> }).result))
      worker.postMessage({ ...request, requestId }, transfer)
    })
  return { worker, send, events }
}

async function acquire(): Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null; notes: Probe }> {
  if (mode === 'camera') {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false })
    const [video] = stream.getVideoTracks()
    return { video: video!, audio: stream.getAudioTracks()[0] ?? null,
      notes: { videoLabel: video!.label, audioLabel: stream.getAudioTracks()[0]?.label ?? null, settings: video!.getSettings() } }
  }
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30 } },
    // Captured tab audio is recorded but not played on this device.
    audio: wantAudio ? { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false,
      autoGainControl: false } as MediaTrackConstraints : false })
  const [video] = display.getVideoTracks()
  let audio = display.getAudioTracks()[0] ?? null
  const notes: Probe = { surface: video!.getSettings().displaySurface ?? null, displayAudio: audio !== null,
    settings: video!.getSettings() }
  if (withMic) {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false } })
    if (audio) { notes.bothAudioSources = true; audio.stop() }
    audio = mic.getAudioTracks()[0] ?? null
    notes.micLabel = audio?.label ?? null
  }
  return { video: video!, audio, notes }
}

async function reopen(file: File): Promise<Probe> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const result: Probe = { format: (await input.getFormat()).name, duration: await input.computeDuration() }
  for (const track of await input.getTracks()) {
    const first = await track.getFirstTimestamp()
    const duration = await track.computeDuration()
    const stats = await track.computePacketStats(2_000)
    result[track.type] = { codec: track.codec, first, duration, packets: stats.packetCount,
      averagePacketRate: Number(stats.averagePacketRate.toFixed(2)) }
  }
  return result
}

async function run(): Promise<Probe> {
  const id = `capture_probe_${crypto.randomUUID()}`
  const { video, audio, notes } = await acquire()
  const rpc = workerRpc()
  const startedAt = performance.now()
  const Processor = (globalThis as unknown as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream } })
    .MediaStreamTrackProcessor
  if (!Processor) throw new Error('MediaStreamTrackProcessor is unavailable on the page')
  const calibration = await calibrateVideoClock(video)
  const videoStream = new Processor({ track: video }).readable
  const audioStream = audio ? new Processor({ track: audio }).readable : null
  const settings = video.getSettings()
  const audioSettings = audio?.getSettings()
  const start = await rpc.send({ type: 'start', id, mode, video: videoStream, audio: audioStream,
    videoSettings: { width: settings.width ?? 1280, height: settings.height ?? 720 },
    audioSettings: audio ? { numberOfChannels: audioSettings?.channelCount ?? 1, sampleRate: audioSettings?.sampleRate ?? 48_000 } : null,
    videoClockOffsetUs: calibration.offsetUs, diagnostics: true } as never, [videoStream, ...(audioStream ? [audioStream] : [])] as unknown as Transferable[])
  const heap: number[] = []
  const deadline = startedAt + seconds * 1000
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    heap.push((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)
  }
  const progress = [...rpc.events].reverse().find((event) => 'type' in event && event.type === 'progress')
  let stop: Probe | null = null
  let recovery: Probe | null = null
  let rpcForFile = rpc
  if (crash) {
    rpc.worker.terminate()
    rpcForFile = workerRpc()
    recovery = await rpcForFile.send({ type: 'recover', id })
  } else {
    stop = await rpc.send({ type: 'stop' }).catch((cause: unknown) => ({ error: String(cause),
      diagnostic: rpc.events.find((event) => 'type' in event && event.type === 'diagnostic-clock') ?? null }))
    if ('error' in stop) {
      video.stop(); audio?.stop(); rpc.worker.terminate()
      return { mode, notes, calibration, start, failedStop: stop }
    }
  }
  video.stop(); audio?.stop()
  const { file } = await rpcForFile.send({ type: 'file', id }) as { file: File }
  const reopened = await reopen(file)
  const sync = analyzeSync ? await analyze(file) : null
  await rpcForFile.send({ type: 'discard-id', id })
  const listing = await rpcForFile.send({ type: 'list' })
  rpcForFile.worker.terminate()
  if (!crash) rpc.worker.terminate()
  return { mode, seconds, crash, notes, calibration, start, lastProgress: progress, stop, recovery, fileBytes: file.size, reopened, sync,
    selfStops: rpc.events.filter((event) => 'type' in event && event.type === 'self-stop'),
    heapMiB: heap.map((value) => Number((value / 1_048_576).toFixed(1))), remainingDrafts: listing }
}

const out = document.querySelector('#out')!
document.querySelector('#run')!.addEventListener('click', () => {
  void run().then((result) => {
    ;(window as unknown as { __probe: Probe }).__probe = result
    out.textContent = JSON.stringify(result, null, 2)
  }, (cause: unknown) => {
    ;(window as unknown as { __probe: Probe }).__probe = { error: String(cause) }
    out.textContent = String(cause)
  })
})
