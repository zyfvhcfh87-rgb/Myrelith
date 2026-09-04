import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultClipAnimation } from '../domain/clipAnimation'
import { defaultClipVisualSettings } from '../domain/clipInspector'
import type { Clip, TimelineDoc } from '../domain/schema'
import type { VideoStabilizationPlan } from '../domain/videoStabilization'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  apply: vi.fn(),
  cancel: vi.fn(),
  plan: vi.fn(),
}))

vi.mock('../app/videoStabilizationController', () => ({
  analyzeVideoStabilization: mocks.analyze,
  applyVideoStabilization: mocks.apply,
  cancelVideoStabilization: mocks.cancel,
  planVideoStabilization: mocks.plan,
}))

vi.mock('../app/motionAnalysisRuntime', () => ({
  getMotionAnalysisController: () => null,
}))

import StabilizationEditor from './StabilizationEditor'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 30 },
    timelineRange: { startFrame: 10, durationFrames: 30 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    ...overrides,
  }
}

function doc(item = clip()): TimelineDoc {
  return {
    schemaVersion: 20,
    id: 'doc',
    name: 'Doc',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'video',
      kind: 'video',
      name: 'Video',
      clips: [item],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

function plan(replacementRequired = true): VideoStabilizationPlan {
  const transform = { x: 4, y: -2, scaleX: 1.04, scaleY: 1.04, rotation: 0.5, anchorX: 0.5, anchorY: 0.5 }
  const properties = ['position-x', 'position-y', 'rotation', 'scale-x', 'scale-y'] as const
  return {
    settings: { strengthPercent: 50, smoothingRadiusFrames: 4 },
    safeZoom: 1.04,
    requiredCropRatio: 1 - 1 / 1.04,
    sampleCount: 30,
    retainedKeyframeCount: 2,
    replacementRequired,
    jitterReductionRatio: 0.52,
    frames: [
      { frame: 0, sourceTimeTicks: 0, transform, easing: 'linear' },
      { frame: 29, sourceTimeTicks: 29_000_000, transform: { ...transform, x: 8 }, easing: 'linear' },
    ],
    tracks: properties.map((property) => ({
      property,
      keyframes: [0, 29].map((frame) => ({
        frame,
        sourceTimeTicks: frame * 1_000_000,
        value: property === 'position-x' ? (frame === 0 ? 4 : 8)
          : property === 'position-y' ? -2
            : property === 'rotation' ? 0.5
              : 1.04,
        easing: { type: 'linear' as const },
      })),
    })),
  }
}

beforeEach(() => {
  const item = clip()
  useDocumentStore.getState().setDoc(doc(item))
  useTransportStore.getState().setClipVisualPreview(null)
  useTransportStore.getState().setPlayheadFrame(20)
  mocks.analyze.mockReset().mockResolvedValue({ clipId: item.id })
  mocks.apply.mockReset().mockReturnValue({ ok: true, changed: true, plan: plan() })
  mocks.cancel.mockReset().mockReturnValue(true)
  mocks.plan.mockReset().mockReturnValue({ ok: true, plan: plan() })
})

describe('StabilizationEditor', () => {
  test('analyzes, exposes exact crop and zoom, previews, confirms replacement, and applies', async () => {
    const user = userEvent.setup()
    render(<StabilizationEditor clip={clip()} locked={false} playheadFrame={20} />)

    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Analyze' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Confirm replacement'))
    expect(screen.getByText('3.85%')).toBeInTheDocument()
    expect(screen.getByText('1.0400×')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' }))
      .toHaveAccessibleDescription('Confirm replacement of the existing Position, Rotation, and Scale tracks before applying.')

    await user.click(screen.getByRole('checkbox', { name: /Preview at the playhead/ }))
    expect(useTransportStore.getState().clipVisualPreview?.transform.x).toBeCloseTo(5.379, 2)
    await user.click(screen.getByRole('checkbox', { name: /Replace existing/ }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      { strengthPercent: 50, smoothingRadiusFrames: 4 },
      true,
    )
    expect(screen.getByRole('status')).toHaveTextContent('five ordinary animation tracks')
    expect(useTransportStore.getState().clipVisualPreview).toBeNull()
  })

  test('keeps locked controls discoverable and cancels without history', async () => {
    const user = userEvent.setup()
    render(<StabilizationEditor clip={clip()} locked playheadFrame={10} />)
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Unlock this video track')
    expect(useDocumentStore.getState().past).toHaveLength(0)

    // A separate unlocked render proves the cancellation surface is wired.
    const { unmount } = render(<StabilizationEditor clip={clip({ id: 'clip-2' })} locked={false} playheadFrame={10} />)
    mocks.analyze.mockReturnValueOnce(new Promise(() => undefined))
    await user.click(screen.getAllByRole('button', { name: 'Analyze' }).at(-1)!)
    await user.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(mocks.cancel).toHaveBeenCalledWith('clip-2')
    expect(useDocumentStore.getState().past).toHaveLength(0)
    unmount()
  })

  test('discloses that Reset removes manual and other-tool transform animation', async () => {
    const user = userEvent.setup()
    const animated = clip({
      animation: {
        ...defaultClipAnimation(),
        tracks: [{
          property: 'position-x',
          keyframes: [
            { frame: 0, value: 0, easing: { type: 'linear' } },
            { frame: 10, value: 40, easing: { type: 'linear' } },
          ],
        }],
      },
    })
    useDocumentStore.getState().setDoc(doc(animated))
    render(<StabilizationEditor clip={animated} locked={false} playheadFrame={20} />)

    const remove = screen.getByRole('button', { name: 'Remove transform animation' })
    expect(remove).toHaveAccessibleDescription(
      /removes all Position, Rotation, and Scale animation.*created manually or by another tool/i,
    )
    await user.click(remove)
    expect(screen.getByRole('status')).toHaveTextContent(
      'All Position, Rotation, and Scale animation tracks were removed in one undo step.',
    )
    expect(useDocumentStore.getState().past).toHaveLength(1)
  })

  test('invalidates an in-flight result when the inspected clip changes', async () => {
    const user = userEvent.setup()
    let resolveAnalysis: ((value: { clipId: string }) => void) | undefined
    mocks.analyze.mockReturnValueOnce(new Promise((resolve) => {
      resolveAnalysis = resolve
    }))
    const first = clip({ id: 'clip-a' })
    const second = clip({ id: 'clip-b' })
    const { rerender } = render(
      <StabilizationEditor clip={first} locked={false} playheadFrame={20} />,
    )

    await user.click(screen.getByRole('button', { name: 'Analyze' }))
    expect(screen.getByRole('status')).toHaveTextContent('Analyzing locally')
    rerender(<StabilizationEditor clip={second} locked={false} playheadFrame={20} />)
    expect(screen.getByRole('status')).toHaveTextContent('Analyze this clip')

    await act(async () => resolveAnalysis?.({ clipId: 'clip-a' }))
    expect(screen.getByRole('status')).toHaveTextContent('Analyze this clip')
    expect(screen.queryByText('Safe zoom')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(mocks.cancel).toHaveBeenCalledWith('clip-a')
    expect(mocks.plan).not.toHaveBeenCalled()
  })
})
