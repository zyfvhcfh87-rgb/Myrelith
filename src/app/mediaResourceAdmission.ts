/**
 * One app-owned admission ledger for optional live monitoring. Essential media
 * keeps its existing subsystem limits; unknown/exclusive work preempts the
 * monitor rather than pretending independent subsystem caps are a total cap.
 * A preemption callback must synchronously terminate its worker and release its
 * lease before the essential caller can allocate. Normal close may drain first.
 */
import { MAX_RENDER_AGGREGATE_SURFACE_BYTES } from '../domain/renderSurfaceBudget'

export interface MediaReservation {
  readonly kind: 'program' | 'audio' | 'source' | 'analysis' | 'export'
  readonly decoderSlots: number
  readonly surfaceBytes: number
  readonly monitorCompatible: boolean
}
export interface MediaResourceLease {
  update(reservation: MediaReservation): void
  release(): void
}
export interface MonitorReservation {
  readonly decoderSlots: number
  /** Frame references, output canvases, transferred bitmaps and worker scratch. */
  readonly surfaceBytes: number
}
export interface MediaAdmissionSnapshot {
  readonly essentialOwners: number
  readonly decoderSlots: number
  readonly surfaceBytes: number
  readonly monitorOwners: number
  readonly blockers: readonly MediaReservation['kind'][]
  readonly programReady: boolean
}
export type MonitorAdmission =
  | { readonly admitted: false; readonly reason: string }
  | { readonly admitted: true; readonly release: () => void }

export const LIVE_MONITOR_RESOURCE_LIMITS = Object.freeze({
  decoderSlots: 12,
  monitorBytes: 64 * 1024 * 1024,
  aggregateBytes: MAX_RENDER_AGGREGATE_SURFACE_BYTES,
})

function validate(reservation: MonitorReservation): void {
  for (const value of [reservation.decoderSlots, reservation.surfaceBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid media reservation')
  }
}

export class MediaResourceAdmission {
  private readonly essential = new Map<object, MediaReservation>()
  private monitor: { token: object; reservation: MonitorReservation; retire: (reason: string) => void } | null = null
  private readonly listeners = new Set<() => void>()

  reserve(reservation: MediaReservation): MediaResourceLease {
    validate(reservation)
    const token = {}
    const update = (next: MediaReservation) => {
      validate(next)
      const previous = this.essential.get(token)
      if (previous && Object.keys(next).every((key) => next[key as keyof MediaReservation] === previous[key as keyof MediaReservation])) return
      this.essential.set(token, Object.freeze({ ...next }))
      // Publish the blocker before retirement, preventing reentrant admission.
      if (this.monitor && this.unavailableReason(this.monitor.reservation)) this.interrupt(`${next.kind}-priority`)
      this.publish()
    }
    update(reservation)
    let released = false
    return {
      update: (next) => { if (!released) update(next) },
      release: () => {
        if (released) return
        released = true
        this.essential.delete(token)
        this.publish()
      },
    }
  }

  tryMonitor(reservation: MonitorReservation, retire: (reason: string) => void): MonitorAdmission {
    validate(reservation)
    if (this.monitor) return { admitted: false, reason: 'The previous live previews are still closing.' }
    const reason = this.unavailableReason(reservation)
    if (reason) return { admitted: false, reason }
    const token = {}
    this.monitor = { token, reservation: Object.freeze({ ...reservation }), retire }
    this.publish()
    return { admitted: true, release: () => {
      if (this.monitor?.token !== token) return
      this.monitor = null
      this.publish()
    } }
  }

  /** Called before a new essential decoder/source generation can allocate. */
  interrupt(reason: string): void {
    const previous = this.monitor
    if (!previous) return
    previous.retire(reason)
    if (this.monitor === previous) throw new Error('Live monitor failed to retire before essential media admission')
  }

  snapshot(): MediaAdmissionSnapshot {
    const reservations = [...this.essential.values()]
    return {
      essentialOwners: reservations.length,
      decoderSlots: reservations.reduce((sum, item) => sum + item.decoderSlots, this.monitor?.reservation.decoderSlots ?? 0),
      surfaceBytes: reservations.reduce((sum, item) => sum + item.surfaceBytes, this.monitor?.reservation.surfaceBytes ?? 0),
      monitorOwners: this.monitor ? 1 : 0,
      blockers: [...new Set(reservations.filter((item) => !item.monitorCompatible).map((item) => item.kind))],
      programReady: reservations.some((item) => item.kind === 'program' && item.monitorCompatible),
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private unavailableReason(request: MonitorReservation): string | null {
    const snapshot = this.snapshot()
    if (!snapshot.programReady) return 'Program Monitor is preparing playback.'
    if (snapshot.blockers.includes('source')) return 'Close Source Monitor, then retry live previews.'
    if (snapshot.blockers.length) return `Live previews paused for ${snapshot.blockers.join(', ')}. Retry when the current work is finished.`
    // The current optional reservation is included in snapshot; replace it.
    const decoders = snapshot.decoderSlots - (this.monitor?.reservation.decoderSlots ?? 0) + request.decoderSlots
    const bytes = snapshot.surfaceBytes - (this.monitor?.reservation.surfaceBytes ?? 0) + request.surfaceBytes
    if (request.decoderSlots < 1 || request.decoderSlots > 7) return 'Live previews support two to eight total angles.'
    if (request.surfaceBytes > LIVE_MONITOR_RESOURCE_LIMITS.monitorBytes
      || bytes > LIVE_MONITOR_RESOURCE_LIMITS.aggregateBytes
      || decoders > LIVE_MONITOR_RESOURCE_LIMITS.decoderSlots) return 'This configuration exceeds the live-preview resource limit. Use fresh editing proxies or paused previews.'
    return null
  }

  private publish(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* Passive diagnostics never own admission. */ }
    }
  }
}

export const mediaResourceAdmission = new MediaResourceAdmission()
