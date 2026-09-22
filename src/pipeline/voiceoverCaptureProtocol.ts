/** Fixed-size worklet PCM transfer contract. Frames use the AudioContext sample grid. */
export type VoiceoverCaptureWorkletMessage =
  | { type: 'batch'; sequence: number; startFrame: number; frames: number; buffer: ArrayBuffer }
  | { type: 'stopped' | 'overrun'; endFrame: number }
  | { type: 'error'; reason: string; atFrame: number; endFrame: number }

export type VoiceoverCaptureControl =
  | { type: 'ack'; sequence: number }
  | { type: 'stop'; atFrame?: number }
  | { type: 'abort' }
