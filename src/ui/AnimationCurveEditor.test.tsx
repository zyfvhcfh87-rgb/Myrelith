import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test } from 'vitest'
import { defaultClipAnimation } from '../domain/clipAnimation'
import type { Clip, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import {
  resetDocumentStoreForTest,
  resetTransportStoreForTest,
} from '../test/storeFixtures'
import AnimationCurveEditor from './AnimationCurveEditor'

function clip(): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Animated clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 40 },
    timelineRange: { startFrame: 10, durationFrames: 40 },
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
    animation: defaultClipAnimation(),
    effects: [],
  }
}

function doc(): TimelineDoc {
  return {
    schemaVersion: 18,
    id: 'animation-editor-doc',
    name: 'Animation editor',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'video-1',
      kind: 'video',
      name: 'Video 1',
      clips: [clip()],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

function Harness() {
  const selectedClip = useDocumentStore((state) => state.doc.tracks[0].clips[0])
  const playheadFrame = useTransportStore((state) => state.playheadFrame)
  return (
    <AnimationCurveEditor
      clip={selectedClip}
      locked={false}
      playheadFrame={playheadFrame}
    />
  )
}

function keyframes() {
  return useDocumentStore.getState().doc.tracks[0].clips[0]
    .animation?.tracks[0]?.keyframes ?? []
}

describe('AnimationCurveEditor', () => {
  beforeEach(() => {
    resetTransportStoreForTest()
    resetDocumentStoreForTest(doc())
    useTransportStore.getState().setPlayheadFrame(10)
  })

  test('supports the full keyframe and curve workflow with accessible controls', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect(screen.getByRole('heading', { name: 'Animation' })).toBeInTheDocument()
    expect(screen.getByLabelText('Animated property')).toHaveValue('position-x')

    await user.click(screen.getByRole('button', { name: 'Add at playhead' }))
    expect(await screen.findByRole('button', { name: 'Frame 0: 0' })).toBeInTheDocument()

    act(() => useTransportStore.getState().setPlayheadFrame(20))
    await user.click(screen.getByRole('button', { name: 'Add at playhead' }))
    expect(await screen.findByRole('button', { name: 'Frame 10: 0' })).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Keyframe value'))
    await user.type(screen.getByLabelText('Keyframe value'), '100{Enter}')
    expect(keyframes()[1].value).toBe(100)

    await user.selectOptions(screen.getByLabelText('Outgoing interpolation'), 'custom')
    expect(screen.getByLabelText('Custom cubic Bézier controls')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('X1'))
    await user.type(screen.getByLabelText('X1'), '0.3{Enter}')
    expect(keyframes()[1].easing).toMatchObject({ type: 'cubic-bezier', x1: 0.3 })

    await user.click(screen.getByRole('button', { name: 'Frame 0: 0' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(useTransportStore.getState().playheadFrame).toBe(20)

    act(() => useTransportStore.getState().setPlayheadFrame(25))
    await user.click(screen.getByRole('button', { name: 'Copy to playhead' }))
    expect(keyframes().map((keyframe) => keyframe.frame)).toEqual([0, 10, 15])

    await user.clear(screen.getByLabelText('Keyframe frame'))
    await user.type(screen.getByLabelText('Keyframe frame'), '20{Enter}')
    expect(keyframes().map((keyframe) => keyframe.frame)).toEqual([0, 10, 20])

    await user.click(screen.getByRole('button', { name: 'Remove keyframe' }))
    expect(keyframes().map((keyframe) => keyframe.frame)).toEqual([0, 10])
    await user.click(screen.getByRole('button', { name: 'Reset Position X animation' }))
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].animation)
      .toEqual({ tracks: [], effectTracks: [] })
    expect(screen.getByRole('status')).toHaveTextContent(/static value is unchanged/)
  })

  test('disables playhead edits outside the selected clip and preserves keyboard focusability', () => {
    act(() => useTransportStore.getState().setPlayheadFrame(0))
    render(<Harness />)

    expect(screen.getByRole('button', { name: 'Add at playhead' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/Move the playhead onto this clip/)
    expect(screen.getByLabelText('Animated property').tagName).toBe('SELECT')
  })
})
