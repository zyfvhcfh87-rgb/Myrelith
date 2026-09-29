/** Worker-safe mono PCM16 WAV draft writer. OPFS access is injected. */
import type { VoiceoverDraftInfo } from '../domain/voiceoverDrafts'

export type { VoiceoverDraftInfo } from '../domain/voiceoverDrafts'

/**
 * Top-level recordings directory, deliberately outside the disposable
 * `myrelith-derived/*` proxy/analysis cache namespace: kept originals must
 * survive derived-data clearing.
 */
export const VOICEOVER_RECORDINGS_DIRECTORY = 'myrelith-recordings-v1'

export const VOICEOVER_WAV_LIMITS = {
  sampleRate: 48_000,
  headerBytes: 44,
  slotBytes: 32,
  batchBytes: 16 * 1024,
  inFlightBytes: 64 * 1024,
  checkpointBytes: 256 * 1024,
  maxDurationSamples: 60 * 60 * 48_000,
  maxTakeBytes: 512 * 1024 * 1024,
} as const

const MAX_PCM_BYTES = VOICEOVER_WAV_LIMITS.maxDurationSamples * 2
const SLOT_MAGIC = 0x32303949 // Issue 209 proof format v1
const SLOT_MARKER = 0xfeed2090

export interface VoiceoverSyncFile {
  write(bytes: Uint8Array, options: { at: number }): number
  read(bytes: Uint8Array, options: { at: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}

export interface VoiceoverDraftStorage<Handle> {
  open(id: string, create: boolean): Promise<{ audio: VoiceoverSyncFile; journal: VoiceoverSyncFile }>
  file(id: string): Promise<{ file: File; handle: Handle }>
  remove(id: string): Promise<void>
  /** Enumerate every stored draft without opening a write handle on it. */
  list(): Promise<VoiceoverDraftInfo[]>
}

export interface VoiceoverDraftProgress {
  readonly pcmBytes: number
  readonly committedBytes: number
}

export interface VoiceoverDraftRecovery extends VoiceoverDraftProgress {
  readonly discardedTailBytes: number
}

function validId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new RangeError('Invalid recording draft id')
}

function checkedWrite(file: VoiceoverSyncFile, bytes: Uint8Array, at: number): void {
  const written = file.write(bytes, { at })
  if (written !== bytes.length) throw new Error(`Voiceover short write: ${written}/${bytes.length}`)
}

function checksum(bytes: Uint8Array): number {
  let hash = 2166136261
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0
  return hash
}

export function voiceoverWavHeader(pcmBytes: number): Uint8Array {
  if (!Number.isSafeInteger(pcmBytes) || pcmBytes < 0 || pcmBytes > MAX_PCM_BYTES || pcmBytes % 2 !== 0) {
    throw new RangeError('Invalid voiceover PCM length')
  }
  const result = new Uint8Array(VOICEOVER_WAV_LIMITS.headerBytes)
  const view = new DataView(result.buffer)
  const label = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i))
  }
  label(0, 'RIFF'); view.setUint32(4, 36 + pcmBytes, true); label(8, 'WAVE')
  label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, VOICEOVER_WAV_LIMITS.sampleRate, true)
  view.setUint32(28, VOICEOVER_WAV_LIMITS.sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  label(36, 'data'); view.setUint32(40, pcmBytes, true)
  return result
}

function checkpointRecord(sequence: number, pcmBytes: number): Uint8Array {
  const bytes = new Uint8Array(VOICEOVER_WAV_LIMITS.slotBytes)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, SLOT_MAGIC, true)
  view.setUint32(4, 1, true)
  view.setUint32(8, sequence, true)
  view.setUint32(12, pcmBytes, true)
  view.setUint32(16, checksum(bytes.subarray(0, 16)), true)
  view.setUint32(20, SLOT_MARKER, true)
  return bytes
}

function readCheckpoint(file: VoiceoverSyncFile, at: number, physicalBytes: number): {
  sequence: number; pcmBytes: number
} | null {
  const bytes = new Uint8Array(VOICEOVER_WAV_LIMITS.slotBytes)
  if (file.read(bytes, { at }) !== bytes.length) return null
  const view = new DataView(bytes.buffer)
  const sequence = view.getUint32(8, true)
  const pcmBytes = view.getUint32(12, true)
  if (view.getUint32(0, true) !== SLOT_MAGIC || view.getUint32(4, true) !== 1 ||
    view.getUint32(16, true) !== checksum(bytes.subarray(0, 16)) ||
    view.getUint32(20, true) !== SLOT_MARKER ||
    pcmBytes % 2 !== 0 || pcmBytes > MAX_PCM_BYTES ||
    pcmBytes + VOICEOVER_WAV_LIMITS.headerBytes > physicalBytes) return null
  return { sequence, pcmBytes }
}

export class VoiceoverWavDraft<Handle> {
  private readonly storage: VoiceoverDraftStorage<Handle>
  private phase: 'idle' | 'writing' | 'faulted' | 'abandoned' | 'stopped' | 'discarded' = 'idle'
  private id: string | null = null
  private audio: VoiceoverSyncFile | null = null
  private journal: VoiceoverSyncFile | null = null
  private pcmBytes = 0
  private committedBytes = 0
  private generation = 0

  constructor(storage: VoiceoverDraftStorage<Handle>) { this.storage = storage }

  private progress(): VoiceoverDraftProgress {
    return { pcmBytes: this.pcmBytes, committedBytes: this.committedBytes }
  }

  private closeFiles(): void {
    let failure: unknown = null
    if (this.audio) {
      try { this.audio.close(); this.audio = null } catch (cause) { failure = cause }
    }
    if (this.journal) {
      try { this.journal.close(); this.journal = null } catch (cause) { failure ??= cause }
    }
    if (failure) throw failure
  }

  async create(id: string): Promise<VoiceoverDraftProgress> {
    validId(id)
    if (this.phase !== 'idle') throw new Error('Recording draft already opened')
    const files = await this.storage.open(id, true)
    this.id = id
    this.audio = files.audio
    this.journal = files.journal
    try {
      this.audio.truncate(0); this.journal.truncate(0)
      checkedWrite(this.audio, voiceoverWavHeader(0), 0)
      this.audio.flush()
      checkedWrite(this.journal, checkpointRecord(0, 0), 0)
      this.journal.flush()
      this.phase = 'writing'
      return this.progress()
    } catch (cause) {
      this.phase = 'faulted'
      throw cause
    }
  }

  private checkpoint(): void {
    if (!this.audio || !this.journal) throw new Error('Recording files are closed')
    this.audio.flush()
    const next = this.generation + 1
    checkedWrite(this.journal, checkpointRecord(next, this.pcmBytes),
      (next % 2) * VOICEOVER_WAV_LIMITS.slotBytes)
    this.journal.flush()
    this.committedBytes = this.pcmBytes
    this.generation = next
    checkedWrite(this.audio, voiceoverWavHeader(this.committedBytes), 0)
    this.audio.flush()
  }

  append(bytes: Uint8Array): VoiceoverDraftProgress {
    if (this.phase !== 'writing' || !this.audio) throw new Error('Recording draft is not writable')
    if (bytes.byteLength < 2 || bytes.byteLength > VOICEOVER_WAV_LIMITS.batchBytes || bytes.byteLength % 2) {
      throw new RangeError('Recording batch must contain 1–8192 PCM16 samples')
    }
    try {
      // The capture owner stops on a frame boundary at the limit; reaching
      // this check means a caller overshot, so the draft faults explicitly.
      if (this.pcmBytes + bytes.byteLength > MAX_PCM_BYTES ||
        this.pcmBytes + bytes.byteLength + VOICEOVER_WAV_LIMITS.headerBytes +
        VOICEOVER_WAV_LIMITS.inFlightBytes > VOICEOVER_WAV_LIMITS.maxTakeBytes) {
        throw new RangeError('Recording take limit exceeded')
      }
      checkedWrite(this.audio, bytes, VOICEOVER_WAV_LIMITS.headerBytes + this.pcmBytes)
      this.pcmBytes += bytes.byteLength
      if (this.pcmBytes - this.committedBytes >= VOICEOVER_WAV_LIMITS.checkpointBytes) this.checkpoint()
      return this.progress()
    } catch (cause) {
      this.phase = 'faulted'
      throw cause
    }
  }

  /** Complete a reviewable draft. The caller later decides whether to keep. */
  stop(): VoiceoverDraftProgress {
    if (this.phase !== 'writing') throw new Error('Recording draft is not writable')
    try {
      this.checkpoint()
      this.closeFiles()
      this.phase = 'stopped'
      return this.progress()
    } catch (cause) {
      this.phase = 'faulted'
      throw cause
    }
  }

  /** Close after a write fault without promising uncommitted bytes. */
  release(): VoiceoverDraftProgress {
    if (this.phase === 'idle' || this.phase === 'discarded') throw new Error('No recording draft to release')
    this.closeFiles()
    this.phase = 'abandoned'
    return this.progress()
  }

  /** Rebuild header from the newest valid journal slot, dropping the tail. */
  async recover(id: string): Promise<VoiceoverDraftRecovery> {
    validId(id)
    if (this.phase !== 'idle' && this.phase !== 'abandoned') throw new Error('Recording draft is already active')
    const files = await this.storage.open(id, false)
    this.id = id
    this.audio = files.audio
    this.journal = files.journal
    try {
      const physical = this.audio.getSize()
      const journal = this.journal
      const candidates = [0, VOICEOVER_WAV_LIMITS.slotBytes]
        .map((at) => readCheckpoint(journal, at, physical))
        .filter((item): item is { sequence: number; pcmBytes: number } => item !== null)
        .sort((a, b) => b.sequence - a.sequence)
      if (!candidates.length) throw new Error('Recording has no valid flushed checkpoint')
      const latest = candidates[0]
      this.audio.truncate(VOICEOVER_WAV_LIMITS.headerBytes + latest.pcmBytes)
      checkedWrite(this.audio, voiceoverWavHeader(latest.pcmBytes), 0)
      this.audio.flush()
      this.pcmBytes = this.committedBytes = latest.pcmBytes
      this.generation = latest.sequence
      this.closeFiles()
      this.phase = 'stopped'
      return { ...this.progress(), discardedTailBytes: physical - (VOICEOVER_WAV_LIMITS.headerBytes + latest.pcmBytes) }
    } catch (cause) {
      this.phase = 'faulted'
      try { this.closeFiles(); this.phase = 'abandoned' } catch { /* keep locks for an explicit retry */ }
      throw cause
    }
  }

  /** Bounded header/length validation; no whole-take buffer or decode. */
  async finalize(): Promise<{ file: File; handle: Handle; pcmBytes: number }> {
    if (this.phase !== 'stopped' || !this.id) throw new Error('Recording must be stopped before finalization')
    const { file, handle } = await this.storage.file(this.id)
    if (file.size !== VOICEOVER_WAV_LIMITS.headerBytes + this.committedBytes) {
      throw new Error('Recording length changed after stop')
    }
    const header = new Uint8Array(await file.slice(0, VOICEOVER_WAV_LIMITS.headerBytes).arrayBuffer())
    const expected = voiceoverWavHeader(this.committedBytes)
    if (header.length !== expected.length || header.some((value, index) => value !== expected[index])) {
      throw new Error('Recording WAV header is invalid')
    }
    return { file, handle, pcmBytes: this.committedBytes }
  }

  /** Idempotent after a partial removal. A failed close leaves files for retry. */
  async discard(): Promise<void> {
    if (!this.id) throw new Error('No recording draft to discard')
    if (this.phase === 'discarded') return
    this.closeFiles()
    await this.storage.remove(this.id)
    this.phase = 'discarded'
  }

  /**
   * Remove a stored draft by id without touching this writer's active draft.
   * Recovery features use it to discard orphans; it is idempotent after a
   * partial removal and never opens a write handle.
   */
  async discardStored(id: string): Promise<void> {
    validId(id)
    if (id === this.id && this.phase !== 'idle' && this.phase !== 'discarded') {
      throw new Error('Use discard() for this writer\'s own recording draft')
    }
    await this.storage.remove(id)
  }

  /** Enumerate stored drafts; the directory listing never opens write handles. */
  async list(): Promise<VoiceoverDraftInfo[]> {
    return this.storage.list()
  }
}
