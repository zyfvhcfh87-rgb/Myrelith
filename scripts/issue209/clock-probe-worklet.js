/* Disposable Issue #209 research probe. Reports block levels, never PCM. */
class ClockProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.rows = []
    this.firstFrame = null
    this.previousEnd = null
    this.gaps = 0
    this.blocks = 0
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush') return
      this.flush()
      this.port.postMessage({
        type: 'done',
        firstFrame: this.firstFrame,
        previousEnd: this.previousEnd,
        gaps: this.gaps,
        blocks: this.blocks,
      })
    }
  }

  flush() {
    if (this.rows.length === 0) return
    this.port.postMessage({ type: 'batch', rows: this.rows })
    this.rows = []
  }

  process(inputs, outputs) {
    const mic = inputs[0]?.[0]
    const reference = inputs[1]?.[0]
    const length = outputs[0]?.[0]?.length ?? mic?.length ?? reference?.length ?? 128
    for (const channel of outputs[0] ?? []) channel.fill(0)

    const frame = currentFrame
    if (this.firstFrame === null) this.firstFrame = frame
    if (this.previousEnd !== null && frame !== this.previousEnd) this.gaps += 1
    this.previousEnd = frame + length
    this.blocks += 1

    const levels = (samples) => {
      if (!samples || samples.length === 0) return [0, 0]
      let squared = 0
      let peak = 0
      for (const sample of samples) {
        squared += sample * sample
        peak = Math.max(peak, Math.abs(sample))
      }
      return [Math.sqrt(squared / samples.length), peak]
    }
    const [micRms, micPeak] = levels(mic)
    const [referenceRms, referencePeak] = levels(reference)
    this.rows.push({ frame, length, micRms, micPeak, referenceRms, referencePeak })
    if (this.rows.length >= 24) this.flush()
    return true
  }
}

registerProcessor('issue209-clock-probe', ClockProbeProcessor)
