import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultClipAnimation } from '../domain/clipAnimation'
import { defaultClipVisualSettings } from '../domain/clipInspector'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { Clip, MediaAsset, TimelineDoc } from '../domain/schema'
import { findClip } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { clipWithAnimationKeyframeCount } from '../test/animationBudgetFixtures'
import DynamicZoomEditor from './DynamicZoomEditor'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Dynamic clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 30 },
    timelineRange: { startFrame: 0, durationFrames: 30 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    ...overrides,
  }
}

function doc(item = clip(), locked = false): TimelineDoc {
  return {
    schemaVersion: 13,
    id: 'doc-dynamic-ui',
    name: 'Dynamic zoom UI',
    frameRate: { num: 30, den: 1 },
    width: 1080,
    height: 1920,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'video-1',
      kind: 'video',
      name: 'Video 1',
      clips: [item],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked,
    }],
  }
}

const descriptor: PortableAssetDescriptor = {
  id: 'asset-1',
  fileName: 'wide.mp4',
  mimeType: 'video/mp4',
  size: 1_000,
  lastModified: 1,
  kind: 'video',
  durationMicroseconds: 1_000_000,
  sourceBounds: { video: { status: 'unknown' }, audio: null },
  nativeFrameRate: { num: 30, den: 1 },
  width: 3840,
  height: 2160,
  hasAudio: false,
  audioSampleRate: null,
  audioChannels: null,
}

const connectedAsset: MediaAsset = {
  id: descriptor.id,
  fileName: descriptor.fileName,
  mimeType: descriptor.mimeType,
  size: descriptor.size,
  lastModified: descriptor.lastModified,
  objectUrl: 'blob:connected-asset',
  kind: descriptor.kind,
  durationFrames: 30,
  durationMicroseconds: descriptor.durationMicroseconds,
  sourceBounds: descriptor.sourceBounds,
  frameRate: descriptor.nativeFrameRate,
  width: 640,
  height: 1920,
  hasAudio: descriptor.hasAudio,
  audioSampleRate: descriptor.audioSampleRate,
  audioChannels: descriptor.audioChannels,
  decoderConfigB64: null,
}

function Harness({ locked = false }: { locked?: boolean }) {
  const timeline = useDocumentStore((state) => state.doc)
  const item = findClip(timeline, 'clip-1')
  if (!item) return null
  return <DynamicZoomEditor clip={item} locked={locked} />
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  useDocumentStore.getState().setDoc(doc())
  useMediaStore.getState().clearAssets()
  useMediaStore.setState({ descriptors: new Map([[descriptor.id, descriptor]]) })
})

afterEach(() => {
  useMediaStore.getState().clearAssets()
  warnSpy.mockRestore()
})

describe('DynamicZoomEditor', () => {
  test('configures every essential parameter and applies, reverses, and resets by keyboard', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Preset' }), 'reframe-left-right')
    const duration = screen.getByRole('spinbutton', { name: 'Duration (frames)' })
    await user.clear(duration)
    await user.type(duration, '90')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Easing' }), 'ease-out')

    const horizontal = screen.getAllByRole('spinbutton', { name: 'Horizontal focus (%)' })
    const vertical = screen.getAllByRole('spinbutton', { name: 'Vertical focus (%)' })
    const zoom = screen.getAllByRole('spinbutton', { name: 'Safe zoom (%)' })
    expect(horizontal).toHaveLength(2)
    expect(vertical).toHaveLength(2)
    expect(zoom).toHaveLength(2)
    await user.clear(horizontal[0])
    await user.type(horizontal[0], '-90')
    await user.clear(vertical[1])
    await user.type(vertical[1], '35')
    await user.clear(zoom[1])
    await user.type(zoom[1], '150')

    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(findClip(useDocumentStore.getState().doc, 'clip-1')?.animation?.tracks
      .map(({ property }) => property)).toEqual([
      'position-x',
      'position-y',
      'scale-x',
      'scale-y',
    ])
    expect(screen.getByRole('status')).toHaveTextContent('clamped to this 30-frame clip')

    const forwardX = findClip(useDocumentStore.getState().doc, 'clip-1')
      ?.animation?.tracks[0].keyframes.map(({ value }) => value) ?? []
    await user.click(screen.getByRole('button', { name: 'Reverse & apply' }))
    expect(useDocumentStore.getState().past).toHaveLength(2)
    expect(findClip(useDocumentStore.getState().doc, 'clip-1')
      ?.animation?.tracks[0].keyframes.map(({ value }) => value))
      .toEqual(forwardX.reverse())

    await user.click(screen.getByRole('button', { name: 'Reset framing tracks' }))
    expect(useDocumentStore.getState().past).toHaveLength(3)
    expect(findClip(useDocumentStore.getState().doc, 'clip-1')?.animation)
      .toEqual({ tracks: [], effectTracks: [] })
    expect(screen.getByRole('status')).toHaveTextContent('static transform')
  })

  test('keeps controls discoverable while explaining unavailable dimensions, locks, and rotation curves', () => {
    useMediaStore.setState({ descriptors: new Map() })
    const { rerender } = render(<Harness />)
    const apply = screen.getByRole('button', { name: 'Apply' })
    const reverse = screen.getByRole('button', { name: 'Reverse & apply' })
    expect(apply).toBeDisabled()
    expect(apply).toHaveAttribute('aria-describedby', 'dynamic-zoom-status')
    expect(reverse).toHaveAttribute('aria-describedby', 'dynamic-zoom-status')
    expect(apply).toHaveAccessibleDescription(/known positive source dimensions/)
    expect(screen.getByRole('status')).toHaveTextContent('known positive source dimensions')

    useMediaStore.setState({ descriptors: new Map([[descriptor.id, descriptor]]) })
    rerender(<Harness locked />)
    expect(screen.getByRole('combobox', { name: 'Preset' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Unlock this video track')

    const rotating = clip({
      animation: {
        tracks: [{
          property: 'rotation',
          keyframes: [{ frame: 0, value: 15, easing: { type: 'linear' } }],
        }],
        effectTracks: [],
      },
    })
    useDocumentStore.getState().setDoc(doc(rotating))
    rerender(<Harness />)
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Reset Rotation animation')
  })

  test('prioritizes current draft, source, and lock reasons over stale feedback', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness />)

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Preset' }),
      'reframe-left-right',
    )
    expect(screen.getByRole('status')).toHaveTextContent('loaded')

    const duration = screen.getByRole('spinbutton', { name: 'Duration (frames)' })
    await user.clear(duration)
    await user.type(duration, '1')
    const apply = screen.getByRole('button', { name: 'Apply' })
    const reverse = screen.getByRole('button', { name: 'Reverse & apply' })
    expect(apply).toBeDisabled()
    expect(reverse).toBeDisabled()
    expect(apply).toHaveAccessibleDescription(/at least 2 frames/)
    expect(reverse).toHaveAccessibleDescription(/at least 2 frames/)
    expect(screen.getByRole('status')).not.toHaveTextContent('loaded')

    await user.clear(duration)
    await user.type(duration, '30')
    expect(screen.getByRole('status')).toHaveTextContent('Ready: 30 frames')

    const horizontal = screen.getAllByRole('spinbutton', { name: 'Horizontal focus (%)' })
    await user.clear(horizontal[0])
    await user.type(horizontal[0], '101')
    expect(apply).toBeDisabled()
    expect(apply).toHaveAccessibleDescription(/Start focusX must be from -1 to 1/)
    await user.clear(horizontal[0])
    await user.type(horizontal[0], '-75')

    const zoom = screen.getAllByRole('spinbutton', { name: 'Safe zoom (%)' })
    await user.clear(zoom[1])
    await user.type(zoom[1], '99')
    expect(reverse).toBeDisabled()
    expect(reverse).toHaveAccessibleDescription(/End zoom must be from 1 to 4/)
    await user.clear(zoom[1])
    await user.type(zoom[1], '120')
    expect(screen.getByRole('status')).toHaveTextContent('Ready: 30 frames')

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Preset' }),
      'gentle-out',
    )
    act(() => useMediaStore.setState({ descriptors: new Map() }))
    expect(apply).toBeDisabled()
    expect(apply).toHaveAccessibleDescription(/known positive source dimensions/)
    expect(screen.getByRole('status')).not.toHaveTextContent('loaded')
    act(() => useMediaStore.setState({
      descriptors: new Map([[descriptor.id, descriptor]]),
    }))
    expect(screen.getByRole('status')).toHaveTextContent('Ready: 30 frames')

    await user.click(apply)
    expect(screen.getByRole('status')).toHaveTextContent('Applied as four ordinary')
    rerender(<Harness locked />)
    expect(apply).toBeDisabled()
    expect(apply).toHaveAccessibleDescription(/Unlock this video track/)
    expect(screen.getByRole('status')).not.toHaveTextContent('Applied as four ordinary')
    rerender(<Harness />)
    expect(screen.getByRole('status')).toHaveTextContent('Ready: 30 frames')
  })

  test('describes the actual disabled Reset reason independently from Apply', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness />)
    const reset = screen.getByRole('button', { name: 'Reset framing tracks' })

    expect(reset).toBeDisabled()
    expect(reset).toHaveAttribute('aria-describedby', 'dynamic-zoom-reset-reason')
    expect(reset).toHaveAccessibleDescription(/No Position X\/Y or Scale X\/Y tracks/)
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(reset).toBeEnabled()
    expect(reset).toHaveAttribute('aria-describedby', 'dynamic-zoom-reset-note')

    rerender(<Harness locked />)
    expect(reset).toBeDisabled()
    expect(reset).toHaveAttribute('aria-describedby', 'dynamic-zoom-reset-reason')
    expect(reset).toHaveAccessibleDescription(/Unlock this video track/)
  })

  test('exposes the document keyframe budget as the current disabled reason', () => {
    useDocumentStore.getState().setDoc(doc(clipWithAnimationKeyframeCount(clip())))
    render(<Harness />)

    const apply = screen.getByRole('button', { name: 'Apply' })
    const reverse = screen.getByRole('button', { name: 'Reverse & apply' })
    expect(apply).toBeDisabled()
    expect(reverse).toBeDisabled()
    expect(apply).toHaveAccessibleDescription(/document keyframe budget/)
    expect(reverse).toHaveAccessibleDescription(/document keyframe budget/)
    expect(screen.getByRole('status')).toHaveTextContent('document keyframe budget')
    expect(screen.getByRole('status')).not.toHaveTextContent('already applied')
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  test('uses the portable descriptor before connected-session dimensions at render and apply time', async () => {
    const user = userEvent.setup()
    useMediaStore.setState({
      assets: new Map([[connectedAsset.id, connectedAsset]]),
      descriptors: new Map([[descriptor.id, descriptor]]),
    })
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    const scaleX = findClip(useDocumentStore.getState().doc, 'clip-1')?.animation?.tracks
      .find(({ property }) => property === 'scale-x')
    expect(scaleX?.keyframes[0].value).toBeCloseTo(1920 / descriptor.height!)
    expect(scaleX?.keyframes[0].value).not.toBeCloseTo(1080 / connectedAsset.width!)
  })

  test('states the destructive framing reset boundary without hidden provenance', () => {
    render(<Harness />)
    expect(screen.getByText(/Reset removes, every Position X\/Y and Scale X\/Y track/))
      .toBeVisible()
    expect(screen.getByText(/same preview\/export evaluator/)).toBeVisible()
  })
})
