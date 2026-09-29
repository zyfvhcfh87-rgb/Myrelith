import { describe, expect, it } from 'vitest'
import {
  classifyVoiceoverDrafts,
  isVoiceoverDraftDiscardable,
  keptOriginalRemovalEligible,
  voiceoverDraftIdsFromLockNames,
  voiceoverDraftLockName,
  voiceoverSessionOwnsDraft,
  type VoiceoverDraftInfo,
} from './voiceoverDrafts'
import type { VoiceoverSession } from './voiceoverSession'

function draft(id: string, overrides: Partial<VoiceoverDraftInfo> = {}): VoiceoverDraftInfo {
  return { id, sizeBytes: 100, hasJournal: true, ...overrides }
}

const session = (phase: VoiceoverSession['phase'], after?: 'review' | 'cancelled' | 'failed') => ({
  sessionId: 'voiceover_s', destination: {} as never, operation: 1,
  interruption: null, failure: null, phase,
  ...('closing' === phase || 'cleanup-failed' === phase ? { after: after ?? 'review' } : {}),
} as VoiceoverSession)

describe('voiceover draft classification', () => {
  it('classifies kept, live, and orphaned drafts from registry and session facts', () => {
    const drafts = [
      draft('voiceover_a'), // referenced below
      draft('voiceover_b'), // live session, unreferenced
      draft('voiceover_c', { hasJournal: false }), // unreferenced, no session
      draft('voiceover_d'), // referenced AND live (finished Keep lingers)
      draft('voiceover_locked', { sizeBytes: null }), // another tab owns the OPFS lock
    ]
    const classified = classifyVoiceoverDrafts(
      drafts,
      ['voiceover_b', 'voiceover_d'],
      [
        { fileName: 'voiceover_a.wav', projectBindingId: 'project-a', assetId: 'asset_a' },
        { fileName: 'voiceover_d.wav', projectBindingId: 'project-a', assetId: 'asset_d1' },
        { fileName: 'voiceover_d.wav', projectBindingId: 'project-b', assetId: 'asset_d2' },
        // A handle whose name matches no draft must not classify anything.
        { fileName: 'other.wav', projectBindingId: 'project-a', assetId: 'asset_x' },
      ],
    )
    expect(classified.map((item) => item.state)).toEqual(['kept', 'live', 'orphaned', 'kept', 'live'])
    expect(classified[0].assetIds).toEqual(['asset_a'])
    expect(classified[0].references).toEqual([
      { fileName: 'voiceover_a.wav', projectBindingId: 'project-a', assetId: 'asset_a' },
    ])
    expect(classified[1].assetIds).toEqual([])
    expect(classified[3].assetIds).toEqual(['asset_d1', 'asset_d2'])
  })

  it('reports size and journal facts unchanged', () => {
    const classified = classifyVoiceoverDrafts(
      [draft('voiceover_a', { sizeBytes: 42, hasJournal: false })],
      [],
      [],
    )
    expect(classified[0]).toEqual({
      id: 'voiceover_a', fileName: 'voiceover_a.wav', sizeBytes: 42, hasJournal: false,
      state: 'orphaned', assetIds: [], references: [],
    })
  })

  it('matches camera/screen captures by their own file name', () => {
    const classified = classifyVoiceoverDrafts(
      [{ id: 'capture_a', sizeBytes: 10, hasJournal: true, fileName: 'capture_a.mp4' }],
      [],
      [{ fileName: 'capture_a.mp4', projectBindingId: 'p', assetId: 'asset' }],
    )
    expect(classified[0]).toMatchObject({ fileName: 'capture_a.mp4', state: 'kept', assetIds: ['asset'] })
  })

  it('allows discard only for orphaned drafts', () => {
    const classified = classifyVoiceoverDrafts(
      [draft('a'), draft('b'), draft('c')],
      ['b'],
      [{ fileName: 'a.wav', projectBindingId: 'project-a', assetId: 'asset_a' }],
    )
    expect(classified.map(isVoiceoverDraftDiscardable)).toEqual([false, false, true])
  })
})

describe('kept original removal eligibility', () => {
  it('requires referencing assets and rejects any clip-referenced asset', () => {
    expect(keptOriginalRemovalEligible([], [])).toBe(false)
    expect(keptOriginalRemovalEligible(['asset_a'], [])).toBe(true)
    expect(keptOriginalRemovalEligible(['asset_a'], ['asset_a'])).toBe(false)
    expect(keptOriginalRemovalEligible(['asset_a', 'asset_b'], ['asset_b'])).toBe(false)
    expect(keptOriginalRemovalEligible(['asset_a', 'asset_b'], ['other'])).toBe(true)
  })
})

describe('session draft ownership', () => {
  it('treats every unfinished session as owning its draft', () => {
    for (const phase of [
      'preparing', 'counting-in', 'recording', 'review', 'keeping',
      'closing', 'cleanup-failed', 'kept',
    ] as const) {
      expect(voiceoverSessionOwnsDraft(session(phase))).toBe(true)
    }
    // `kept` protects the original even when remembering it failed.
  })

  it('releases drafts of terminal sessions for recovery or discard', () => {
    expect(voiceoverSessionOwnsDraft(null)).toBe(false)
    expect(voiceoverSessionOwnsDraft(session('requesting'))).toBe(false)
    expect(voiceoverSessionOwnsDraft(session('failed'))).toBe(false)
    expect(voiceoverSessionOwnsDraft(session('cancelled'))).toBe(false)
  })
})

describe('voiceover draft lock names', () => {
  it('round-trips draft ids and ignores unrelated or empty lock names', () => {
    const name = voiceoverDraftLockName('voiceover_abc')
    expect(voiceoverDraftIdsFromLockNames([name, 'other-lock', undefined,
      voiceoverDraftLockName('')])).toEqual(['voiceover_abc'])
  })
})
