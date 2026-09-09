/** Lazy speech owner only; essential callers keep their synchronous idle path. */
export type SpeechRetirementReason = 'Program playback' | 'Source playback' | 'Source selection' | 'Export'
let retire: ((reason: SpeechRetirementReason) => Promise<void> | null) | null = null
const pending = new Map<object, SpeechRetirementReason>()
const listeners = new Set<() => void>()
let status: string | null = null
const publish = (value: string | null) => { status = value; for (const listener of listeners) { try { listener() } catch { /* Passive UI. */ } } }
export const getSpeechAdmissionStatus = (): string | null => status
export const subscribeSpeechAdmission = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function registerSpeechRetirement(owner: NonNullable<typeof retire>): () => void {
  if (retire) throw new Error('A speech retirement owner is already registered')
  retire = owner
  return () => { if (retire === owner) retire = null }
}
export function speechEssentialAdmissionPending(): boolean { return pending.size > 0 }
export function beginSpeechRetirement(reason: SpeechRetirementReason): Promise<void> | null {
  let drain: Promise<void> | null | undefined
  try { drain = retire?.(reason) } catch (cause) { drain = Promise.reject(cause) }
  if (!drain) return null
  const token = {}
  pending.set(token, reason)
  publish(`${reason} is waiting for speech cleanup (current window deadline: 120 seconds).`)
  let failed = false
  return drain.catch(cause => {
    failed = true
    publish(cause instanceof Error ? cause.message : 'Speech cleanup failed. Reload before continuing.')
    throw cause
  }).finally(() => {
    pending.delete(token)
    if (!pending.size && !failed) publish(null)
  })
}
