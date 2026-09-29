import { parseRenderLibrary, serializeRenderLibrary, type RenderLibrary } from '../domain/renderJobs'
import { singleKeyIdbTransaction } from './indexedDbAccess'

/** Atomic read/validate/mutate/write; no successful publication before commit. */
export function renderTransaction<T>(key: 'jobs' | 'presets', parse: (value: unknown) => T, change?: (records: readonly T[]) => readonly T[]): Promise<RenderLibrary<T>> {
  return singleKeyIdbTransaction({
    database: 'myrelith-render-jobs',
    store: 'libraries',
    key,
    unavailableMessage: 'Local render storage is unavailable.',
    openFailedMessage: 'Could not open local render storage.',
    blockedMessage: 'Another tab is blocking render storage.',
    transactionFailedMessage: 'Render storage transaction failed.',
  }, change ? 'readwrite' : 'readonly', (raw) => {
    const previous = parseRenderLibrary(raw, parse)
    if (!change) return { result: previous }
    const result: RenderLibrary<T> = { version: 1, revision: previous.revision + 1, records: change(previous.records) }
    return { result, write: serializeRenderLibrary(result, parse) }
  })
}
