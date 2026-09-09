export interface NativeSpeechSegment { text: string; fromCentiseconds: number; toCentiseconds: number }
export type NativeSpeechOutput = { timing: 'model'; segments: NativeSpeechSegment[] }
  | { timing: 'unavailable'; reason: 'timestamp-coverage'; text: string }
export type CoreReply = { v: 1; owner: string; id: number; kind: string; code?: string; cooperativeZero?: boolean; heapBytes?: number; generatedTokens?: number } & { timing?: 'model' | 'unavailable'; reason?: 'timestamp-coverage'; text?: string; segments?: NativeSpeechSegment[] }
export function createSpeechWorkerProtocol(options: { createModule: (options: object) => Promise<unknown>;
  wasmIdentity: { bytes: number; sha256: string; fileName: string }; crypto: Crypto;
  emit(reply: CoreReply): void; close(): void; now?: () => number }): (message: object) => Promise<void>
