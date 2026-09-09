import { beforeEach, describe, expect, test } from 'vitest'
import { expandedTitleProject, legacyTitleProject } from '../test/titleOwnerFixtures'
import { opaqueTitleHistoryProject, opaqueTitleWithBytes } from '../test/titleBudgetFixtures'
import { projectTitleAnimationOwners } from '../domain/animationProjectBudget'
import { retainedTitleDataBudget, TITLE_BUDGET_LIMITS } from '../domain/titleBudgets'
import { TITLE_LIMITS } from '../domain/titleElements'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore, retainedEffectPreviewDocuments } from '../state/transportStore'
import { useMediaStore } from '../state/mediaStore'
import { useTitleEditorStore } from '../state/titleEditorStore'
import { animationRetentionError } from './projectAnimationRetention'
import { beginTitleEdit } from './titleEditingController'
import { planTitleEdit } from '../domain/titleEditing'
const target = { sequenceId: 'root', clipId: 'root-text' }
beforeEach(() => {
  useTransportStore.getState().resetTransport(); useDocumentStore.getState().setProject(expandedTitleProject())
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  useTransportStore.getState().setSelectedClip('root-text'); useTitleEditorStore.getState().select('root-text', ['root-element'])
})
describe('cumulative named title preview retention', () => {
  test('the exact 64 MiB boundary includes hidden independent preview owners before title preview or history growth', () => {
    const state = useDocumentStore.getState(), current = projectTitleAnimationOwners(state.project)
    const base = retainedTitleDataBudget({ candidate: [], current, past: [], future: [], clipboards: { titles: [], elements: [], keys: [] } })
    if (!base.ok) throw new Error(base.reason)
    const past = Array.from({ length: 3 }, opaqueTitleHistoryProject), future = [legacyTitleProject()]
    const a = opaqueTitleHistoryProject().sequences[0], b = opaqueTitleHistoryProject().sequences[0]
    // 48 MiB history + 16 MiB across two hidden/visible owners, minus the current title's measured cost.
    b.tracks[0].clips[0] = { ...b.tracks[0].clips[0], title: opaqueTitleWithBytes(TITLE_LIMITS.serializedBytes - base.retainedBytes / 2) }
    useDocumentStore.setState({ past, future })
    useTransportStore.getState().setColorGradingPreview({ sequenceId: 'root', effectId: 'grade', params: {}, document: a })
    useTransportStore.getState().setMaskTrackingPreview({ sequenceId: 'root', document: b }, false)
    const full = useDocumentStore.getState()
    const retained = retainedTitleDataBudget({ candidate: [], current, past: past.map(projectTitleAnimationOwners), future: future.map(projectTitleAnimationOwners),
      previews: retainedEffectPreviewDocuments().map((document) => projectTitleAnimationOwners({ sequences: [document] })), clipboards: { titles: [], elements: [], keys: [] } })
    expect(retained).toEqual({ ok: true, retainedBytes: TITLE_BUDGET_LIMITS.retainedBytes })
    expect(animationRetentionError(full, full.project)).toBeNull()
    const session = beginTitleEdit(target)
    expect(session.preview({ kind: 'values', ids: ['root-element'], values: { 'position-x': 1 } })).toMatch(/64 MiB/)
    expect(useDocumentStore.getState()).toBe(full); expect(useDocumentStore.getState().future).toBe(future)
    session.cancel()
    const candidate = planTitleEdit(full.project, target, { kind: 'add', elementKind: 'rectangle' }, () => 'extra')
    expect(full.commitProjectEdit(full.project, full.projectGeneration, candidate)).toMatch(/64 MiB/)
    expect(useDocumentStore.getState()).toBe(full)
    useTransportStore.getState().setMaskTrackingPreview(null)
    expect(full.commitProjectEdit(full.project, full.projectGeneration, candidate)).toBeNull()
  }, 30000)
  test('shared immutable title references across all five owners are charged once and reset releases all', () => {
    const state = useDocumentStore.getState(), transport = useTransportStore.getState(), document = state.doc
    transport.setColorGradingPreview({ sequenceId: 'root', effectId: 'grade', params: {}, document })
    transport.setMaskPreview({ sequenceId: 'root', effectId: 'mask', params: {}, document })
    transport.setAnimationPreview({ sequenceId: 'root', document }); transport.setMaskTrackingPreview({ sequenceId: 'root', document }, false)
    transport.setTitleDocumentPreview({ sequenceId: 'root', document })
    expect(retainedEffectPreviewDocuments()).toHaveLength(5)
    const current = projectTitleAnimationOwners(state.project), base = { candidate: [], current, past: [], future: [], clipboards: { titles: [], elements: [], keys: [] } }
    expect(retainedTitleDataBudget({ ...base, previews: retainedEffectPreviewDocuments().map((document) => projectTitleAnimationOwners({ sequences: [document] })) })).toEqual(retainedTitleDataBudget(base))
    transport.resetTransport(); expect(retainedEffectPreviewDocuments()).toEqual([])
  })
})
