/** Own a reviewed download until cancel, project change, or editor close. */
import { useDocumentStore } from '../state/documentStore'
import { CaptionEditSession } from './captionEditingController'
import { captionFileController, type CaptionDownloadFormat, type CaptionFileController } from './captionFileController'

export interface CaptionExportSnapshot {
  readonly revision: number
  readonly phase: 'idle' | 'review' | 'error'
  readonly fileName: string
  readonly cueCount: number
  readonly diagnostics: readonly string[]
  readonly omittedDiagnostics: number
  readonly error: string | null
}
const idle = (revision: number): CaptionExportSnapshot => Object.freeze({ revision, phase: 'idle', fileName: '', cueCount: 0,
  diagnostics: Object.freeze([]), omittedDiagnostics: 0, error: null })
export class CaptionExportController {
  private readonly files: CaptionFileController
  private snapshot = idle(0)
  private owner: { session: CaptionEditSession; trackId: string; format: CaptionDownloadFormat } | null = null
  private listeners = new Set<() => void>()
  private stop: (() => void) | null = null
  private epoch = 0
  constructor(files = captionFileController) { this.files = files }
  getSnapshot = (): CaptionExportSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.stop) {
      let previous = useDocumentStore.getState()
      this.stop = useDocumentStore.subscribe(next => {
        const changed = next.project !== previous.project || next.projectGeneration !== previous.projectGeneration || next.activeSequenceId !== previous.activeSequenceId
        previous = next
        if (changed) this.cancel()
      })
    }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.stop?.(); this.stop = null; this.cancel() } }
  }
  private publish(snapshot: CaptionExportSnapshot): void { this.snapshot = Object.freeze(snapshot); for (const listener of this.listeners) listener() }
  cancel = (): void => {
    this.epoch++
    const owner = this.owner; this.owner = null
    try { if (this.snapshot.phase !== 'idle') this.publish(idle(this.snapshot.revision + 1)) }
    finally { owner?.session.dispose() }
  }
  begin(trackId: string, format: CaptionDownloadFormat): void {
    const epoch = this.epoch + 1
    this.cancel()
    if (epoch !== this.epoch || !this.stop) return
    let session: CaptionEditSession | null = null
    try {
      session = new CaptionEditSession()
      if (epoch !== this.epoch || !this.stop) { session.dispose(); return }
      this.owner = { session, trackId, format }
      const plan = this.files.planDownload(session.document(), trackId, format)
      this.publish({ revision: this.snapshot.revision + 1, phase: 'review', fileName: plan.fileName, cueCount: plan.cueCount,
        diagnostics: Object.freeze([...plan.diagnostics]), omittedDiagnostics: plan.omittedDiagnostics, error: null })
    } catch (error) {
      if (epoch !== this.epoch) { session?.dispose(); return }
      const cancelledEpoch = this.epoch + 1
      session?.dispose(); this.cancel()
      if (this.epoch === cancelledEpoch && this.listeners.size > 0) this.publish({ ...idle(this.snapshot.revision + 1), phase: 'error', error: (error instanceof Error ? error.message : 'Caption export failed.').slice(0, 2000) })
    }
  }
  download(revision: number, acceptLoss: boolean): string | null {
    const owner = this.owner
    if (!owner || revision !== this.snapshot.revision || this.snapshot.phase !== 'review') return 'The caption export was cancelled or replaced.'
    if (!acceptLoss) return 'Accept the disclosed caption losses before downloading.'
    try {
      const plan = this.files.planDownload(owner.session.document(), owner.trackId, owner.format)
      if (this.owner !== owner) return 'The caption export was cancelled.'
      this.files.saveDownload(plan)
      return null
    } catch (error) { return error instanceof Error ? error.message : 'Caption export failed.' }
    finally { if (this.owner === owner) this.cancel() }
  }
}
