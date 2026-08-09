import type { RecoveryJournalSummary } from '../state/projectLibraryStore'

export type RecoverySort = 'newest' | 'oldest' | 'name'
export type RecoveryAgeGroupId = 'today' | 'past-week' | 'older'

export interface RecoveryAgeGroup {
  id: RecoveryAgeGroupId
  label: string
  recoveries: readonly RecoveryJournalSummary[]
}

export const STALE_RECOVERY_AGE_MS = 30 * 24 * 60 * 60 * 1_000

const GROUPS: readonly Omit<RecoveryAgeGroup, 'recoveries'>[] = [
  { id: 'today', label: 'Today' },
  { id: 'past-week', label: 'Past 7 days' },
  { id: 'older', label: 'Older' },
]

function localDayStart(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function ageGroupId(updatedAt: number, now: number): RecoveryAgeGroupId {
  if (updatedAt >= localDayStart(now)) return 'today'
  if (updatedAt >= now - 7 * 24 * 60 * 60 * 1_000) return 'past-week'
  return 'older'
}

function compareRecoveries(
  left: RecoveryJournalSummary,
  right: RecoveryJournalSummary,
  sort: RecoverySort,
): number {
  if (sort === 'oldest') return left.updatedAt - right.updatedAt
  if (sort === 'name') {
    const nameOrder = left.projectName.localeCompare(
      right.projectName,
      undefined,
      { sensitivity: 'base' },
    )
    if (nameOrder !== 0) return nameOrder
  }
  return right.updatedAt - left.updatedAt
}

export function groupRecoveryJournals(
  recoveries: readonly RecoveryJournalSummary[],
  options: {
    query: string
    sort: RecoverySort
    now: number
  },
): RecoveryAgeGroup[] {
  const query = options.query.trim().toLocaleLowerCase()
  const filtered = recoveries.filter((recovery) => {
    if (query.length === 0) return true
    return recovery.projectName.toLocaleLowerCase().includes(query)
      || (recovery.projectFileName ?? '').toLocaleLowerCase().includes(query)
  })
  const buckets = new Map<RecoveryAgeGroupId, RecoveryJournalSummary[]>(
    GROUPS.map((group) => [group.id, []]),
  )
  for (const recovery of filtered) {
    buckets.get(ageGroupId(recovery.updatedAt, options.now))?.push(recovery)
  }
  const groups = options.sort === 'oldest' ? GROUPS.toReversed() : GROUPS
  return groups.flatMap((group) => {
    const entries = buckets.get(group.id) ?? []
    if (entries.length === 0) return []
    return [{
      ...group,
      recoveries: entries.toSorted((left, right) => (
        compareRecoveries(left, right, options.sort)
      )),
    }]
  })
}

export function staleRecoveryJournals(
  recoveries: readonly RecoveryJournalSummary[],
  now: number,
): RecoveryJournalSummary[] {
  return recoveries.filter(
    (recovery) => now - recovery.updatedAt >= STALE_RECOVERY_AGE_MS,
  )
}
