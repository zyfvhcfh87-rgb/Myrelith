/**
 * Measures the constant between a video track's processor frame stamps and
 * page time (see domain/avClockBridge). Two clones of the track are used: one
 * plays in a tiny transparent `<video>` for requestVideoFrameCallback
 * `captureTime`, one is read by a MediaStreamTrackProcessor for stamps. Both
 * clones are stopped and the element removed on every path.
 */
import { estimateAvClockBridge } from '../domain/avClockBridge'

export interface AvVideoClockCalibration {
  /** Subtract from video frame stamps to reach page time (µs). */
  readonly offsetUs: number
  /**
   * `capture-time`: exact bridge from browser capture times.
   * `delivery-estimate`: the browser gave no capture times; frames may map late
   * by their minimum delivery latency, and review says so.
   */
  readonly method: 'capture-time' | 'delivery-estimate'
  readonly pairs: number
  readonly spreadUs: number
}

type Processor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }

export function mediaStreamTrackProcessor(): Processor | null {
  return (globalThis as unknown as { MediaStreamTrackProcessor?: Processor }).MediaStreamTrackProcessor ?? null
}

/**
 * Screens deliver frames only when content changes, so calibration keeps
 * reading until enough frames paired up or `maxMs` passes (then estimates).
 */
export async function calibrateVideoClock(track: MediaStreamTrack, minMs = 600, maxMs = 4_000): Promise<AvVideoClockCalibration> {
  const Processor = mediaStreamTrackProcessor()
  if (!Processor) throw new Error('This browser cannot read camera or screen frames')
  const forVideo = track.clone()
  const forStamps = track.clone()
  const element = document.createElement('video')
  element.muted = true
  element.playsInline = true
  element.setAttribute('aria-hidden', 'true')
  element.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1'
  element.srcObject = new MediaStream([forVideo])
  const captures: number[] = []
  const stamps: number[] = []
  const deliveries: number[] = []
  let done = false
  let pending: Promise<ReadableStreamReadResult<VideoFrame>> | null = null
  const reader = new Processor({ track: forStamps }).readable.getReader()
  try {
    document.body.append(element)
    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (typeof metadata.captureTime === 'number') captures.push(Math.round(metadata.captureTime * 1000))
      if (!done) element.requestVideoFrameCallback(onFrame)
    }
    if ('requestVideoFrameCallback' in element) element.requestVideoFrameCallback(onFrame)
    const started = performance.now()
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), maxMs))
    // play() can stall (e.g. a hidden page); it must not extend calibration.
    await Promise.race([element.play().catch(() => {}), timeout])
    while (performance.now() - started < maxMs) {
      const read = reader.read()
      const next = await Promise.race([read, timeout])
      if (!next) {
        // The timeout won: a frame may still arrive for this read; close it.
        pending = read
        break
      }
      if (next.done) break
      deliveries.push(Math.round(performance.now() * 1000))
      stamps.push(next.value.timestamp)
      next.value.close()
      if (performance.now() - started >= minMs && estimateAvClockBridge(stamps, captures, deliveries)) break
    }
  } finally {
    done = true
    void reader.cancel().catch(() => {})
    void pending?.then((result) => result.value?.close(), () => {})
    forVideo.stop()
    forStamps.stop()
    element.srcObject = null
    element.remove()
  }
  const bridge = estimateAvClockBridge(stamps, captures, deliveries)
  if (bridge) return { offsetUs: bridge.offsetUs, method: 'capture-time', pairs: bridge.pairs, spreadUs: bridge.spreadUs }
  if (stamps.length === 0) throw new Error('The video source delivered no frames')
  // Fallback: a frame cannot arrive before it was captured, so the largest
  // (stamp − delivery) is the offset minus the fastest delivery latency.
  let best = -Infinity
  for (let index = 0; index < stamps.length; index++) best = Math.max(best, stamps[index]! - deliveries[index]!)
  const spread = stamps.reduce((max, stamp, index) => Math.max(max, best - (stamp - deliveries[index]!)), 0)
  return { offsetUs: best, method: 'delivery-estimate', pairs: 0, spreadUs: spread }
}
