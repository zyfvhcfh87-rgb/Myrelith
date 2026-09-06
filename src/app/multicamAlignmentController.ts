import { alignmentRateIsSupported, type AudioAlignmentResult } from '../domain/multicamAlignment'
import { applyMulticamDefinitionEdit, type MulticamDefinitionEditCommand } from '../domain/multicamOperations'
import { alignTimecodes } from '../domain/multicamTimecode'
import type { SequenceProject } from '../domain/projectSequences'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { MediaAsset, MulticamDefinition } from '../domain/schema'
import { microsecondsDurationToFrames } from '../domain/time'
import { readMulticamTimecode } from '../pipeline/multicamTimecodeMetadata'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { INITIAL_MULTICAM_ALIGNMENT, useMulticamAlignmentStore, type MulticamAlignmentRow } from '../state/multicamAlignmentStore'
import { AudioAlignmentService, alignmentRead, readAlignmentBlob, type AudioAlignmentServiceResult } from './audioAlignmentService'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import { derivedDataIsClearing, registerDerivedDataOwner } from './derivedDataOwners'
import { sha256Hex } from './sourceFingerprint'

export interface MulticamAlignmentSettings {
  readonly definitionId: string
  readonly referenceAngleId: string
  readonly targetAngleIds: readonly string[]
  readonly method: 'audio' | 'timecode'
  readonly startBins: Readonly<Record<string, number>>
  readonly binCount: number
  readonly maxLagBins: number
  readonly commonClockAndDay: boolean
}
interface Session {
  readonly project: SequenceProject
  readonly sequenceId: string
  readonly binding: string
  readonly definition: MulticamDefinition
  readonly sources: readonly { angleId: string; asset: MediaAsset; descriptor: PortableAssetDescriptor }[]
  readonly settings: MulticamAlignmentSettings
  readonly abort: AbortController
  rows: readonly MulticamAlignmentRow[]
}
export interface MulticamAlignmentControllerDeps {
  readonly audio: Pick<AudioAlignmentService, 'run' | 'cancelAndDrain' | 'dispose' | 'snapshot'>
  readonly timecode: typeof readMulticamTimecode
  readonly blob: typeof readAlignmentBlob
}
function resultDetail(result: AudioAlignmentResult): string {
  if (result.state === 'aligned') return 'Unique audio match near the selected event'
  const messages = {
    'invalid-input': 'This source or frame rate is outside the supported audio profile',
    'silent-or-flat': 'Silent or steady audio has no unique sync event',
    'insufficient-overlap': 'Less than three seconds or 60% shared audio',
    'weak-match': 'The windows do not match closely enough',
    'repeated-match': 'Repeated events produce more than one plausible match',
    'search-boundary': 'The best match is at the search edge; choose another window or wider search',
  }
  return messages[result.reason]
}

export class MulticamAlignmentController {
  private readonly deps: MulticamAlignmentControllerDeps
  private session: Session | null = null
  private disposed = false
  private pending: Promise<void> | null = null
  private readonly unsubscribe: (() => void)[]
  constructor(deps: MulticamAlignmentControllerDeps = { audio: new AudioAlignmentService(), timecode: readMulticamTimecode, blob: readAlignmentBlob }) {
    this.deps = deps
    this.unsubscribe = [useDocumentStore.subscribe(() => this.reconcile()), useMediaStore.subscribe(() => this.reconcile()),
      registerDerivedDataOwner(() => this.cancel())]
  }
  private current(session: Session): boolean {
    const state = useDocumentStore.getState()
    return !this.disposed && this.session === session && !session.abort.signal.aborted
      && state.project === session.project && state.activeSequenceId === session.sequenceId
      && getActiveLocalProjectBindingId() === session.binding
      && session.sources.every(({ asset, descriptor }) => useMediaStore.getState().assets.get(asset.id) === asset
        && useMediaStore.getState().descriptors.get(asset.id) === descriptor)
  }
  private reconcile(): void {
    const session = this.session
    if (!session || this.current(session)) return
    this.session = null
    session.abort.abort()
    void this.deps.audio.cancelAndDrain()
    useMulticamAlignmentStore.setState({ phase: 'stale', rows: [], detail: 'The project or a connected source changed. Analyze again.' })
  }
  async cancel(): Promise<void> {
    const session = this.session
    this.session = null
    session?.abort.abort()
    if (session) useMulticamAlignmentStore.setState({ phase: 'cancelled', rows: [], detail: 'Alignment cancelled. Manual offsets remain available.' })
    await this.deps.audio.cancelAndDrain()
    await this.pending
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    await this.cancel()
    await this.deps.audio.dispose()
    useMulticamAlignmentStore.setState({ ...INITIAL_MULTICAM_ALIGNMENT })
  }
  diagnostics() { return this.deps.audio.snapshot() }
  analyze(settings: MulticamAlignmentSettings): Promise<void> {
    if (this.pending || this.disposed) return Promise.resolve()
    const pending = this.run(settings).finally(() => { if (this.pending === pending) this.pending = null })
    this.pending = pending
    return pending
  }
  private async run(settings: MulticamAlignmentSettings): Promise<void> {
    this.session?.abort.abort()
    this.session = null
    const state = useDocumentStore.getState()
    const definition = state.project.multicams?.find((item) => item.id === settings.definitionId)
    const binding = getActiveLocalProjectBindingId()
    useMulticamAlignmentStore.setState({ ...INITIAL_MULTICAM_ALIGNMENT, definitionId: settings.definitionId, phase: 'running' })
    try {
      if (derivedDataIsClearing()) throw new Error('Wait for disposable storage cleanup to finish before analyzing')
      if (!definition || !binding || !alignmentRateIsSupported(state.doc.frameRate)
        || !['audio', 'timecode'].includes(settings.method)) throw new Error('This multicam, local project or frame rate is unavailable')
      const ids = [settings.referenceAngleId, ...settings.targetAngleIds]
      if (ids.length < 2 || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error('Select a reference and 1–7 different target angles')
      const sources = ids.map((angleId) => {
        const angle = definition.angles.find((item) => item.id === angleId)
        const asset = angle && useMediaStore.getState().assets.get(angle.assetId)
        const descriptor = asset && useMediaStore.getState().descriptors.get(asset.id)
        if (!asset || !descriptor || asset.kind !== 'video') throw new Error('Reconnect every selected angle in the Media Pool')
        return { angleId, asset, descriptor }
      })
      const ownedSettings = { ...settings, targetAngleIds: [...settings.targetAngleIds], startBins: { ...settings.startBins } }
      const session: Session = { project: state.project, sequenceId: state.activeSequenceId, binding, definition,
        sources, settings: ownedSettings, abort: new AbortController(), rows: [] }
      this.session = session
      useMulticamAlignmentStore.setState({ ...INITIAL_MULTICAM_ALIGNMENT, definitionId: definition.id,
        phase: 'running', detail: 'Reading local source metadata…' })
      const progress = (fraction: number, detail: string) => {
        if (this.current(session)) useMulticamAlignmentStore.setState({ progress: fraction, detail })
      }
      const reference = definition.angles.find((angle) => angle.id === settings.referenceAngleId)!
      const rows: MulticamAlignmentRow[] = [{ angleId: reference.id, name: reference.name,
        state: 'reference', currentFrame: reference.coverage.startFrame, proposedFrame: reference.coverage.startFrame,
        detail: 'Reference stays at its current offset', facts: null, fromCache: false }]
      let audioResult: AudioAlignmentServiceResult | null = null
      if (settings.method === 'audio') {
        const definitionDigest = await alignmentRead(sha256Hex(new TextEncoder().encode(JSON.stringify([
          definition, state.activeSequenceId, state.doc.frameRate, ownedSettings,
        ]))), session.abort.signal)
        if (!this.current(session)) return
        audioResult = await this.deps.audio.run({ projectBindingId: binding, definitionDigest,
          sources: sources.map((source) => ({ ...source, startBin: ownedSettings.startBins[source.angleId] })),
          binCount: settings.binCount, maxLagBins: settings.maxLagBins, rate: state.doc.frameRate,
          current: () => this.current(session), progress })
        for (const comparison of audioResult.comparisons) {
          const angle = definition.angles.find((item) => item.id === comparison.angleId)!
          const result = comparison.result
          rows.push({ angleId: angle.id, name: angle.name, currentFrame: angle.coverage.startFrame,
            proposedFrame: result.state === 'aligned'
              ? reference.coverage.startFrame - reference.sourceStartFrame + result.offsetFrames + angle.sourceStartFrame : null,
            state: result.state, detail: resultDetail(result), facts: result.facts, fromCache: comparison.fromCache })
        }
      } else {
        let ref: Awaited<ReturnType<typeof readMulticamTimecode>> | null = null
        for (let i = 0; i < sources.length; i++) {
          const source = sources[i]
          const angle = definition.angles.find((item) => item.id === source.angleId)!
          progress(i / sources.length, `Reading timecode for ${angle.name}`)
          try {
            const blob = await alignmentRead(this.deps.blob(source.asset, session.abort.signal), session.abort.signal)
            const metadataSignal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(10_000)])
            const evidence = await alignmentRead(this.deps.timecode(blob, state.doc.frameRate, settings.commonClockAndDay, metadataSignal), metadataSignal)
            if (!this.current(session)) return
            if (i === 0) { ref = evidence; rows[0] = { ...rows[0], detail: `Reference timecode ${evidence.label}` }; continue }
            const result = alignTimecodes(ref, evidence, state.doc.frameRate)
            rows.push({ angleId: angle.id, name: angle.name, currentFrame: angle.coverage.startFrame,
              proposedFrame: result.state === 'aligned'
                ? reference.coverage.startFrame - reference.sourceStartFrame + result.offsetFrames + angle.sourceStartFrame : null,
              state: result.state, detail: result.state === 'aligned' ? `Non-drop timecode ${evidence.label}` : `Timecode unavailable: ${result.reason}`,
              facts: null, fromCache: false })
          } catch (cause) {
            if (!this.current(session)) return
            const detail = cause instanceof Error ? cause.message : String(cause)
            if (i === 0) throw new Error(`Reference timecode unavailable: ${detail}`)
            rows.push({ angleId: angle.id, name: angle.name, currentFrame: angle.coverage.startFrame,
              proposedFrame: null, state: 'unavailable', detail, facts: null, fromCache: false })
          }
        }
      }
      if (!this.current(session)) return
      session.rows = rows
      useMulticamAlignmentStore.setState({ phase: 'ready', progress: 1, rows, cacheHits: audioResult?.cacheHits ?? 0,
        cacheWarning: audioResult?.cacheWarnings.length ? 'Some features could not be cached. Proposals are still available.' : null,
        detail: 'Review offsets in frames. Analysis has not changed the project.' })
    } catch (cause) {
      if (this.session?.abort.signal.aborted || this.disposed) return
      if (useMulticamAlignmentStore.getState().phase === 'cancelled' || useMulticamAlignmentStore.getState().phase === 'stale') return
      this.session = null
      useMulticamAlignmentStore.setState({ definitionId: settings.definitionId, phase: 'error', rows: [],
        detail: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  apply(offsets: readonly { angleId: string; coverageStartFrame: number }[]): boolean {
    const session = this.session
    const reject = (detail: string) => { useMulticamAlignmentStore.setState({ detail }); return false }
    if (!session || !this.current(session) || useMulticamAlignmentStore.getState().phase !== 'ready') {
      return reject('This proposal is no longer current. Analyze again.')
    }
    if (!offsets.length || offsets.some((offset) => !session.rows.some((row) => row.angleId === offset.angleId && row.state === 'aligned'))) {
      return reject('Accept at least one valid proposal. Ambiguous and unavailable rows cannot be applied.')
    }
    const rate = useDocumentStore.getState().doc.frameRate
    // Recheck live selected-source coverage independently of the proposal and of persisted cache data.
    for (const source of session.sources) {
      const angle = session.definition.angles.find((item) => item.id === source.angleId)
      const descriptor = useMediaStore.getState().descriptors.get(source.asset.id)
      if (!angle || !descriptor || angle.sourceStartFrame + angle.coverage.durationFrames > microsecondsDurationToFrames(descriptor.durationMicroseconds, rate)) {
        return reject('An angle exceeds its current source coverage. Correct its manual range first.')
      }
    }
    const command: MulticamDefinitionEditCommand = { kind: 'set-offsets', definitionId: session.definition.id,
      expectedDefinition: session.definition, offsets }
    const checked = applyMulticamDefinitionEdit(useDocumentStore.getState().project, command)
    if (checked.failure) return reject(checked.failure === 'track-locked'
      ? 'Unlock every lane that uses this multicam before applying offsets.'
      : 'These offsets do not fit the existing multicam duration. Correct the offsets or make space with a manual edit first.')
    // No await between fresh validation and the one history mutation.
    this.session = null
    const applied = useDocumentStore.getState().editMulticamDefinition(command)
    useMulticamAlignmentStore.setState({ phase: applied ? 'applied' : 'stale', rows: [],
      detail: applied ? 'Applied reviewed offsets. Undo restores them together.' : 'The multicam changed before Apply. Analyze again.' })
    return applied
  }
}

let controller: MulticamAlignmentController | null = null
let disposal: Promise<void> | null = null
const leases = new Set<object>()
export async function initMulticamAlignment(): Promise<() => Promise<void>> {
  const lease = {}; leases.add(lease)
  if (disposal) await disposal
  controller ??= new MulticamAlignmentController()
  return async () => {
    if (!leases.delete(lease) || leases.size) return
    const retiring = controller
    controller = null
    disposal = retiring?.dispose().finally(() => { disposal = null }) ?? null
    await disposal
  }
}
export function analyzeMulticam(settings: MulticamAlignmentSettings): Promise<void> {
  if (!controller) {
    useMulticamAlignmentStore.setState({ phase: 'error', detail: 'The alignment runtime is not ready yet.' })
    return Promise.resolve()
  }
  return controller.analyze(settings)
}
export function cancelMulticamAlignment(): Promise<void> { return controller?.cancel() ?? Promise.resolve() }
export function applyMulticamAlignment(offsets: readonly { angleId: string; coverageStartFrame: number }[]): boolean {
  return controller?.apply(offsets) ?? false
}
export function multicamAlignmentDiagnostics() { return controller?.diagnostics() ?? null }
