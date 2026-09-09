import { EMPTY_COLOR_GRADING_CONTEXT, type ColorGradingContext } from '../domain/colorGradingEffects'
import { COLOR_LUT_LIMITS, type PortableColorLutV1 } from '../domain/colorLut'
import { immutableColorLuts, isColorLutV1, colorLutContext, type PortableColorLut } from '../domain/colorLutCatalog'
import { applyColorLutToProject, removeUnusedColorLuts, type ColorGradingTarget } from '../domain/colorGradingEdits'
import type { ColorLutImportReply, ColorLutImportRequest } from '../domain/colorLutImport'
import { createProjectFileSnapshot, serializeProjectFile } from '../domain/projectFile'
import type { SequenceProject } from '../domain/projectSequences'
import { useColorLutImportStore } from '../state/colorLutImportStore'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'

/** Fresh full-file preflight includes media metadata and collections. */
export function commitPortableColorEdit(expected: SequenceProject, generation: number, candidate: SequenceProject): string | null {
  try {
    if (candidate === expected) return null
    if (candidate.colorLuts !== expected.colorLuts) {
      const media = useMediaStore.getState()
      serializeProjectFile(createProjectFileSnapshot(candidate, media.descriptors.values(), media.collections))
    }
    return useDocumentStore.getState().commitProjectEdit(expected, generation, candidate)
  } catch (cause) { return cause instanceof Error ? cause.message : 'The grading edit could not be saved.' }
}
interface ImportWorker {
  onmessage: ((event: MessageEvent<ColorLutImportReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
  postMessage(request: ColorLutImportRequest): void
  terminate(): void
}
export function createColorLutController(createWorker: () => ImportWorker = () => new Worker(new URL('../workers/color-lut-import.worker.ts', import.meta.url), { type: 'module' })) {
  type Pending = { project: SequenceProject; generation: number; target: ColorGradingTarget; selection: readonly string[]; adjustmentSelection: string | null; effectId?: string; table: PortableColorLutV1 | null; worker: ImportWorker | null; deadline: ReturnType<typeof setTimeout> | null }
  let pending: Pending | null = null
  function stopWorker(session: Pending): void {
    session.worker?.terminate(); session.worker = null
    if (session.deadline !== null) clearTimeout(session.deadline)
    session.deadline = null
  }
  function cancel(detail = ''): void {
    if (pending) stopWorker(pending)
    pending = null
    useColorLutImportStore.setState({ phase: detail ? 'error' : 'idle', name: '', detail })
  }
  function current(session: Pending): boolean {
    const state = useDocumentStore.getState(), selection = useTransportStore.getState().selectedClipIds
    return pending === session && state.project === session.project && state.projectGeneration === session.generation
      && state.activeSequenceId === session.target.sequenceId && useTransportStore.getState().selectedAdjustmentId === session.adjustmentSelection && selection.length === session.selection.length
      && selection.every((id, i) => session.selection[i] === id)
  }
  return {
    cancel,
    init(): () => void {
      const check = () => { if (pending && !current(pending)) cancel('The project or selection changed. Choose the LUT again.') }
      const document = useDocumentStore.subscribe(check), transport = useTransportStore.subscribe(check)
      return () => { document(); transport(); cancel() }
    },
    begin(file: File, target: ColorGradingTarget, effectId?: string): void {
      cancel()
      if (!file.name.toLowerCase().endsWith('.cube') || file.size > COLOR_LUT_LIMITS.fileBytes) { cancel('Choose a .cube file no larger than 4 MiB.'); return }
      const state = useDocumentStore.getState()
      const session: Pending = { project: state.project, generation: state.projectGeneration, target, effectId,
        selection: [...useTransportStore.getState().selectedClipIds], adjustmentSelection: useTransportStore.getState().selectedAdjustmentId, table: null, worker: null, deadline: null }
      pending = session
      useColorLutImportStore.setState({ phase: 'reading', name: file.name, detail: 'Reading a local LUT…' })
      try {
        const worker = createWorker(); session.worker = worker
        worker.onerror = (event) => { if (pending === session) cancel(event.message || 'LUT worker failed.') }
        worker.onmessageerror = () => { if (pending === session) cancel('LUT worker returned unreadable data.') }
        worker.onmessage = (event) => {
          if (!current(session)) { if (pending === session) cancel('The project or selection changed. Choose the LUT again.'); return }
          stopWorker(session)
          if (!event.data || typeof event.data !== 'object') { cancel('LUT worker returned invalid data.'); return }
          if ('error' in event.data) { cancel(typeof event.data.error === 'string' ? event.data.error.slice(0, 2048) : 'LUT import failed.'); return }
          try {
            const table = immutableColorLuts([event.data.table])[0]
            if (!isColorLutV1(table)) throw new Error('The imported LUT version is unavailable.')
            session.table = table
            useColorLutImportStore.setState({ phase: 'ready', name: table.name,
              detail: `${table.kind === '3d' ? `${table.size} × ${table.size} × ${table.size}, tetrahedral` : `${table.size} samples, linear`} · domain ${table.domainMin.join(', ')} → ${table.domainMax.join(', ')} · embedded in this project` })
          } catch (cause) { cancel(cause instanceof Error ? cause.message : 'Invalid LUT result.') }
        }
        session.deadline = setTimeout(() => { if (pending === session) cancel('LUT import exceeded its five-second deadline.') }, 5000)
        worker.postMessage({ file, id: `lut_${crypto.randomUUID()}`, name: file.name.replace(/\.cube$/iu, '').slice(0, 240) || 'Imported LUT' })
      } catch (cause) { cancel(cause instanceof Error ? cause.message : 'LUT import could not start.') }
    },
    apply(): string | null {
      const session = pending
      if (!session || !session.table || !current(session)) { cancel('This LUT import is no longer current. Choose it again.'); return 'This LUT import is no longer current.' }
      try {
        const candidate = applyColorLutToProject(session.project, session.target, session.table, () => crypto.randomUUID(), session.effectId)
        // Release the parser before the synchronous commit triggers subscriptions.
        stopWorker(session); pending = null
        const error = commitPortableColorEdit(session.project, session.generation, candidate)
        cancel(error ?? '')
        return error
      } catch (cause) { const error = cause instanceof Error ? cause.message : 'Could not apply LUT.'; cancel(error); return error }
    },
  }
}
export const colorLutController = createColorLutController()
export function reuseColorLut(target: ColorGradingTarget, lutId: string, effectId?: string): string | null {
  const state = useDocumentStore.getState(), table = state.project.colorLuts?.find((entry) => entry.id === lutId)
  if (!table || !isColorLutV1(table)) return 'This embedded table is unavailable.'
  try { return commitPortableColorEdit(state.project, state.projectGeneration, applyColorLutToProject(state.project, target, table, () => crypto.randomUUID(), effectId)) }
  catch (cause) { return cause instanceof Error ? cause.message : 'Could not apply LUT.' }
}
export function removeUnusedProjectColorLuts(): string | null {
  const state = useDocumentStore.getState()
  try { return commitPortableColorEdit(state.project, state.projectGeneration, removeUnusedColorLuts(state.project)) }
  catch (cause) { return cause instanceof Error ? cause.message : 'Could not remove unused LUTs.' }
}

let contextCatalog: readonly PortableColorLut[] | undefined
let currentContext: ColorGradingContext = EMPTY_COLOR_GRADING_CONTEXT
/** One app-owned facts snapshot; UI never decodes table data. */
export function currentColorGradingContext(): ColorGradingContext {
  const catalog = useDocumentStore.getState().project.colorLuts
  if (catalog !== contextCatalog) { contextCatalog = catalog; currentContext = colorLutContext(catalog ?? []) }
  return currentContext
}
