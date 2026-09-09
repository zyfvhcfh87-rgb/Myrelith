import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ATTRIBUTE_ASSET_DESCRIPTOR, attributeClip } from '../test/clipAttributeFixtures'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { createMaskEffect } from '../domain/effectStack'
import { createMotionTrackingSamplePlan, type MotionTrackingDirection, type MotionTrackingSelection } from '../domain/motionTracking'
import { resolveClipAnimationAtFrame } from '../domain/clipAnimation'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from '../domain/projectFile'
import { replaceProjectSequence } from '../domain/projectSequences'
import { applyMaskTrackingWithResult } from '../domain/operations/maskTracking'
import { exactLegacyTitleFile, titleProjectFromFile } from '../test/titleFileBoundaryFixtures'
import type { MediaAsset, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useMotionTrackingSelectionStore } from '../state/motionTrackingSelectionStore'
import { useTransportStore } from '../state/transportStore'
import { setActiveLocalProjectBindingId } from './localProjectProvenance'
import { analyzeMotionTracking, beginMaskMotionTrackingReview, cancelMotionTracking, motionTrackingSessionCurrentReason, planMotionTrackingAttachment, type MaskMotionTrackingReview, type MotionTrackingSession } from './motionTrackingController'

const runtime = vi.hoisted(() => ({ analyze: vi.fn(), cancelClipKind: vi.fn() }))
vi.mock('./motionAnalysisRuntime', () => ({ getMotionAnalysisController: () => runtime }))
const target = { kind: 'mask-effect' as const, clipId: 'target', effectId: 'target-mask' }
const point: MotionTrackingSelection = { kind: 'point', point: { x: 0.5, y: 0.5 } }
const reviews: MaskMotionTrackingReview[] = []

beforeEach(() => {
  runtime.analyze.mockReset(); runtime.cancelClipKind.mockReset()
  useTransportStore.getState().resetTransport()
  useMotionTrackingSelectionStore.getState().clear()
  setActiveLocalProjectBindingId('legacy-document:mask-tracking')
  const doc = structuredClone(createTimelineDoc('Tracking', DEFAULT_PROJECT_SETTINGS, 'mask-tracking'))
  const source = attributeClip('source'), destination = attributeClip('target')
  source.effects = [createMaskEffect('source-mask', 'rectangle')]
  destination.assetId = 'target-asset'; destination.effects = [createMaskEffect('target-mask', 'rectangle')]
  source.effects[0]!.params.width = destination.effects[0]!.params.width = 0.2
  doc.tracks[0]!.clips = [source]
  doc.tracks.push({ ...doc.tracks[0]!, id: 'target-track', clips: [destination] })
  useDocumentStore.getState().setDoc(doc)
  useTransportStore.getState().setSelectedClip('source')
  const descriptor = { ...ATTRIBUTE_ASSET_DESCRIPTOR, sourceBounds: { video: { status: 'exact' as const, firstTimestampUs: 0, endTimestampUs: 30_000_000 }, audio: null } }
  const asset: MediaAsset = { ...descriptor, objectUrl: 'blob:source-fixture', durationFrames: 900, frameRate: descriptor.nativeFrameRate, decoderConfigB64: null }
  useMediaStore.setState({ assets: new Map([['asset', asset], ['target-asset', { ...asset, id: 'target-asset', objectUrl: 'blob:target-fixture' }]]), descriptors: new Map([['asset', descriptor], ['target-asset', { ...descriptor, id: 'target-asset' }]]), collections: [] })
})
afterEach(() => { for (const review of reviews.splice(0)) review.cancel(); useTransportStore.getState().resetTransport(); useMotionTrackingSelectionStore.getState().clear() })

async function session(direction: MotionTrackingDirection = 'forward', selectionGlobalFrame = 0): Promise<MotionTrackingSession> {
  const doc = useDocumentStore.getState().doc, sourceClip = doc.tracks[0]!.clips[0]!, source = { width: 1920, height: 1080, firstTimestampUs: 0, frameRate: doc.frameRate }
  const samplePlan = createMotionTrackingSamplePlan(doc, sourceClip, source, { firstTimestampUs: 0, endTimestampUs: 30_000_000 }, selectionGlobalFrame, direction)
  const analysis = { version: 1, kind: 'point', direction, selectionLocalFrame: selectionGlobalFrame, width: 320, height: 180,
    failure: { localFrame: samplePlan.sampleLocalFrames[3], code: 'lost-point', detail: 'First rejected pair.' },
    samples: samplePlan.sampleLocalFrames.slice(0, 3).map((localFrame, index) => ({ localFrame, sourceTimeTicks: samplePlan.sampleSourceTimeTicks[index], timestampUs: samplePlan.sampleTimestampsUs[index], x: 160 + index * 2, y: 90 + index, confidence: 1 - index * 0.1 })),
  }
  runtime.analyze.mockResolvedValueOnce({ fromCache: true, entry: { cacheKey: 'tracking-fixture' }, bytes: new TextEncoder().encode(JSON.stringify(analysis)) })
  useMotionTrackingSelectionStore.getState().setSelection('source', point, selectionGlobalFrame)
  useTransportStore.getState().setPlayheadFrame(selectionGlobalFrame)
  return analyzeMotionTracking({ sourceClipId: 'source', selectionGlobalFrame, direction, selection: point })
}
function reviewed(session: MotionTrackingSession, selected = target, onEnd?: () => void): MaskMotionTrackingReview {
  const result = planMotionTrackingAttachment(session, selected, false)
  if (!result.ok) throw new Error(result.reason)
  if (result.kind !== 'mask-effect') throw new Error('Wrong target kind')
  const review = beginMaskMotionTrackingReview(session, selected, false, result.plan.reviewKey, onEnd)
  reviews.push(review)
  return review
}
function editDoc(edit: (doc: TimelineDoc) => void) {
  const doc = structuredClone(useDocumentStore.getState().doc); edit(doc); useDocumentStore.getState().setDoc(doc)
}

test('ordinary mask preview is temporary, accepted-range bounded, one undoable Apply and portable round-trip', async () => {
  const analyzed = await session(), before = useDocumentStore.getState().project, future = [before]
  useDocumentStore.setState({ future })
  const review = reviewed(analyzed)
  expect(review.preview(true)).toBeNull()
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  useTransportStore.getState().setPlayheadFrame(2)
  const preview = useTransportStore.getState().effectDocumentPreview!.document
  expect(resolveClipAnimationAtFrame(preview.tracks.at(-1)!.clips[0]!, 2).effects[0]!.params.x).toBeCloseTo(24 / 1920)
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [], future })
  expect(useDocumentStore.getState().future).toBe(future)
  useTransportStore.getState().setPlayheadFrame(3); expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  useTransportStore.getState().setPlayheadFrame(0); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  expect(review.apply(null)).toEqual({ ok: true, changed: true })
  const applied = useDocumentStore.getState()
  expect(applied.past).toEqual([before]); expect(applied.future).toEqual([])
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  const serialized = serializeProjectFile(createProjectFileSnapshot(applied.project, useMediaStore.getState().descriptors.values()))
  expect(parseProjectFile(serialized).sequences[0]!.tracks.at(-1)!.clips[0]!.animation).toEqual(applied.doc.tracks.at(-1)!.clips[0]!.animation)
  useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project).toBe(before)
  useDocumentStore.getState().redo(); expect(useDocumentStore.getState().project).toBe(applied.project)
  expect(review.apply(null).ok).toBe(false)
})

test('same-clip mask dispatch succeeds, self-transform stays forbidden and Apply invalidates the old source session', async () => {
  const analyzed = await session()
  expect(planMotionTrackingAttachment(analyzed, { kind: 'clip-transform', clipId: 'source' }, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/separate/) })
  const review = reviewed(analyzed, { kind: 'mask-effect', clipId: 'source', effectId: 'source-mask' })
  expect(review.preview(true)).toBeNull()
  expect(review.apply(null).ok).toBe(true)
  expect(motionTrackingSessionCurrentReason(analyzed)).toMatch(/source clip, mapping, selection, or project changed/)
  expect(planMotionTrackingAttachment(analyzed, { kind: 'mask-effect', clipId: 'source', effectId: 'source-mask' }, false).ok).toBe(false)
})

test('backward preview clears on both sides of the accepted range and restores on reentry', async () => {
  const analyzed = await session('backward', 10), review = reviewed(analyzed)
  expect(review.plan).toMatchObject({ firstAcceptedGlobalFrame: 8, lastAcceptedGlobalFrame: 10 })
  expect(review.preview(true)).toBeNull()
  for (const frame of [7, 11]) { useTransportStore.getState().setPlayheadFrame(frame); expect(useTransportStore.getState().effectDocumentPreview).toBeNull() }
  for (const frame of [8, 10, 9]) { useTransportStore.getState().setPlayheadFrame(frame); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking') }
  review.cancel(); expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
})

test.each(['project', 'generation', 'sequence', 'selection', 'secondary-selection', 'tracking-pick', 'tracking-selection', 'reset', 'source-offline', 'target-offline', 'target-replaced', 'target-locked', 'effect-changed', 'source-geometry'] as const)('%s cancels the complete review synchronously without touching history or redo', async (change) => {
  const analyzed = await session(), onEnd = vi.fn(), review = reviewed(analyzed, target, onEnd)
  review.preview(true)
  const before = useDocumentStore.getState().project, future = [before]
  useDocumentStore.setState({ future })
  if (change === 'project') useDocumentStore.getState().setProject({ ...before })
  if (change === 'generation') useDocumentStore.setState({ projectGeneration: useDocumentStore.getState().projectGeneration + 1 })
  if (change === 'sequence') useDocumentStore.setState({ activeSequenceId: 'other' })
  if (change === 'selection') useTransportStore.getState().setSelectedClip('target')
  if (change === 'secondary-selection') useTransportStore.getState().setClipSelection(['source', 'target'], 'source')
  if (change === 'tracking-pick') useMotionTrackingSelectionStore.getState().beginPicking('source', 'box')
  if (change === 'tracking-selection') useMotionTrackingSelectionStore.getState().setSelection('source', { kind: 'point', point: { x: 0.6, y: 0.5 } }, 0)
  if (change === 'reset') useTransportStore.getState().resetTransport()
  if (change === 'source-offline' || change === 'target-offline') {
    const assets = new Map(useMediaStore.getState().assets); assets.delete(change === 'source-offline' ? 'asset' : 'target-asset'); useMediaStore.setState({ assets })
  }
  if (change === 'target-replaced' || change === 'source-geometry') {
    const assets = new Map(useMediaStore.getState().assets), id = change === 'target-replaced' ? 'target-asset' : 'asset'
    assets.set(id, { ...assets.get(id)!, ...(change === 'target-replaced' ? { objectUrl: 'blob:replacement' } : { width: 1280 }) }); useMediaStore.setState({ assets })
  }
  if (change === 'target-locked') editDoc((doc) => { doc.tracks.at(-1)!.locked = true })
  if (change === 'effect-changed') editDoc((doc) => { doc.tracks.at(-1)!.clips[0]!.effects[0]!.enabled = false })
  const afterChange = useDocumentStore.getState()
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  expect(onEnd).toHaveBeenCalledTimes(1)
  expect(review.apply(null).ok).toBe(false)
  expect(useDocumentStore.getState().project).toBe(afterChange.project)
  expect(useDocumentStore.getState().past).toBe(afterChange.past)
  expect(useDocumentStore.getState().future).toBe(afterChange.future)
  if (!['project', 'target-locked', 'effect-changed'].includes(change)) expect(useDocumentStore.getState().future).toBe(future)
})

test('reentrant cleanup cannot commit over a replacement review or changed selection', async () => {
  const analyzed = await session(), before = useDocumentStore.getState().project
  const first = reviewed(analyzed, target, () => { reviewed(analyzed).preview(true) })
  first.preview(true)
  expect(first.apply(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/during cleanup/) })
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [] })
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  reviews.at(-1)!.cancel()
  const second = reviewed(analyzed, target, () => useTransportStore.getState().setSelectedClip('target'))
  expect(second.apply(null).ok).toBe(false)
  expect(useDocumentStore.getState().project).toBe(before)
})

test('owned preview arbitration restores a sibling and background frame changes do not steal activation', async () => {
  const analyzed = await session(), review = reviewed(analyzed), doc = useDocumentStore.getState().doc
  useTransportStore.getState().setColorGradingPreview({ sequenceId: doc.id, effectId: 'grading', params: {}, document: doc })
  review.preview(true); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  useTransportStore.getState().setMaskPreview({ sequenceId: doc.id, effectId: 'gesture', params: {}, document: doc })
  useTransportStore.getState().setAnimationPreview({ sequenceId: doc.id, document: doc })
  useTransportStore.getState().setPlayheadFrame(1)
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('animation-gesture')
  useTransportStore.getState().setAnimationPreview(null)
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-gesture')
  useTransportStore.getState().setMaskPreview(null); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  review.cancel(); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('color-grading')
})

test('analysis-kind cancellation clears only a review attached to that tracked source', async () => {
  const analyzed = await session(), review = reviewed(analyzed), ended = vi.fn()
  review.cancel()
  const active = reviewed(analyzed, target, ended); active.preview(true)
  expect(cancelMotionTracking('target')).toBe(false)
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  expect(cancelMotionTracking('source')).toBe(true)
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  expect(ended).toHaveBeenCalledTimes(1)
  expect(runtime.cancelClipKind.mock.calls).toEqual([['target', 'point-tracking'], ['target', 'box-tracking'], ['source', 'point-tracking'], ['source', 'box-tracking']])
})

test('fresh planning rejects changed decode dimensions, schedules and exact target replacement consent', async () => {
  const analyzed = await session()
  expect(planMotionTrackingAttachment({ ...analyzed, analysis: { ...analyzed.analysis, width: 319 } }, target, false).ok).toBe(false)
  expect(planMotionTrackingAttachment({ ...analyzed, analysis: { ...analyzed.analysis, samples: analyzed.analysis.samples.slice(0, 2) } as typeof analyzed.analysis }, target, false).ok).toBe(false)
  editDoc((doc) => { doc.tracks.at(-1)!.clips[0]!.animation!.effectTracks = [{ effectId: 'target-mask', parameter: 'x', keyframes: [{ frame: 100, sourceTimeTicks: 100_000_000, value: 0.5, easing: { type: 'linear' } }] }] })
  const freshSession = await session(), before = useDocumentStore.getState().project, future = [before]
  useDocumentStore.setState({ future })
  const review = reviewed(freshSession)
  expect(review.plan.replacementRequired).toBe(true)
  expect(review.apply(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/confirmation/) })
  expect(useDocumentStore.getState().future).toBe(future)
  const confirmed = reviewed(freshSession)
  expect(confirmed.apply(confirmed.plan.reviewKey)).toEqual({ ok: true, changed: true })
  expect(useDocumentStore.getState().past).toEqual([before])
})

test('the complete portable media envelope is required before preview and freshly checked before Apply', async () => {
  const analyzed = await session(), before = useDocumentStore.getState().project, future = [before]
  useDocumentStore.setState({ future })
  const descriptors = useMediaStore.getState().descriptors
  useMediaStore.setState({ descriptors: new Map() })
  expect(() => reviewed(analyzed)).toThrow(/asset|descriptor|media/i)
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  expect(useDocumentStore.getState().future).toBe(future)
  useMediaStore.setState({ descriptors })
  const review = reviewed(analyzed); review.preview(true)
  useMediaStore.setState({ descriptors: new Map() })
  expect(review.apply(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/asset|descriptor|media/i) })
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [], future })
  expect(useDocumentStore.getState().future).toBe(future)
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
})

test('Apply requires paused playback and an unchanged reviewed candidate', async () => {
  const analyzed = await session(), review = reviewed(analyzed), before = useDocumentStore.getState().project
  useTransportStore.getState().setIsPlaying(true)
  expect(review.apply(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/Pause playback/) })
  useTransportStore.getState().setIsPlaying(false)
  const planned = planMotionTrackingAttachment(analyzed, target, false)
  if (!planned.ok || planned.kind !== 'mask-effect') throw new Error('Missing plan')
  expect(() => beginMaskMotionTrackingReview(analyzed, target, false, planned.plan.reviewKey + 'stale')).toThrow(/changed/)
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [] })
})

test('mask dispatch refuses preserved future title owners even if connected media facts remain present', async () => {
  const analyzed = await session()
  editDoc((doc) => { doc.tracks.at(-1)!.clips[0]!.title = { version: 99, future: 'preserve' } })
  expect(planMotionTrackingAttachment(analyzed, target, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/media clip/) })
  expect(useDocumentStore.getState().past).toEqual([])
})

function installDormantKeys(count: number) {
  const project = useDocumentStore.getState().project
  const dormant = structuredClone(project.sequences[0]!), filler = structuredClone(dormant.tracks[0]!.clips[0]!)
  dormant.id = 'dormant-sequence'; filler.id = 'dormant-filler'; filler.effects = []
  filler.animation = { tracks: [], effectTracks: [] }
  let remaining = count
  while (remaining > 0) {
    const length = Math.min(1024, remaining)
    filler.animation.effectTracks!.push({ effectId: `future-${remaining}`, parameter: 'future', keyframes: Array.from({ length }, (_, frame) => ({ frame, sourceTimeTicks: frame * 1_000_000, value: 1, easing: { type: 'linear' } })) })
    remaining -= length
  }
  dormant.tracks = [{ ...dormant.tracks[0]!, id: 'dormant-track', clips: [filler] }]
  useDocumentStore.getState().setProject({ ...project, sequences: [...project.sequences, dormant] })
  expect(serializeProjectFile(createProjectFileSnapshot(useDocumentStore.getState().project, useMediaStore.getState().descriptors.values())).length).toBeLessThanOrEqual(10_000_000)
  return filler
}

test.each([99_995, 100_000])('a valid project with %i dormant keys refuses tracking growth before preview without clearing redo', async (count) => {
  installDormantKeys(count)
  const analyzed = await session(), before = useDocumentStore.getState().project, future = [before]
  useDocumentStore.setState({ future })
  expect(() => reviewed(analyzed)).toThrow(/complete project limits/)
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [], future })
  expect(useDocumentStore.getState().future).toBe(future)
})

test('an all-sequence exact-edge Apply records one real edit; identical tracking remains a genuine no-op at capacity', async () => {
  installDormantKeys(99_994)
  const analyzed = await session(), before = useDocumentStore.getState().project
  const review = reviewed(analyzed); expect(review.preview(true)).toBeNull()
  expect(review.apply(null)).toEqual({ ok: true, changed: true })
  const applied = useDocumentStore.getState()
  expect(applied.project).not.toBe(before); expect(applied.past).toEqual([before])
  expect(applied.doc.tracks.at(-1)!.clips[0]!.animation!.effectTracks!.flatMap((track) => track.keyframes)).toHaveLength(6)
  expect(() => serializeProjectFile(createProjectFileSnapshot(applied.project, useMediaStore.getState().descriptors.values()))).not.toThrow()
  const repeated = reviewed(analyzed)
  expect(repeated.apply(repeated.plan.reviewKey)).toEqual({ ok: true, changed: false })
  expect(useDocumentStore.getState().project).toBe(applied.project)
  expect(useDocumentStore.getState().past).toBe(applied.past)
  useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project).toBe(before)
  useDocumentStore.getState().redo(); expect(useDocumentStore.getState().project).toBe(applied.project)
})

test('fresh Apply refuses a failed all-sequence replacement even when the original project identity survives', async () => {
  const filler = installDormantKeys(99_994)
  const analyzed = await session(), review = reviewed(analyzed), before = useDocumentStore.getState().project, future = [before]
  useDocumentStore.setState({ future }); review.preview(true)
  // Defensive current-boundary case: a consumer changed an existing project object.
  // The still-valid current project now has 99,995 keys; the proposed edit needs six.
  const lane = filler.animation!.effectTracks!.at(-1)!, frame = lane.keyframes.at(-1)!.frame + 1
  lane.keyframes.push({ frame, sourceTimeTicks: frame * 1_000_000, value: 1, easing: { type: 'linear' } })
  expect(review.apply(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/complete project limits/) })
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [], future })
  expect(useDocumentStore.getState().future).toBe(future)
})

test.each(['playing', 'scrubbing'] as const)('cleanup starting %s prevents the final commit and leaves redo intact', async (mode) => {
  const analyzed = await session(), before = useDocumentStore.getState().project, future = [before]
  useDocumentStore.setState({ future })
  const review = reviewed(analyzed, target, () => mode === 'playing' ? useTransportStore.getState().setIsPlaying(true) : useTransportStore.getState().setIsScrubbing(true))
  review.preview(true)
  expect(review.apply(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/playback changed during cleanup/) })
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [], future })
  expect(useDocumentStore.getState().future).toBe(future)
})

test.each(['inside', 'outside'] as const)('passive range reentry preserves a newer preview when tracking was enabled %s its range', async (start) => {
  const analyzed = await session(), review = reviewed(analyzed), doc = useDocumentStore.getState().doc
  if (start === 'outside') useTransportStore.getState().setPlayheadFrame(3)
  review.preview(true)
  useTransportStore.getState().setAnimationPreview({ sequenceId: doc.id, document: doc })
  for (const frame of [3, 1, 4, 0, 2]) {
    useTransportStore.getState().setPlayheadFrame(frame)
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('animation-gesture')
  }
  useTransportStore.getState().setAnimationPreview(null)
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  useTransportStore.getState().setPlayheadFrame(3)
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  review.cancel()
  useTransportStore.getState().setPlayheadFrame(1)
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
})

function currentPortableCharacters(): number {
  return serializeProjectFile(createProjectFileSnapshot(useDocumentStore.getState().project, useMediaStore.getState().descriptors.values())).length
}

function padCurrentProjectTo(characters: number) {
  const file = createProjectFileSnapshot(useDocumentStore.getState().project, useMediaStore.getState().descriptors.values())
  let remaining = characters - serializeProjectFile(file).length
  if (remaining < 0) throw new Error('Boundary padding cannot shrink the current fixture.')
  for (const sequence of file.sequences) for (const track of sequence.tracks) for (const clip of track.clips) if (clip.text) {
    const count = Math.min(20_000 - clip.text.content.length, remaining)
    clip.text.content += 'A'.repeat(count); remaining -= count
  }
  expect(remaining).toBe(0)
  const wire = serializeProjectFile(file)
  expect(wire.length).toBe(characters)
  useDocumentStore.getState().setProject(titleProjectFromFile(parseProjectFile(wire)))
  expect(currentPortableCharacters()).toBe(characters)
}

function installNearFileProject(characters: number) {
  const base = useDocumentStore.getState().project
  // Shared fixture uses real bounded compact title fields; no serializer mock or
  // artificially lowered file limit. Its sequences are dormant beside the media edit.
  const padding = parseProjectFile(exactLegacyTitleFile(9_000_000, 22, false))
  useDocumentStore.getState().setProject({ ...base, sequences: [...base.sequences, ...padding.sequences] })
  padCurrentProjectTo(characters)
}

async function installExactFitTrackingProject(): Promise<MotionTrackingSession> {
  installNearFileProject(9_100_000)
  const analyzed = await session(), planned = planMotionTrackingAttachment(analyzed, target, false)
  if (!planned.ok || planned.kind !== 'mask-effect') throw new Error('Missing mask plan')
  const current = useDocumentStore.getState(), applied = applyMaskTrackingWithResult(current.doc, planned.plan, null)
  if (!applied.ok || !applied.changed) throw new Error('Expected six new tracking keys')
  const candidate = replaceProjectSequence(current.project, current.activeSequenceId, applied.doc)
  const delta = serializeProjectFile(createProjectFileSnapshot(candidate, useMediaStore.getState().descriptors.values())).length - currentPortableCharacters()
  expect(delta).toBeGreaterThan(0)
  padCurrentProjectTo(10_000_000 - delta)
  return session()
}

test.each([9_999_999, 10_000_000])('an actual %i-character portable file refuses tracking growth before preview and preserves redo', async (characters) => {
  installNearFileProject(characters)
  const analyzed = await session(), before = useDocumentStore.getState().project, future = [before]
  useDocumentStore.setState({ future })
  expect(() => reviewed(analyzed)).toThrow(/exceeds 10000000 characters/)
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  expect(useDocumentStore.getState().project).toBe(before)
  expect(useDocumentStore.getState().past).toHaveLength(0)
  expect(useDocumentStore.getState().future).toBe(future)
  expect(currentPortableCharacters()).toBe(characters)
}, 30_000)

test('tracking can reach the actual 10M file edge, round-trip and undo; identical reviewed tracking remains a no-op', async () => {
  const analyzed = await installExactFitTrackingProject(), before = useDocumentStore.getState().project, beforeCharacters = currentPortableCharacters()
  const review = reviewed(analyzed)
  expect(review.preview(true)).toBeNull()
  expect(currentPortableCharacters()).toBe(beforeCharacters)
  expect(review.apply(null)).toEqual({ ok: true, changed: true })
  const applied = useDocumentStore.getState()
  expect(applied.project).not.toBe(before); expect(applied.past).toEqual([before])
  expect(currentPortableCharacters()).toBe(10_000_000)
  const parsed = parseProjectFile(serializeProjectFile(createProjectFileSnapshot(applied.project, useMediaStore.getState().descriptors.values())))
  expect(parsed.sequences[0]!.tracks.at(-1)!.clips[0]!.animation).toEqual(applied.doc.tracks.at(-1)!.clips[0]!.animation)
  const repeated = reviewed(analyzed)
  expect(repeated.apply(repeated.plan.reviewKey)).toEqual({ ok: true, changed: false })
  expect(useDocumentStore.getState().project).toBe(applied.project); expect(useDocumentStore.getState().past).toBe(applied.past)
  useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project).toBe(before); expect(currentPortableCharacters()).toBe(beforeCharacters)
  useDocumentStore.getState().redo(); expect(useDocumentStore.getState().project).toBe(applied.project); expect(currentPortableCharacters()).toBe(10_000_000)
}, 30_000)

test('fresh Apply refuses one extra portable character introduced after review while leaving current project and redo intact', async () => {
  const analyzed = await installExactFitTrackingProject(), before = useDocumentStore.getState().project, beforeCharacters = currentPortableCharacters(), future = [before]
  useDocumentStore.setState({ future })
  const review = reviewed(analyzed); expect(review.preview(true)).toBeNull()
  const descriptors = new Map(useMediaStore.getState().descriptors), descriptor = descriptors.get('target-asset')!
  descriptors.set('target-asset', { ...descriptor, fileName: descriptor.fileName + 'x' })
  useMediaStore.setState({ descriptors })
  expect(currentPortableCharacters()).toBe(beforeCharacters + 1)
  expect(review.apply(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/exceeds 10000000 characters/) })
  expect(useDocumentStore.getState().project).toBe(before); expect(useDocumentStore.getState().past).toHaveLength(0); expect(useDocumentStore.getState().future).toBe(future)
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
}, 30_000)
