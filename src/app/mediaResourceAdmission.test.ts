import { describe, expect, test } from 'vitest'
import { MediaResourceAdmission, type MediaReservation } from './mediaResourceAdmission'

const program: MediaReservation = { kind: 'program', decoderSlots: 4, surfaceBytes: 50_000_000, monitorCompatible: true }
const request = { decoderSlots: 7, surfaceBytes: 55_065_600 }

describe('shared media admission', () => {
  test('requires Program, totals audio capacity and preserves essential work above optional limits', () => {
    const owner = new MediaResourceAdmission()
    expect(owner.tryMonitor(request, () => {}).admitted).toBe(false)
    const video = owner.reserve(program)
    const audio = owner.reserve({ kind: 'audio', decoderSlots: 2, surfaceBytes: 0, monitorCompatible: true })
    expect(owner.tryMonitor(request, () => {}).admitted).toBe(false)
    audio.update({ kind: 'audio', decoderSlots: 1, surfaceBytes: 0, monitorCompatible: true })
    const admitted = owner.tryMonitor(request, () => {})
    expect(admitted.admitted).toBe(true)
    if (admitted.admitted) admitted.release()
    video.release(); audio.release()
    expect(owner.snapshot()).toMatchObject({ essentialOwners: 0, monitorOwners: 0, decoderSlots: 0, surfaceBytes: 0 })
  })

  test.each(['source', 'analysis', 'export'] as const)('retires optional ownership before %s allocation and blocks reentrant admission', (kind) => {
    const owner = new MediaResourceAdmission(); owner.reserve(program)
    const events: string[] = []
    const lease = owner.tryMonitor(request, () => {
      expect(owner.tryMonitor(request, () => {}).admitted).toBe(false)
      events.push('worker terminated')
      if (lease.admitted) lease.release()
    })
    const essential = owner.reserve({ kind, decoderSlots: 1, surfaceBytes: 0, monitorCompatible: false })
    events.push('essential allocation')
    expect(events).toEqual(['worker terminated', 'essential allocation'])
    expect(owner.snapshot().monitorOwners).toBe(0)
    expect(owner.tryMonitor(request, () => {}).admitted).toBe(false)
    essential.release()
    expect(owner.tryMonitor(request, () => {}).admitted).toBe(true)
  })

  test('holds old ownership until actual release; stale and duplicate releases cannot evict a successor', () => {
    const owner = new MediaResourceAdmission(); owner.reserve(program)
    const old = owner.tryMonitor(request, () => {})
    expect(() => owner.interrupt('seek')).toThrow('failed to retire')
    expect(owner.tryMonitor(request, () => {}).admitted).toBe(false)
    if (!old.admitted) throw new Error('Expected admission')
    old.release()
    const next = owner.tryMonitor(request, () => {})
    old.release()
    expect(owner.snapshot().monitorOwners).toBe(1)
    if (next.admitted) next.release()
  })

  test('preempts on larger Program reservations and does not mistake surface allowance for wall allowance', () => {
    const owner = new MediaResourceAdmission(); const video = owner.reserve(program)
    const wall = owner.tryMonitor(request, () => { if (wall.admitted) wall.release() })
    video.update({ ...program, surfaceBytes: 240 * 1024 * 1024 })
    expect(owner.snapshot().monitorOwners).toBe(0)
    expect(owner.tryMonitor(request, () => {}).admitted).toBe(false)
    video.update(program)
    expect(owner.tryMonitor({ decoderSlots: 1, surfaceBytes: 65 * 1024 * 1024 }, () => {}).admitted).toBe(false)
    expect(() => owner.tryMonitor({ decoderSlots: NaN, surfaceBytes: 0 }, () => {})).toThrow(RangeError)
  })
})
