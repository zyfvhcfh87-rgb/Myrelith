import type { LocalDecoderBudget } from '../../src/codecs/mediaCodecFallbacks'

export interface LaneSource {
  id: string
  blob: Blob
  budget: LocalDecoderBudget
}
export interface Ledger {
  inputs: number
  lanes: number
  nativeDecoders: number
  nativeFrames: number
  createdNativeDecoders: number
  closedNativeDecoders: number
  estimatedFrameBytes: number
  peakNativeDecoders: number
  peakNativeFrames: number
  peakEstimatedFrameBytes: number
  peakDecodeQueue: number
  scratchSurfaces: number
  scratchBytes: number
}
export type Request =
  | { type: 'open'; sources: LaneSource[]; width: number; height: number; startUs: number }
  | { type: 'frame'; id: string; frame: number; targetUs: number; requestedAt: number }
  | { type: 'close' }
export type Response =
  | { type: 'ready'; ledger: Ledger }
  | { type: 'frame'; id: string; frame: number; timestampUs: number; requestedAt: number; bitmap: ImageBitmap; ledger: Ledger }
  | { type: 'closed'; ledger: Ledger }
  | { type: 'error'; detail: string; ledger: Ledger }
