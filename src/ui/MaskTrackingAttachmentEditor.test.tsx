import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { attributeClip, ATTRIBUTE_ASSET_DESCRIPTOR } from '../test/clipAttributeFixtures'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { createMaskEffect } from '../domain/effectStack'
import { defaultSourceTimeMap } from '../domain/sourceTimeMap'
import type { MediaAsset, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useMotionTrackingSelectionStore } from '../state/motionTrackingSelectionStore'
import { useTransportStore } from '../state/transportStore'
import { setActiveLocalProjectBindingId } from '../app/localProjectProvenance'
import { cancelMotionTracking } from '../app/motionTrackingController'
import MotionTrackingEditor from './MotionTrackingEditor'

const runtime = vi.hoisted(() => ({ analyze: vi.fn(), subscribe: vi.fn(() => () => {}), cancelClipKind: vi.fn(() => false) }))
vi.mock('../app/motionAnalysisRuntime', () => ({ getMotionAnalysisController: () => runtime }))
const sourceTarget = JSON.stringify(['source', 'source-mask'])
const otherTarget = JSON.stringify(['target', 'target-mask'])

beforeEach(() => {
  runtime.analyze.mockReset(); runtime.subscribe.mockClear(); runtime.cancelClipKind.mockClear()
  useTransportStore.getState().resetTransport(); useMotionTrackingSelectionStore.getState().clear()
  setActiveLocalProjectBindingId('legacy-document:mask-tracking-ui')
  const doc = structuredClone(createTimelineDoc('Tracking UI', DEFAULT_PROJECT_SETTINGS, 'mask-tracking-ui'))
  const source = attributeClip('source'), target = attributeClip('target')
  source.name = 'Source'; target.name = 'Target'; target.assetId = 'target-asset'
  source.timelineRange.durationFrames = source.sourceRange.durationFrames = 3
  source.sourceTimeMap = defaultSourceTimeMap(0, 3)
  source.effects = [createMaskEffect('source-mask', 'rectangle')]; target.effects = [createMaskEffect('target-mask', 'rectangle')]
  source.effects[0]!.params.width = target.effects[0]!.params.width = 0.2
  doc.tracks[0]!.clips = [source]; doc.tracks.push({ ...doc.tracks[0]!, id: 'target-track', clips: [target] })
  useDocumentStore.getState().setDoc(doc); useTransportStore.getState().setSelectedClip('source')
  const descriptor = { ...ATTRIBUTE_ASSET_DESCRIPTOR, sourceBounds: { video: { status: 'exact' as const, firstTimestampUs: 0, endTimestampUs: 30_000_000 }, audio: null } }
  const asset: MediaAsset = { ...descriptor, objectUrl: 'blob:source-fixture', durationFrames: 900, frameRate: descriptor.nativeFrameRate, decoderConfigB64: null }
  useMediaStore.setState({ assets: new Map([['asset', asset], ['target-asset', { ...asset, id: 'target-asset', objectUrl: 'blob:target-fixture' }]]), descriptors: new Map([['asset', descriptor], ['target-asset', { ...descriptor, id: 'target-asset' }]]), collections: [] })
})
afterEach(() => { cancelMotionTracking('source'); useTransportStore.getState().resetTransport(); useMotionTrackingSelectionStore.getState().clear() })

function Harness() {
  const doc = useDocumentStore((state) => state.doc), playheadFrame = useTransportStore((state) => state.playheadFrame)
  return <MotionTrackingEditor clip={doc.tracks[0]!.clips[0]!} locked={doc.tracks[0]!.locked} playheadFrame={playheadFrame} />
}
function editDoc(edit: (doc: TimelineDoc) => void) {
  act(() => { const doc = structuredClone(useDocumentStore.getState().doc); edit(doc); useDocumentStore.getState().setDoc(doc) })
}
async function analyze(user: ReturnType<typeof userEvent.setup>, kind: 'point' | 'box' = 'point') {
  await user.click(screen.getByRole('button', { name: kind === 'point' ? 'Pick point' : 'Draw box' }))
  const selection = kind === 'point' ? { kind: 'point' as const, point: { x: 0.5, y: 0.5 } } : { kind: 'box' as const, box: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 } }
  act(() => useMotionTrackingSelectionStore.getState().setSelection('source', selection, 0))
  const analysis = { version: 1, kind, direction: 'forward', selectionLocalFrame: 0, width: 320, height: 180, failure: null,
    samples: [0, 1, 2].map((localFrame) => ({ localFrame, sourceTimeTicks: localFrame * 1_000_000, timestampUs: Math.round(localFrame * 1_000_000 / 30), x: kind === 'point' ? 160 + 2 * localFrame : 80, y: kind === 'point' ? 90 + localFrame : 45, confidence: 1,
      ...(kind === 'box' ? { width: 80 + localFrame * 2, height: 45 + localFrame } : {}),
    })),
  }
  runtime.analyze.mockResolvedValueOnce({ fromCache: true, entry: { cacheKey: 'ui-cache-fixture' }, bytes: new TextEncoder().encode(JSON.stringify(analysis)) })
  await user.click(screen.getByRole('button', { name: /^Analyze$/ }))
  await waitFor(() => expect(screen.getByText('Tracking is ready from the local cache.')).toBeVisible())
}
async function maskMode(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('Attach tracking to'), 'mask-effect')
  await waitFor(() => expect(screen.getByLabelText('Mask tracking target')).toHaveValue(sourceTarget))
}

test('source masks are offered separately from forbidden source transforms, with actual preview, one Apply and undo', async () => {
  const user = userEvent.setup(); render(<Harness />)
  const transformTargets = screen.getByLabelText('Motion tracking target clip')
  expect(within(transformTargets).queryByRole('option', { name: 'Source' })).toBeNull()
  await maskMode(user)
  expect(screen.queryByLabelText('Motion tracking target clip')).toBeNull()
  expect(within(screen.getByLabelText('Mask tracking target')).getByRole('option', { name: 'Source · Mask 1 (source clip)' })).toBeVisible()
  await analyze(user)
  expect(screen.getByText(/keys interpolate linearly between accepted samples/)).toBeVisible()
  expect(screen.getByText(/Attach Left and Top to Source/)).toBeVisible()
  const before = useDocumentStore.getState().project
  await user.click(screen.getByLabelText('Preview accepted mask tracking at the playhead'))
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [] })
  act(() => useTransportStore.getState().setPlayheadFrame(3)); expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  act(() => useTransportStore.getState().setPlayheadFrame(2)); expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  await user.click(screen.getByRole('button', { name: 'Apply mask tracking' }))
  const applied = useDocumentStore.getState().project
  expect(applied).not.toBe(before); expect(useDocumentStore.getState().past).toEqual([before])
  expect(useDocumentStore.getState().doc.tracks[0]!.clips[0]!.animation!.effectTracks!.map((track) => track.parameter)).toEqual(['x', 'y'])
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  expect(screen.getByRole('button', { name: 'Apply mask tracking' })).toBeDisabled()
  expect(screen.getByText('Mask tracking applied as ordinary keyframes in one undo step.')).toBeVisible()
  act(() => useDocumentStore.getState().undo()); expect(useDocumentStore.getState().project).toBe(before)
  act(() => useDocumentStore.getState().redo()); expect(useDocumentStore.getState().project).toBe(applied)
})

test('replacement names the exact mask and whole owned lanes; off-range changes require fresh consent', async () => {
  editDoc((doc) => { doc.tracks.at(-1)!.clips[0]!.animation!.effectTracks = [{ effectId: 'target-mask', parameter: 'x', keyframes: [{ frame: 100, sourceTimeTicks: 100_000_000, value: 0.4, easing: { type: 'hold' } }] }] })
  const user = userEvent.setup(); render(<Harness />); await maskMode(user)
  await user.selectOptions(screen.getByLabelText('Mask tracking target'), otherTarget)
  await analyze(user)
  const replacement = () => screen.getByLabelText('Replace all Left and Top keys on Target · Mask 1, including keys outside the accepted range')
  expect(screen.getByRole('button', { name: 'Apply mask tracking' })).toBeDisabled()
  await user.click(replacement()); expect(screen.getByRole('button', { name: 'Apply mask tracking' })).toBeEnabled()
  await user.click(screen.getByLabelText('Preview accepted mask tracking at the playhead'))
  editDoc((doc) => { doc.tracks.at(-1)!.clips[0]!.animation!.effectTracks![0]!.keyframes[0]!.value = 0.5 })
  await waitFor(() => expect(replacement()).not.toBeChecked())
  expect(screen.getByRole('button', { name: 'Apply mask tracking' })).toBeDisabled()
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  const before = useDocumentStore.getState().project
  await user.click(replacement()); await user.click(screen.getByRole('button', { name: 'Apply mask tracking' }))
  expect(useDocumentStore.getState().past).toEqual([before])
  expect(useDocumentStore.getState().doc.tracks.at(-1)!.clips[0]!.animation!.effectTracks!.find((track) => track.parameter === 'x')!.keyframes.map((key) => key.frame)).toEqual([0, 1, 2])
})

test('box controls disclose size without rotation and position-only Apply preserves existing size lanes', async () => {
  editDoc((doc) => { doc.tracks.at(-1)!.clips[0]!.animation!.effectTracks = ['width', 'height'].map((parameter) => ({ effectId: 'target-mask', parameter, keyframes: [{ frame: 0, sourceTimeTicks: 0, value: 0.2, easing: { type: 'linear' } }] })) })
  const user = userEvent.setup(); render(<Harness />); await maskMode(user)
  await user.selectOptions(screen.getByLabelText('Mask tracking target'), otherTarget)
  await analyze(user, 'box')
  expect(screen.getByText('Box size uses project-axis bounds. The mask does not follow rotation.')).toBeVisible()
  expect(screen.getByLabelText(/Replace all Left, Top, Width and Height keys on Target/)).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Apply mask tracking' })).toBeDisabled()
  await user.click(screen.getByLabelText('Track mask size (Width and Height)'))
  expect(screen.queryByLabelText(/Replace all/)).toBeNull()
  const retained = useDocumentStore.getState().doc.tracks.at(-1)!.clips[0]!.animation!.effectTracks!
  await user.click(screen.getByRole('button', { name: 'Apply mask tracking' }))
  expect(useDocumentStore.getState().doc.tracks.at(-1)!.clips[0]!.animation!.effectTracks!.slice(0, 2)).toEqual(retained)
})

test('losing the selected connected mask clears preview and requires choosing a target, without silently switching clips', async () => {
  const user = userEvent.setup(); render(<Harness />); await maskMode(user)
  await user.selectOptions(screen.getByLabelText('Mask tracking target'), otherTarget); await analyze(user)
  await user.click(screen.getByLabelText('Preview accepted mask tracking at the playhead'))
  act(() => { const assets = new Map(useMediaStore.getState().assets); assets.delete('target-asset'); useMediaStore.setState({ assets }) })
  expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  expect(screen.getByLabelText('Mask tracking target')).toHaveValue(otherTarget)
  expect(screen.getByRole('option', { name: 'Selected mask is unavailable' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Apply mask tracking' })).toBeDisabled()
  expect(useDocumentStore.getState().past).toEqual([])
})

test('changing attachment mode or unmounting disposes only the mask preview', async () => {
  const user = userEvent.setup(), view = render(<Harness />); await maskMode(user); await analyze(user)
  await user.click(screen.getByLabelText('Preview accepted mask tracking at the playhead'))
  const doc = useDocumentStore.getState().doc
  act(() => useTransportStore.getState().setAnimationPreview({ sequenceId: doc.id, document: doc }))
  await user.selectOptions(screen.getByLabelText('Attach tracking to'), 'clip-transform')
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('animation-gesture')
  act(() => useTransportStore.getState().setAnimationPreview(null)); expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  await maskMode(user); await user.click(screen.getByLabelText('Preview accepted mask tracking at the playhead'))
  expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-tracking')
  view.unmount(); expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
})
