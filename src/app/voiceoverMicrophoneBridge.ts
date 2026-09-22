/** Connects a supplied microphone stream to the bounded WAV writer. */
import { VOICEOVER_WAV_LIMITS, type VoiceoverDraftProgress } from '../pipeline/voiceoverWavDraft'
import type { VoiceoverCaptureControl, VoiceoverCaptureWorkletMessage } from '../pipeline/voiceoverCaptureProtocol'

export interface VoiceoverCaptureWriter {
  append(buffer: ArrayBuffer): Promise<VoiceoverDraftProgress>
  stop(): Promise<VoiceoverDraftProgress>
  close(): void
}

export interface VoiceoverMicrophoneOptions {
  context: AudioContext
  stream: MediaStream
  writer: VoiceoverCaptureWriter
  startFrame: number
  onBatch?: (batch: { sequence: number; startFrame: number; frames: number }) => void
  onOverrun?: (atFrame: number) => void
}

export interface VoiceoverMicrophoneResult {
  reason: 'stopped' | 'overrun'
  startFrame: number
  endFrame: number
  samples: number
  batches: number
  peakInFlightBytes: number
  progress: VoiceoverDraftProgress
}

const loadedWorklets = new WeakMap<AudioContext, Promise<void>>()

async function loadWorklet(context: AudioContext): Promise<void> {
  let loaded = loadedWorklets.get(context)
  if (!loaded) {
    loaded = context.audioWorklet.addModule(new URL('../worklets/voiceover-capture.worklet.js', import.meta.url).href)
    loadedWorklets.set(context, loaded)
    void loaded.catch(() => loadedWorklets.delete(context))
  }
  await loaded
}

function validFrame(frame: number): boolean { return Number.isSafeInteger(frame) && frame >= 0 }

export async function connectVoiceoverMicrophone(options: VoiceoverMicrophoneOptions) {
  const { context, stream, writer, startFrame } = options
  if (context.sampleRate !== VOICEOVER_WAV_LIMITS.sampleRate) throw new RangeError('Voiceover requires a 48 kHz AudioContext')
  if (!validFrame(startFrame)) throw new RangeError('Recording start must be a safe sample frame')
  if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
    throw new Error('A live microphone audio track is required')
  }
  await loadWorklet(context)

  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'myrelith-voiceover-capture-v1', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit', processorOptions: { startFrame },
  })
  // Both the processor and this guard output silence. Playback/count-in remain
  // independent paths on the same AudioContext.
  const silentOutput = context.createGain()
  silentOutput.gain.value = 0

  let settled = false
  let terminal: { reason: 'stopped' | 'overrun'; endFrame: number } | null = null
  let finishing = false
  let stopRequested = false
  let nextFrame = startFrame
  let nextSequence = 1
  let pendingBytes = 0
  let peakInFlightBytes = 0
  let batches = 0
  let resolveFinished!: (value: VoiceoverMicrophoneResult) => void
  let rejectFinished!: (cause: Error) => void
  const finished = new Promise<VoiceoverMicrophoneResult>((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })

  function disconnectGraph(): void {
    node.port.onmessage = null
    node.onprocessorerror = null
    node.port.close()
    source.disconnect()
    node.disconnect()
    silentOutput.disconnect()
  }

  function fail(cause: unknown): void {
    if (settled) return
    settled = true
    const error = cause instanceof Error ? cause : new Error(String(cause))
    try { node.port.postMessage({ type: 'abort' } satisfies VoiceoverCaptureControl) } catch { /* Port may already be closed. */ }
    disconnectGraph()
    try { writer.close() } catch { /* Preserve the capture failure. */ }
    rejectFinished(error)
  }

  function maybeFinish(): void {
    if (!terminal || pendingBytes !== 0 || finishing || settled) return
    finishing = true
    void writer.stop().then((progress) => {
      if (settled) return
      const expectedBytes = (terminal!.endFrame - startFrame) * 2
      if (progress.pcmBytes !== expectedBytes || progress.committedBytes !== expectedBytes) {
        fail(new Error('Recording writer sample count differs from the worklet'))
        return
      }
      const result: VoiceoverMicrophoneResult = {
        reason: terminal!.reason, startFrame, endFrame: terminal!.endFrame,
        samples: terminal!.endFrame - startFrame, batches, peakInFlightBytes, progress,
      }
      settled = true
      disconnectGraph()
      resolveFinished(result)
    }, fail)
  }

  function receive(message: VoiceoverCaptureWorkletMessage): void {
    if (settled) return
    if (message.type === 'batch') {
      if (terminal || message.sequence !== nextSequence || message.startFrame !== nextFrame ||
        !Number.isSafeInteger(message.frames) || message.frames < 1 ||
        message.frames > VOICEOVER_WAV_LIMITS.batchBytes / 2 ||
        !(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength !== message.frames * 2) {
        fail(new Error('Recording worklet returned a discontinuous or invalid batch'))
        return
      }
      const bytes = message.buffer.byteLength
      if (pendingBytes + bytes > VOICEOVER_WAV_LIMITS.inFlightBytes) {
        fail(new Error('Recording bridge exceeded its transfer limit'))
        return
      }
      nextFrame += message.frames
      nextSequence++
      batches++
      pendingBytes += bytes
      peakInFlightBytes = Math.max(peakInFlightBytes, pendingBytes)
      try {
        options.onBatch?.({ sequence: message.sequence, startFrame: message.startFrame, frames: message.frames })
        const accepted = writer.append(message.buffer)
        void accepted.then(() => {
          if (settled) return
          pendingBytes -= bytes
          try { node.port.postMessage({ type: 'ack', sequence: message.sequence } satisfies VoiceoverCaptureControl) }
          catch (cause) { fail(cause); return }
          maybeFinish()
        }, fail)
      } catch (cause) { fail(cause) }
      return
    }
    if (message.type === 'error') {
      fail(new Error(`${message.reason} at sample frame ${message.atFrame}`))
      return
    }
    if (terminal || message.endFrame !== nextFrame || message.endFrame < startFrame) {
      fail(new Error('Recording worklet ended at an unexpected sample frame'))
      return
    }
    terminal = { reason: message.type, endFrame: message.endFrame }
    if (message.type === 'overrun') {
      try { options.onOverrun?.(message.endFrame) } catch (cause) { fail(cause); return }
    }
    maybeFinish()
  }

  node.port.onmessage = ({ data }: MessageEvent<VoiceoverCaptureWorkletMessage>) => receive(data)
  node.onprocessorerror = () => fail(new Error('Microphone capture processor failed'))
  try {
    source.connect(node)
    node.connect(silentOutput)
    silentOutput.connect(context.destination)
  } catch (cause) {
    disconnectGraph()
    throw cause
  }

  return {
    /** For graph inspection and optional bounded meters; never route to speakers. */
    outputNode: node,
    finished,
    stop(atFrame?: number): Promise<VoiceoverMicrophoneResult> {
      if (settled || terminal) return finished
      if (atFrame !== undefined && (!validFrame(atFrame) || atFrame < startFrame)) {
        throw new RangeError('Recording stop must be at or after its start frame')
      }
      if (!stopRequested) {
        stopRequested = true
        try { node.port.postMessage({ type: 'stop', atFrame } satisfies VoiceoverCaptureControl) }
        catch (cause) { fail(cause) }
      }
      return finished
    },
    dispose(): void { if (!settled) fail(new DOMException('Recording bridge disposed', 'AbortError')) },
    snapshot: () => ({ nextFrame, pendingBytes, peakInFlightBytes, batches,
      reason: terminal?.reason ?? null, settled }),
  }
}
