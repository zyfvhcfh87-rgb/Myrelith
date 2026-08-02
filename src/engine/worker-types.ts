import type { ChunkPayload } from '../workers/decode-types'

/** Structural Worker boundary shared by current and compatibility bridges. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void
  terminate?(): void
}

/** Structural source for the retired keyframe-batch compatibility path. */
export interface ChunkProvider {
  chunksForTimestamp(
    targetSec: number,
    toleranceSec: number,
  ): Promise<ChunkPayload[]>
}
