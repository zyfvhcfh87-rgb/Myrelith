import { describe, expect, test } from 'vitest'
import type { RecoveryJournalSummary } from '../state/projectLibraryStore'
import {
  groupRecoveryJournals,
  staleRecoveryJournals,
  STALE_RECOVERY_AGE_MS,
} from './projectRecoveryModel'

function recovery(
  journalId: string,
  projectName: string,
  projectFileName: string | null,
  updatedAt: number,
): RecoveryJournalSummary {
  return {
    journalId,
    documentId: `document-${journalId}`,
    projectName,
    projectFileName,
    updatedAt,
    generationCount: 1,
  }
}

describe('project recovery model', () => {
  test('filters by project or file name and groups compact rows by local age', () => {
    const now = new Date(2026, 7, 9, 12).getTime()
    const groups = groupRecoveryJournals([
      recovery('today-z', 'Zulu', 'zulu.myrelith', now - 1_000),
      recovery('today-a', 'Alpha', null, now - 2_000),
      recovery('week', 'Field notes', 'brussels.myrelith', now - 2 * 86_400_000),
      recovery('older', 'Archive', null, now - 10 * 86_400_000),
    ], { query: '', sort: 'name', now })

    expect(groups.map((group) => group.label)).toEqual([
      'Today',
      'Past 7 days',
      'Older',
    ])
    expect(groups[0]?.recoveries.map((entry) => entry.projectName))
      .toEqual(['Alpha', 'Zulu'])
    expect(groupRecoveryJournals([
      recovery('file-match', 'Unrelated', 'brussels.myrelith', now),
    ], { query: 'BRUSSELS', sort: 'newest', now })).toHaveLength(1)
    expect(groupRecoveryJournals([
      recovery('today', 'Today', null, now),
      recovery('older', 'Older', null, now - 10 * 86_400_000),
    ], { query: '', sort: 'oldest', now }).map((group) => group.label))
      .toEqual(['Older', 'Today'])
  })

  test('selects only recovery copies at least 30 days old for cleanup', () => {
    const now = 9_000_000_000
    expect(staleRecoveryJournals([
      recovery('exact', 'Exact', null, now - STALE_RECOVERY_AGE_MS),
      recovery('newer', 'Newer', null, now - STALE_RECOVERY_AGE_MS + 1),
    ], now).map((entry) => entry.journalId)).toEqual(['exact'])
  })
})
