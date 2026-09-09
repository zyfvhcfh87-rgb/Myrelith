/** Source-only diagnostic adapter for the same public owner used by ExportDialog. */
import type { ExportProfile } from '../../../src/domain/exportProfile'
import type { SequenceProject } from '../../../src/domain/projectSequences'
import type { ExportResult } from '../../../src/app/exportController'
import {
  disposePluginPreparedExportOwner,
  getPluginPreparedExportPort,
  type PluginPreparedExportAccessor,
} from '../../../src/app/pluginPreparedExportOwner'
import type { PluginPreparedExportSnapshot } from '../../../src/app/pluginPreparedExportController'

export type PreparedExportEvent =
  | { phase: 'prepared' | 'reviewed'; status: PluginPreparedExportSnapshot['status']; attempt: PluginPreparedExportSnapshot['attempt']; tokenPresent: boolean }
  | { phase: 'started' }
  | { phase: 'completed'; destination: ExportResult['destination'] | null }
  | { phase: 'failed'; stage: 'prepare' | 'start'; error: string }
  | { phase: 'closed' }

export class G4PreparedExportFailure extends Error {
  readonly stage: 'prepare' | 'start'

  constructor(stage: 'prepare' | 'start', cause: unknown) {
    super(String(cause), { cause })
    this.name = 'G4PreparedExportFailure'
    this.stage = stage
  }
}

const productionOwner: PluginPreparedExportAccessor = {
  getPort: getPluginPreparedExportPort,
  close: disposePluginPreparedExportOwner,
}

function reviewFixtureBlockers(project: SequenceProject, prepared: PluginPreparedExportSnapshot): void {
  const descriptors = project.sequences.flatMap((s) => s.tracks.flatMap((t) => t.clips.flatMap((c) => c.effects.filter((e) => e.type.startsWith('plugin:')))))
  const facts = prepared.attempt?.effects ?? [], blockers = prepared.attempt?.blockers ?? []
  if (project.id !== 'g4' || descriptors.length !== 2 || new Set(descriptors.map((e) => e.id)).size !== 2
    || descriptors.some((e) => e.type !== 'plugin:missing/future' || e.version !== 99 || e.enabled
      || Object.keys(e.params).length !== 1 || e.params.literal !== 'preserve me')
    || prepared.status !== 'blocked' || facts.length !== 2 || blockers.length !== 2
    || new Set(facts.map((f) => f.descriptorId)).size !== 2 || new Set(blockers.map((b) => b.key)).size !== 2
    || facts.some((f) => !descriptors.some((e) => e.id === f.descriptorId)
      || f.effectType !== 'plugin:missing/future' || f.descriptorVersion !== 99 || f.enabled || f.status !== 'invalid')
    || blockers.some((b) => !facts.some((f) => f.key === b.key && f.descriptorId === b.descriptorId && f.status === b.status && f.reason === b.reason))) {
    throw new Error('G4 preparation differs from the two reviewed disabled unknown fixture descriptors')
  }
}

export async function runPreparedExport(
  profile: ExportProfile,
  project: SequenceProject,
  write: (event: PreparedExportEvent) => Promise<void>,
  owner: PluginPreparedExportAccessor = productionOwner,
): Promise<ExportResult | undefined> {
  let stage: 'prepare' | 'start' = 'prepare'
  try {
    const port = owner.getPort()
    let prepared: PluginPreparedExportSnapshot
    try { prepared = await port.prepare(profile) }
    catch (cause) { throw new G4PreparedExportFailure(stage, cause) }
    // Public string capabilities are deliberately absent from durable evidence.
    await write({ phase: 'prepared', status: prepared.status, attempt: prepared.attempt, tokenPresent: prepared.token !== null })
    if (prepared.status === 'blocked') {
      try {
        // The fixed protocol reviews only the two disabled malformed descriptors.
        // Canonical approval still validates the exact token, blockers and source.
        reviewFixtureBlockers(project, prepared)
        prepared = await port.approveReviewedBlockers(prepared.token)
      } catch (cause) { throw new G4PreparedExportFailure(stage, cause) }
      await write({ phase: 'reviewed', status: prepared.status, attempt: prepared.attempt, tokenPresent: prepared.token !== null })
    }
    if (prepared.status !== 'ready') {
      throw new G4PreparedExportFailure(stage, `G4 preparation requires review: ${prepared.status}`)
    }
    await write({ phase: 'started' })
    stage = 'start'
    let result: ExportResult | undefined
    try { result = await port.start(prepared.token) }
    catch (cause) { throw new G4PreparedExportFailure(stage, cause) }
    await write({ phase: 'completed', destination: result?.destination ?? null })
    return result
  } catch (cause) {
    await write({ phase: 'failed', stage, error: String(cause) })
    throw cause
  } finally {
    // Close drains retained attempts, consumed execution and document subscriptions.
    // Cleanup/evidence failures propagate; they cannot count as expected font refusal.
    await owner.close('issue199-g4-attempt-finished')
    await write({ phase: 'closed' })
  }
}
