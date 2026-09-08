/** Passive, bounded diagnostic of the real project-session store. Never imported by the app. */
import { useProjectSessionStore } from '../../../src/state/projectSessionStore'
import { useDocumentStore } from '../../../src/state/documentStore'

export const MAX_SESSION_EVENTS = 256
export function observeProjectSession(write: (event: SessionEvent) => Promise<void>) {
  const events: SessionEvent[] = []
  let previous = '', overflow = false, pending = Promise.resolve()
  const capture = () => {
    if (overflow) return
    const s = useProjectSessionStore.getState()
    const errors = [s.error, s.saveError, s.recoveryError, ...s.activeMediaRelink.errors].filter((e): e is string => Boolean(e))
    for (const [name, phase] of [['session', s.phase], ['save', s.savePhase], ['recovery', s.recoveryPhase]]) if (phase === 'error') errors.push(`${name} phase is error`)
    const state = { projectId: useDocumentStore.getState().project.id, screen: s.screen, phase: s.phase, savePhase: s.savePhase, recoveryPhase: s.recoveryPhase,
      lastRecoveryAt: s.lastRecoveryAt, lastSavedAt: s.lastSavedAt, errors: errors.slice(0, 16).map((e) => e.slice(0, 2048)) }
    const key = JSON.stringify(state)
    if (key === previous) return
    previous = key
    if (events.length === MAX_SESSION_EVENTS - 1) { overflow = true; state.errors = [...state.errors.slice(0, 15), 'Session observation exceeded 256 transitions'] }
    const event = { sequence: events.length, at: Date.now(), ...state }
    events.push(event)
    pending = pending.then(() => write(event))
    // Preserve sink rejection for flush; prevent an unhandled rejection between checkpoints.
    void pending.catch(() => undefined)
  }
  const stop = useProjectSessionStore.subscribe(capture)
  capture()
  return { flush: () => pending, snapshot: () => [...events], stop }
}
export interface SessionEvent {
  sequence: number
  at: number
  projectId: string
  screen: string
  phase: string
  savePhase: string
  recoveryPhase: string
  lastRecoveryAt: number | null
  lastSavedAt: number | null
  errors: string[]
}
