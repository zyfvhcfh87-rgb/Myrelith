// Capture-only mono PCM16 processor. Audio output stays digitally silent.
const BATCH_FRAMES = 8192
const MAX_OUTSTANDING = 4

class VoiceoverCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.startFrame = options.processorOptions.startFrame
    // The take limit is a pre-scheduled frame-boundary stop; Stop may only shorten it.
    const limit = options.processorOptions.limitStopFrame
    this.stopFrame = Number.isSafeInteger(limit) && limit >= this.startFrame ? limit : Infinity
    this.lastRenderEnd = null
    this.nextCaptureFrame = null
    this.batch = null
    this.batchView = null
    this.batchStartFrame = null
    this.batchFrames = 0
    this.batchPeak = 0
    this.sequence = 0
    this.outstanding = new Set()
    this.terminal = false
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'abort') { this.terminal = true; this.batch = this.batchView = null; return }
      if (data?.type === 'ack') {
        if (!this.outstanding.delete(data.sequence) && !this.terminal) this.fail('Unexpected recording acknowledgement', currentFrame)
        return
      }
      if (data?.type !== 'stop' || this.terminal) return
      const atFrame = data.atFrame === undefined ? currentFrame : data.atFrame
      if (!Number.isSafeInteger(atFrame) || atFrame < this.startFrame ||
        atFrame < currentFrame || atFrame < (this.nextCaptureFrame ?? this.startFrame)) {
        this.fail('Recording stop arrived after its sample frame', currentFrame)
        return
      }
      this.stopFrame = Math.min(this.stopFrame, atFrame)
    }
  }

  fail(reason, atFrame) {
    if (this.terminal) return
    this.terminal = true
    this.batch = this.batchView = null
    this.port.postMessage({ type: 'error', reason, atFrame,
      endFrame: this.nextCaptureFrame ?? this.startFrame })
  }

  emitBatch() {
    if (!this.batchFrames) return
    const buffer = this.batchFrames === BATCH_FRAMES
      ? this.batch : this.batch.slice(0, this.batchFrames * 2)
    const sequence = ++this.sequence
    this.outstanding.add(sequence)
    this.port.postMessage({ type: 'batch', sequence, startFrame: this.batchStartFrame,
      frames: this.batchFrames, peak: this.batchPeak / 32768, buffer }, [buffer])
    this.batch = this.batchView = null
    this.batchFrames = 0
    this.batchPeak = 0
    this.batchStartFrame = null
  }

  finish() {
    if (this.terminal) return
    this.emitBatch()
    this.terminal = true
    this.port.postMessage({ type: 'stopped', endFrame: this.nextCaptureFrame ?? this.startFrame })
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] ?? []) channel.fill(0)
    // Once terminal, let the processor be collected instead of rendering
    // silence on the long-lived playback context for every later take.
    if (this.terminal) return false

    const input = inputs[0]?.[0]
    const length = outputs[0]?.[0]?.length ?? input?.length ?? 128
    const blockStart = currentFrame
    const blockEnd = blockStart + length
    if (this.nextCaptureFrame === null && blockStart > this.startFrame) {
      this.fail('Recording missed its start sample frame', blockStart)
      return false
    }
    if (this.nextCaptureFrame !== null &&
      this.lastRenderEnd !== null && blockStart !== this.lastRenderEnd) {
      this.fail('Audio render frame discontinuity', blockStart)
      return false
    }
    this.lastRenderEnd = blockEnd
    // An inactive worklet can skip render quanta before the anchor. Only the
    // captured interval requires continuous callbacks and sample numbering.
    if (blockEnd <= this.startFrame) return true
    const from = Math.max(0, this.startFrame - blockStart)
    const to = Math.min(length, this.stopFrame - blockStart)
    if (to > from) {
      if (!input || input.length < to) {
        this.fail('Microphone input became unavailable', blockStart + from)
        return false
      }
      for (let index = from; index < to; index++) {
        const frame = blockStart + index
        if (this.nextCaptureFrame === null) {
          this.port.postMessage({ type: 'started', atFrame: frame })
        }
        if (this.nextCaptureFrame !== null && frame !== this.nextCaptureFrame) {
          this.fail('Microphone sample frame discontinuity', frame)
          return false
        }
        if (!this.batch) {
          if (this.outstanding.size >= MAX_OUTSTANDING) {
            this.terminal = true
            this.port.postMessage({ type: 'overrun', endFrame: frame })
            return false
          }
          this.batch = new ArrayBuffer(BATCH_FRAMES * 2)
          this.batchView = new DataView(this.batch)
          this.batchStartFrame = frame
        }
        if (!Number.isFinite(input[index])) {
          this.fail('Microphone input contained a non-finite sample', frame)
          return false
        }
        const sample = Math.max(-1, Math.min(1, input[index]))
        const pcm = Math.round(sample < 0 ? sample * 32768 : sample * 32767)
        this.batchView.setInt16(this.batchFrames * 2, pcm, true)
        const magnitude = pcm < 0 ? -pcm : pcm
        if (magnitude > this.batchPeak) this.batchPeak = magnitude
        this.batchFrames++
        this.nextCaptureFrame = frame + 1
        if (this.batchFrames === BATCH_FRAMES) this.emitBatch()
      }
    }
    if (this.stopFrame <= blockEnd) this.finish()
    return !this.terminal
  }
}

registerProcessor('myrelith-voiceover-capture-v1', VoiceoverCaptureProcessor)
