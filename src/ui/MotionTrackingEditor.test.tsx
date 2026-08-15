import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultClipAnimation } from '../domain/clipAnimation'
import { defaultClipVisualSettings } from '../domain/clipInspector'
import { DEFAULT_MANUAL_LENS_CORRECTION } from '../domain/lensCorrection'
import type { MotionTrackingPlan } from '../domain/motionTracking'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { Clip, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useMotionTrackingSelectionStore } from '../state/motionTrackingSelectionStore'
import { useTransportStore } from '../state/transportStore'

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  apply: vi.fn(),
  cancel: vi.fn(),
  plan: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('../app/motionTrackingController', () => ({
  analyzeMotionTracking: mocks.analyze,
  applyMotionTracking: mocks.apply,
  cancelMotionTracking: mocks.cancel,
  planMotionTracking: mocks.plan,
}))

vi.mock('../app/motionAnalysisRuntime', () => ({
  getMotionAnalysisController: () => ({ subscribe: mocks.subscribe }),
}))

import MotionTrackingEditor from './MotionTrackingEditor'

function clip(): Clip {
  return {
    id: 'source',
    assetId: 'asset-source',
    name: 'Source',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 30 },
    timelineRange: { startFrame: 10, durationFrames: 30 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: defaultClipAnimation(),
    effects: [],
  }
}

function targetClip(): Clip {
  return {
    ...clip(),
    id: 'target',
    name: 'Target',
  }
}

function doc(item: Clip): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'tracking-ui',
    name: 'Tracking UI',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [
      {
        id: 'video',
        kind: 'video',
        name: 'Video',
        clips: [item],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      },
      {
        id: 'target-video',
        kind: 'video',
        name: 'Target video',
        clips: [targetClip()],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      },
    ],
  }
}

const descriptor: PortableAssetDescriptor = {
  id: 'asset-source',
  fileName: 'source.mp4',
  mimeType: 'video/mp4',
  size: 1_024,
  lastModified: 1,
  kind: 'video',
  durationMicroseconds: 1_000_000,
  sourceBounds: {
    video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 1_000_000 },
    audio: null,
  },
  nativeFrameRate: { num: 30, den: 1 },
  width: 1_920,
  height: 1_080,
  hasAudio: false,
  audioSampleRate: null,
  audioChannels: null,
}

function plan(): MotionTrackingPlan {
  return {
    sourceClipId: 'source',
    targetClipId: 'target',
    kind: 'point',
    includeScale: false,
    direction: 'forward',
    sampleCount: 2,
    confidenceMinimum: 0.8,
    confidenceMean: 0.9,
    stopped: null,
    replacementRequired: false,
    tracks: [
      {
        property: 'position-x',
        keyframes: [
          { frame: 2, sourceTimeTicks: 2_000_000, value: 0, easing: { type: 'linear' } },
          { frame: 3, sourceTimeTicks: 3_000_000, value: 2, easing: { type: 'linear' } },
        ],
      },
      {
        property: 'position-y',
        keyframes: [
          { frame: 2, sourceTimeTicks: 2_000_000, value: 0, easing: { type: 'linear' } },
          { frame: 3, sourceTimeTicks: 3_000_000, value: 1, easing: { type: 'linear' } },
        ],
      },
    ],
  }
}

beforeEach(() => {
  const item = clip()
  useDocumentStore.getState().setDoc(doc(item))
  useMediaStore.setState({ descriptors: new Map([[descriptor.id, descriptor]]) })
  useMotionTrackingSelectionStore.getState().clear()
  useTransportStore.getState().setClipVisualPreview(null)
  const session = {
    sourceClipId: item.id,
    analysis: { kind: 'point', failure: null },
    fromCache: true,
  }
  mocks.analyze.mockReset().mockResolvedValue(session)
  mocks.plan.mockReset().mockReturnValue({ ok: true, plan: plan() })
  mocks.apply.mockReset().mockReturnValue({ ok: true, changed: true, plan: plan() })
  mocks.cancel.mockReset().mockReturnValue(true)
  mocks.subscribe.mockReset().mockReturnValue(() => undefined)
})

describe('MotionTrackingEditor', () => {
  test('disables tracking authoring for a lens-corrected source', async () => {
    const item = {
      ...clip(),
      lensCorrection: {
        ...DEFAULT_MANUAL_LENS_CORRECTION,
        k1: 0.1,
      },
    }
    useDocumentStore.getState().setDoc(doc(item))
    useMotionTrackingSelectionStore.getState().beginPicking(item.id, 'point')

    render(<MotionTrackingEditor clip={item} locked={false} playheadFrame={12} />)

    expect(screen.getByRole('button', { name: 'Pick point' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Draw box' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Motion tracking is unavailable while manual lens correction is enabled.',
    )
    await waitFor(() => expect(useMotionTrackingSelectionStore.getState().pickingKind)
      .toBeNull())
    expect(mocks.analyze).not.toHaveBeenCalled()
  })

  test('offers only separate visual clips as tracking targets', async () => {
    const item = clip()
    render(<MotionTrackingEditor clip={item} locked={false} playheadFrame={12} />)

    const target = await screen.findByRole('combobox', { name: 'Motion tracking target clip' })
    expect(target).toHaveValue('target')
    expect(screen.getByRole('option', { name: 'Target' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Source' })).not.toBeInTheDocument()
  })

  test('pins the Program Monitor selection frame through analyze and apply', async () => {
    const user = userEvent.setup()
    const item = clip()
    const { rerender } = render(
      <MotionTrackingEditor clip={item} locked={false} playheadFrame={12} />,
    )
    await user.click(screen.getByRole('button', { name: 'Pick point' }))
    act(() => useMotionTrackingSelectionStore.getState().setSelection(
      item.id,
      { kind: 'point', point: { x: 0.5, y: 0.5 } },
      12,
    ))
    expect(screen.getByText('Selection pinned to project frame 12.')).toBeInTheDocument()

    rerender(<MotionTrackingEditor clip={item} locked={false} playheadFrame={20} />)
    await user.click(screen.getByRole('button', { name: 'Analyze' }))
    await waitFor(() => expect(mocks.analyze).toHaveBeenCalledWith({
      sourceClipId: item.id,
      selectionGlobalFrame: 12,
      direction: 'forward',
      selection: { kind: 'point', point: { x: 0.5, y: 0.5 } },
    }))
    expect(screen.getByRole('status')).toHaveTextContent('local cache')

    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), 'target', false, false)
    expect(screen.getByRole('status')).toHaveTextContent('one undo step')
  })

  test('previews only between the first and last accepted tracking keyframes', async () => {
    const user = userEvent.setup()
    const item = clip()
    const { rerender } = render(
      <MotionTrackingEditor clip={item} locked={false} playheadFrame={11} />,
    )
    await user.click(screen.getByRole('button', { name: 'Pick point' }))
    act(() => useMotionTrackingSelectionStore.getState().setSelection(
      item.id,
      { kind: 'point', point: { x: 0.5, y: 0.5 } },
      12,
    ))
    await user.click(screen.getByRole('button', { name: 'Analyze' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('local cache'))
    await user.click(screen.getByRole('checkbox', { name: 'Preview accepted tracking at the playhead' }))

    expect(useTransportStore.getState().clipVisualPreview).toBeNull()
    rerender(<MotionTrackingEditor clip={item} locked={false} playheadFrame={12} />)
    await waitFor(() => expect(useTransportStore.getState().clipVisualPreview).toMatchObject({
      owner: 'motion-tracking',
      clipId: 'target',
    }))
    rerender(<MotionTrackingEditor clip={item} locked={false} playheadFrame={13} />)
    await waitFor(() => expect(useTransportStore.getState().clipVisualPreview?.clipId).toBe('target'))
    rerender(<MotionTrackingEditor clip={item} locked={false} playheadFrame={14} />)
    await waitFor(() => expect(useTransportStore.getState().clipVisualPreview).toBeNull())
  })

  test('invalidates a ready result when the requested direction changes', async () => {
    const user = userEvent.setup()
    const item = clip()
    render(<MotionTrackingEditor clip={item} locked={false} playheadFrame={12} />)
    await user.click(screen.getByRole('button', { name: 'Pick point' }))
    act(() => useMotionTrackingSelectionStore.getState().setSelection(
      item.id,
      { kind: 'point', point: { x: 0.5, y: 0.5 } },
      12,
    ))
    await user.click(screen.getByRole('button', { name: 'Analyze' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('local cache'))

    await user.selectOptions(screen.getByRole('combobox', { name: 'Direction' }), 'backward')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Analyze the pinned selection again')

    await user.click(screen.getByRole('button', { name: 'Analyze' }))
    expect(mocks.analyze).toHaveBeenLastCalledWith(expect.objectContaining({
      selectionGlobalFrame: 12,
      direction: 'backward',
    }))
  })

  test('does not clear a stabilization preview owned by the sibling editor', () => {
    const item = clip()
    useTransportStore.getState().setOwnedClipVisualPreview('stabilization', {
      clipId: item.id,
      transform: { ...item.transform, x: 42 },
      visual: defaultClipVisualSettings(),
    })

    const { rerender, unmount } = render(
      <MotionTrackingEditor clip={item} locked={false} playheadFrame={12} />,
    )
    rerender(<MotionTrackingEditor clip={item} locked={false} playheadFrame={13} />)
    expect(useTransportStore.getState().clipVisualPreview).toMatchObject({
      owner: 'stabilization',
      transform: { x: 42 },
    })

    unmount()
    expect(useTransportStore.getState().clipVisualPreview?.owner).toBe('stabilization')
  })

  test('restores an enabled stabilization preview after tracking preview turns off', async () => {
    const user = userEvent.setup()
    const item = clip()
    useTransportStore.getState().setOwnedClipVisualPreview('stabilization', {
      clipId: item.id,
      transform: { ...item.transform, x: 42 },
      visual: defaultClipVisualSettings(),
    })
    render(<MotionTrackingEditor clip={item} locked={false} playheadFrame={12} />)
    await user.click(screen.getByRole('button', { name: 'Pick point' }))
    act(() => useMotionTrackingSelectionStore.getState().setSelection(
      item.id,
      { kind: 'point', point: { x: 0.5, y: 0.5 } },
      12,
    ))
    await user.click(screen.getByRole('button', { name: 'Analyze' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('local cache'))

    const preview = screen.getByRole('checkbox', {
      name: 'Preview accepted tracking at the playhead',
    })
    await user.click(preview)
    await waitFor(() => expect(useTransportStore.getState().clipVisualPreview?.owner)
      .toBe('motion-tracking'))

    await user.click(preview)
    await waitFor(() => expect(useTransportStore.getState().clipVisualPreview).toMatchObject({
      owner: 'stabilization',
      transform: { x: 42 },
    }))
  })

  test('reads progress from the active tracking kind instead of an older sibling job', async () => {
    const user = userEvent.setup()
    const item = clip()
    mocks.analyze.mockReset().mockReturnValue(new Promise(() => undefined))
    mocks.subscribe.mockImplementation((listener: (snapshot: unknown) => void) => {
      listener({
        jobs: [
          { id: 'old-point', clipId: item.id, kind: 'point-tracking', phase: 'ready', progress: 1 },
          { id: 'active-box', clipId: item.id, kind: 'box-tracking', phase: 'running', progress: 0.25 },
        ],
        scheduler: {},
      })
      return () => undefined
    })
    render(<MotionTrackingEditor clip={item} locked={false} playheadFrame={12} />)

    await user.click(screen.getByRole('button', { name: 'Draw box' }))
    act(() => useMotionTrackingSelectionStore.getState().setSelection(
      item.id,
      { kind: 'box', box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
      12,
    ))
    await user.click(screen.getByRole('button', { name: 'Analyze' }))

    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveValue(0.25))
  })
})
