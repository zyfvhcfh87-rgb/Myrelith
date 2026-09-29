/** Fixed-size worklet PCM transfer contract. Frames use the AudioContext sample grid. */
export type VoiceoverCaptureWorkletMessage =
  | { type: 'started'; atFrame: number }
  /** peak: largest absolute PCM16 value in the batch, scaled to 0..1 (level display only). */
  | { type: 'batch'; sequence: number; startFrame: number; frames: number; peak: number; buffer: ArrayBuffer }
  | { type: 'stopped' | 'overrun'; endFrame: number }
  /**
   * The render clock jumped at `atFrame`: positive `frames` were skipped and
   * written as silence; negative `frames` were a repeated span, not rewritten.
   */
  | { type: 'gap'; atFrame: number; frames: number }
  | { type: 'error'; reason: string; atFrame: number; endFrame: number }

export type VoiceoverCaptureControl =
  | { type: 'ack'; sequence: number }
  | { type: 'stop'; atFrame?: number }
  | { type: 'abort' }
