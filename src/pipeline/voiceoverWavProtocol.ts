import type { VoiceoverDraftProgress, VoiceoverDraftRecovery } from './voiceoverWavDraft'

export type VoiceoverWavRequest =
  | { requestId: number; type: 'create' | 'recover'; id: string }
  | { requestId: number; type: 'append'; buffer: ArrayBuffer }
  | { requestId: number; type: 'stop' | 'release' | 'finalize' | 'discard' }

export type VoiceoverWavResult =
  | { type: 'create' | 'append' | 'stop' | 'release'; progress: VoiceoverDraftProgress }
  | { type: 'recover'; progress: VoiceoverDraftRecovery }
  | { type: 'finalize'; file: File; handle: FileSystemFileHandle; pcmBytes: number }
  | { type: 'discard' }

export type VoiceoverWavReply =
  | { requestId: number; result: VoiceoverWavResult }
  | { requestId: number; error: { name: string; message: string } }
