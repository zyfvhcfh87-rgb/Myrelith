/** Display helpers shared by the voiceover toolbar indicator and panel. */
import type { VoiceoverSession } from '../domain/voiceoverSession'

/** Voiceover drafts are always mono 16-bit PCM at 48 kHz. */
export const VOICEOVER_DISPLAY_SAMPLE_RATE = 48_000

/** m:ss.t from an exact sample count (integer math; truncates to tenths). */
export function voiceoverElapsedLabel(samples: number): string {
  const tenths = Math.floor(Math.max(0, samples) / (VOICEOVER_DISPLAY_SAMPLE_RATE / 10))
  const minutes = Math.floor(tenths / 600)
  const seconds = Math.floor(tenths / 10) % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`
}

const ACTIVE_PHASES: ReadonlySet<VoiceoverSession['phase']> = new Set([
  'requesting', 'preparing', 'counting-in', 'recording', 'closing',
])

/** True while the session may hold the microphone or its native graph. */
export function voiceoverSessionActive(session: VoiceoverSession | null): boolean {
  return session !== null && ACTIVE_PHASES.has(session.phase)
}

/** m:ss.t from integer microseconds (camera/screen takes). */
export function avElapsedLabel(durationUs: number): string {
  const tenths = Math.floor(Math.max(0, durationUs) / 100_000)
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`
}
