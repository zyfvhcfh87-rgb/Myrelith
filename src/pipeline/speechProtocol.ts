import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import type { SpeechTranscript } from '../domain/speechTranscript'
export const SPEECH_PHASE_BUDGET_MS = Object.freeze({ setup: 10_000, load: 120_000, prepare: 10_000, infer: 120_000, close: 100 })
export type SpeechPhase = keyof typeof SPEECH_PHASE_BUDGET_MS
export interface SpeechLedger {
  modelOwners: number; inputOwners: number; sampleOwners: number; acquiredSamples: number; closedSamples: number
  pcmBytes: number; maxPcmBytes: number; windows: number
}
export interface SpeechRequest {
  type: 'transcribe'; requestId: string; modelCache: string; blob: Blob; sourceId: string
  budget: LocalDecoderBudget; startMicroseconds: number; endMicroseconds: number; language: 'en' | 'fr'
}
export type SpeechWorkerRequest = SpeechRequest | { type: 'cancel' }
export type SpeechWorkerReply =
  | { type: 'phase'; requestId: string; phase: string; category: SpeechPhase; progress: number }
  | { type: 'complete'; requestId: string; transcript: SpeechTranscript; ledger: SpeechLedger; cooperativeZero: true }
  | { type: 'disposed'; requestId: string; ledger: SpeechLedger; cooperativeZero: boolean }
  | { type: 'error'; requestId: string; message: string; ledger: SpeechLedger; cooperativeZero: boolean }
export function speechLedgerIsZero(value: SpeechLedger): boolean {
  return value?.modelOwners === 0 && value.inputOwners === 0 && value.sampleOwners === 0 && value.pcmBytes === 0
    && Number.isSafeInteger(value.acquiredSamples) && value.acquiredSamples >= 0 && value.acquiredSamples === value.closedSamples
}
