import { describe, expect, it } from 'vitest'
import { ANALYSIS_CACHE_ROOT } from '../domain/analysisCache'
import { VOICEOVER_RECORDINGS_DIRECTORY, VOICEOVER_WAV_LIMITS as LIMITS, VoiceoverWavDraft, voiceoverWavHeader, type VoiceoverSyncFile } from './voiceoverWavDraft'

type Stored = { bytes: Uint8Array; failClose: boolean }

class MemoryStorage {
  readonly files = new Map<string, Stored>()
  readonly events: string[] = []
  fault: 'short' | 'quota' | 'journal-short' | null = null
  failRemoval: string | null = null

  private access(name: string): VoiceoverSyncFile {
    const stored = this.files.get(name)
    if (!stored) throw new Error(`Missing ${name}`)
    let closed = false
    const assertOpen = () => { if (closed) throw new Error('Closed handle') }
    return {
      write: (bytes, { at }) => {
        assertOpen()
        if (this.fault && (
          (this.fault === 'journal-short' && name.endsWith('.checkpoint') && at > 0) ||
          (this.fault !== 'journal-short' && name.endsWith('.wav') && at >= LIMITS.headerBytes)
        )) {
          const fault = this.fault
          this.fault = null
          if (fault === 'quota') throw new DOMException('Disk full', 'QuotaExceededError')
          const half = bytes.length / 2
          const next = new Uint8Array(Math.max(stored.bytes.length, at + half))
          next.set(stored.bytes); next.set(bytes.subarray(0, half), at)
          stored.bytes = next
          return half
        }
        const next = new Uint8Array(Math.max(stored.bytes.length, at + bytes.length))
        next.set(stored.bytes); next.set(bytes, at)
        stored.bytes = next
        this.events.push(`${name}:write:${at}:${bytes.length}`)
        return bytes.length
      },
      read: (bytes, { at }) => {
        assertOpen()
        const count = Math.max(0, Math.min(bytes.length, stored.bytes.length - at))
        bytes.set(stored.bytes.subarray(at, at + count))
        return count
      },
      truncate: (size) => { assertOpen(); stored.bytes = stored.bytes.slice(0, size); this.events.push(`${name}:truncate:${size}`) },
      getSize: () => { assertOpen(); return stored.bytes.length },
      flush: () => { assertOpen(); this.events.push(`${name}:flush`) },
      close: () => {
        if (stored.failClose) { stored.failClose = false; throw new Error('Close failed') }
        closed = true
        this.events.push(`${name}:close`)
      },
    }
  }

  async open(id: string, create: boolean) {
    const audio = `${id}.wav`, journal = `${id}.checkpoint`
    if (create) {
      if (this.files.has(audio) || this.files.has(journal)) throw new Error('Draft exists')
      this.files.set(audio, { bytes: new Uint8Array(), failClose: false })
      this.files.set(journal, { bytes: new Uint8Array(), failClose: false })
    }
    return { audio: this.access(audio), journal: this.access(journal) }
  }

  async file(id: string) {
    const bytes = this.files.get(`${id}.wav`)!.bytes
    const file = {
      size: bytes.length,
      slice: (start: number, end: number) => ({ arrayBuffer: async () => Uint8Array.from(bytes.slice(start, end)).buffer }),
    } as File
    return { file, handle: `${id}.wav` }
  }

  async remove(id: string) {
    for (const name of [`${id}.wav`, `${id}.checkpoint`]) {
      if (this.failRemoval === name) { this.failRemoval = null; throw new Error('Remove failed') }
      this.files.delete(name)
      this.events.push(`${name}:remove`)
    }
  }

  async list() {
    const drafts = [...this.files.keys()]
      .filter((name) => name.endsWith('.wav'))
      .map((name) => ({
        id: name.slice(0, -'.wav'.length),
        sizeBytes: this.files.get(name)!.bytes.length,
        hasJournal: this.files.has(`${name.slice(0, -'.wav'.length)}.checkpoint`),
      }))
    return drafts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
}

function batch(): Uint8Array { return new Uint8Array(LIMITS.batchBytes).fill(42) }

describe('voiceover WAV draft', () => {
  it('flushes PCM before the alternating journal and header, then finalizes the exact file', async () => {
    const storage = new MemoryStorage()
    const draft = new VoiceoverWavDraft(storage)
    await draft.create('take')
    for (let index = 0; index < LIMITS.checkpointBytes / LIMITS.batchBytes; index++) draft.append(batch())
    const checkpoint = storage.events.slice(-5)
    expect(checkpoint).toEqual([
      'take.wav:flush', 'take.checkpoint:write:32:32', 'take.checkpoint:flush',
      'take.wav:write:0:44', 'take.wav:flush',
    ])
    draft.append(new Uint8Array([1, 2]))
    expect(draft.stop()).toEqual({ pcmBytes: LIMITS.checkpointBytes + 2, committedBytes: LIMITS.checkpointBytes + 2 })
    const final = await draft.finalize()
    expect(final.file.size).toBe(LIMITS.headerBytes + LIMITS.checkpointBytes + 2)
    expect(storage.files.get('take.wav')!.bytes.slice(0, 44)).toEqual(voiceoverWavHeader(LIMITS.checkpointBytes + 2))
    await draft.discard()
    await draft.discard()
    expect(storage.files.size).toBe(0)
  })

  it.each(['short', 'quota'] as const)('detects a %s data write and recovers only the prior checkpoint', async (fault) => {
    const storage = new MemoryStorage()
    const draft = new VoiceoverWavDraft(storage)
    await draft.create('take')
    for (let index = 0; index < LIMITS.checkpointBytes / LIMITS.batchBytes; index++) draft.append(batch())
    storage.fault = fault
    expect(() => draft.append(batch())).toThrow(fault === 'short' ? /short write/ : /Disk full/)
    expect(() => draft.append(batch())).toThrow(/not writable/)
    draft.release()
    const recovered = new VoiceoverWavDraft(storage)
    expect(await recovered.recover('take')).toEqual({
      pcmBytes: LIMITS.checkpointBytes, committedBytes: LIMITS.checkpointBytes,
      discardedTailBytes: fault === 'short' ? LIMITS.batchBytes / 2 : 0,
    })
    expect((await recovered.finalize()).file.size).toBe(44 + LIMITS.checkpointBytes)
  })

  it('drops a crash tail and falls back when the newest checkpoint is torn', async () => {
    const storage = new MemoryStorage()
    const draft = new VoiceoverWavDraft(storage)
    await draft.create('take')
    for (let index = 0; index < 2 * LIMITS.checkpointBytes / LIMITS.batchBytes; index++) draft.append(batch())
    draft.append(batch())
    draft.release()
    storage.files.get('take.wav')!.bytes.fill(0, 0, 44)
    storage.files.get('take.checkpoint')!.bytes.fill(0, 0, 8)
    const recovered = new VoiceoverWavDraft(storage)
    expect(await recovered.recover('take')).toEqual({
      pcmBytes: LIMITS.checkpointBytes, committedBytes: LIMITS.checkpointBytes,
      discardedTailBytes: LIMITS.checkpointBytes + LIMITS.batchBytes,
    })
    expect(storage.files.get('take.wav')!.bytes.slice(0, 44)).toEqual(voiceoverWavHeader(LIMITS.checkpointBytes))
  })

  it('does not expose PCM when a checkpoint record has a short write', async () => {
    const storage = new MemoryStorage()
    const draft = new VoiceoverWavDraft(storage)
    await draft.create('take')
    storage.fault = 'journal-short'
    for (let index = 0; index < LIMITS.checkpointBytes / LIMITS.batchBytes - 1; index++) draft.append(batch())
    expect(() => draft.append(batch())).toThrow(/short write/)
    draft.release()
    const recovered = new VoiceoverWavDraft(storage)
    expect(await recovered.recover('take')).toEqual({
      pcmBytes: 0, committedBytes: 0, discardedTailBytes: LIMITS.checkpointBytes,
    })
  })

  it('fails closed without a valid checkpoint and rejects a changed final length', async () => {
    const storage = new MemoryStorage()
    const draft = new VoiceoverWavDraft(storage)
    await draft.create('take')
    draft.stop()
    storage.files.get('take.wav')!.bytes = new Uint8Array(45)
    await expect(draft.finalize()).rejects.toThrow(/length changed/)
    storage.files.get('take.checkpoint')!.bytes.fill(0)
    const recovered = new VoiceoverWavDraft(storage)
    await expect(recovered.recover('take')).rejects.toThrow(/no valid flushed checkpoint/)
    expect(storage.files.has('take.wav')).toBe(true)
  })

  it('retries close and partial discard failures without deleting an open file', async () => {
    const storage = new MemoryStorage()
    const draft = new VoiceoverWavDraft(storage)
    await draft.create('take')
    storage.files.get('take.wav')!.failClose = true
    await expect(draft.discard()).rejects.toThrow(/Close failed/)
    expect(storage.files.size).toBe(2)
    storage.failRemoval = 'take.checkpoint'
    await expect(draft.discard()).rejects.toThrow(/Remove failed/)
    expect(storage.files.has('take.checkpoint')).toBe(true)
    await draft.discard()
    expect(storage.files.size).toBe(0)
  })

  it('lists stored drafts with size and journal facts without opening them', async () => {
    const storage = new MemoryStorage()
    const first = new VoiceoverWavDraft(storage)
    await first.create('take_a')
    first.append(new Uint8Array([1, 2, 3, 4]))
    first.stop()
    const second = new VoiceoverWavDraft(storage)
    await second.create('take_b')
    await second.discard()
    const third = new VoiceoverWavDraft(storage)
    await third.create('take_c')
    storage.files.delete('take_c.checkpoint')
    const eventsBefore = storage.events.length
    const listed = await first.list()
    expect(listed).toEqual([
      { id: 'take_a', sizeBytes: LIMITS.headerBytes + 4, hasJournal: true },
      { id: 'take_c', sizeBytes: LIMITS.headerBytes, hasJournal: false },
    ])
    // Listing must not open, write, flush, or close any file handle.
    expect(storage.events.slice(eventsBefore)).toEqual([])
    expect(storage.files.has('take_a.wav')).toBe(true)
    expect(storage.files.has('take_c.wav')).toBe(true)
  })

  it('removes a stored draft by id without touching its active draft', async () => {
    const storage = new MemoryStorage()
    const draft = new VoiceoverWavDraft(storage)
    await draft.create('active')
    draft.append(new Uint8Array([1, 2]))
    const other = new VoiceoverWavDraft(storage)
    await other.create('orphan')
    other.append(new Uint8Array([3, 4]))
    await other.stop()
    await draft.discardStored('orphan')
    expect(storage.files.has('orphan.wav')).toBe(false)
    expect(storage.files.has('orphan.checkpoint')).toBe(false)
    expect(storage.files.has('active.wav')).toBe(true)
    expect(storage.files.has('active.checkpoint')).toBe(true)
    expect(() => draft.append(new Uint8Array([5, 6]))).not.toThrow()
    await expect(draft.discardStored('orphan')).resolves.toBeUndefined()
    await expect(draft.discardStored('no spaces')).rejects.toThrow(/Invalid recording draft id/)
  })
})

describe('recordings storage separation', () => {
  it('keeps the recordings directory outside the disposable derived-data namespace', () => {
    // Disposable derived-data clearing covers the proxy and analysis caches
    // under `myrelith-derived/*`; kept recording originals must survive it.
    expect(VOICEOVER_RECORDINGS_DIRECTORY.startsWith('myrelith-derived/')).toBe(false)
    expect(VOICEOVER_RECORDINGS_DIRECTORY).not.toBe(ANALYSIS_CACHE_ROOT)
    expect(VOICEOVER_RECORDINGS_DIRECTORY).not.toBe('myrelith-derived/proxy-cache-v1')
  })
})
