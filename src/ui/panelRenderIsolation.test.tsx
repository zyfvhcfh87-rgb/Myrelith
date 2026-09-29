/**
 * Render isolation for the always-mounted editor panels (HANDOFF invariant 6).
 *
 * Playhead movement re-renders Playhead + Preview only. Inspector, Multicam,
 * Sequence and mixer surfaces may follow the playhead only while their own
 * selection makes it relevant, and then only in the subtree that needs it.
 * React's <Profiler> keeps this deterministic, like the timeline gates.
 */

import { Profiler } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createAdjustmentItem,
  insertAdjustment,
} from '../domain/adjustmentItems'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import type { Clip, TimelineDoc } from '../domain/schema'
import { defaultSourceTimeMap } from '../domain/sourceTimeMap'
import { useAudioMeterStore } from '../state/audioMeterStore'
import { useDocumentStore } from '../state/documentStore'
import { mixerAudioTracks } from '../state/editorUi'
import { useMediaStore } from '../state/mediaStore'
import { useMulticamSelectionStore } from '../state/multicamSelectionStore'
import { useSequenceInstanceSelectionStore } from '../state/sequenceInstanceSelectionStore'
import { useTransportStore } from '../state/transportStore'
import {
  resetDocumentStoreForTest,
  resetMediaStoreForTest,
  resetTransportStoreForTest,
} from '../test/storeFixtures'
import AudioMixer from './AudioMixer'
import Inspector from './Inspector'
import MulticamControls from './MulticamControls'
import SequenceControls from './SequenceControls'

// The Inspector shell renders its audio-effect cards directly and unmemoized,
// so counting them observes every shell re-render without touching internals.
const shell = vi.hoisted(() => ({ renders: 0 }))
vi.mock('./AudioEffectStackInspector', async (importOriginal) => {
  const { createElement } = await import('react')
  const actual = await importOriginal<typeof import('./AudioEffectStackInspector')>()
  const Real = actual.default
  return {
    default: (props: Parameters<typeof Real>[0]) => {
      shell.renders++
      return createElement(Real, props)
    },
  }
})

vi.mock('../state/editorUi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/editorUi')>()
  return { ...actual, mixerAudioTracks: vi.fn(actual.mixerAudioTracks) }
})

function animatedClip(): Clip {
  return {
    id: 'moving-clip',
    assetId: 'asset-moving',
    name: 'Moving clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 40 },
    sourceTimeMap: defaultSourceTimeMap(0, 40),
    timelineRange: { startFrame: 0, durationFrames: 40 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
    animation: {
      tracks: [{
        property: 'position-x',
        keyframes: [
          { frame: 0, value: 0, easing: { type: 'linear' } },
          { frame: 10, value: 100, easing: { type: 'linear' } },
        ],
      }],
    },
  }
}

function docWithClip(clip: Clip): TimelineDoc {
  const base = createTimelineDoc('Isolation', DEFAULT_PROJECT_SETTINGS, 'isolation')
  return {
    ...base,
    tracks: base.tracks.map((track, index) => (
      index === 0 ? { ...track, clips: [clip] } : track
    )),
  }
}

function videoDescriptor(id: string, fileName: string): PortableAssetDescriptor {
  return {
    id,
    fileName,
    mimeType: 'video/mp4',
    size: 1_000,
    lastModified: 1,
    kind: 'video',
    durationMicroseconds: 4_000_000,
    sourceBounds: { video: { status: 'unknown' }, audio: { status: 'unknown' } },
    nativeFrameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
  }
}

function movePlayhead(...frames: number[]): void {
  for (const frame of frames) {
    act(() => useTransportStore.getState().setPlayheadFrame(frame))
  }
}

beforeEach(() => {
  resetTransportStoreForTest()
  resetDocumentStoreForTest(createTimelineDoc('Isolation', DEFAULT_PROJECT_SETTINGS, 'isolation'))
  resetMediaStoreForTest()
  useMulticamSelectionStore.getState().setSelectedInstanceId(null)
  useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(null)
  useAudioMeterStore.getState().resetAudioMeter()
  shell.renders = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GATE: playhead render isolation for always-mounted panels', () => {
  test('idle Inspector, Multicam, Sequence and mixer panels never re-render', () => {
    const renders = {
      inspector: vi.fn(),
      multicam: vi.fn(),
      sequences: vi.fn(),
      mixer: vi.fn(),
    }
    render(
      <>
        <Profiler id="inspector" onRender={renders.inspector}><Inspector /></Profiler>
        <Profiler id="multicam" onRender={renders.multicam}><MulticamControls /></Profiler>
        <Profiler id="sequences" onRender={renders.sequences}><SequenceControls /></Profiler>
        <Profiler id="mixer" onRender={renders.mixer}><AudioMixer /></Profiler>
      </>,
    )
    const before = Object.fromEntries(
      Object.entries(renders).map(([id, spy]) => [id, spy.mock.calls.length]),
    )

    movePlayhead(12, 13, 14)

    expect(Object.fromEntries(
      Object.entries(renders).map(([id, spy]) => [id, spy.mock.calls.length]),
    )).toEqual(before)
  })

  test('a selected video clip re-renders only its playhead-bound sections', () => {
    resetDocumentStoreForTest(docWithClip(animatedClip()))
    act(() => useTransportStore.getState().setSelectedClip('moving-clip'))
    render(<Inspector />)
    expect(screen.getByTestId('inspector-x')).toHaveValue(0)
    const shellRenders = shell.renders
    expect(shellRenders).toBeGreaterThan(0)

    movePlayhead(5)
    expect(screen.getByTestId('inspector-x')).toHaveValue(50)
    movePlayhead(10)
    expect(screen.getByTestId('inspector-x')).toHaveValue(100)

    expect(shell.renders).toBe(shellRenders)
  })

  test('a selected adjustment layer follows the playhead from its own subscription', () => {
    const item = createAdjustmentItem(10, 30, 'Look pass')
    const base = createTimelineDoc('Isolation', DEFAULT_PROJECT_SETTINGS, 'isolation')
    resetDocumentStoreForTest(insertAdjustment(base, 'V1', item))
    act(() => useTransportStore.getState().setSelectedAdjustment(item.id))
    render(<Inspector />)
    expect(screen.getByText(/Move the playhead inside frames 10–39/)).toBeInTheDocument()

    movePlayhead(15)
    expect(screen.queryByText(/Move the playhead inside frames/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Split at playhead' })).toBeEnabled()
  })

  test('a selected compound re-renders only when Split availability flips', () => {
    const clip: Clip = {
      ...animatedClip(),
      id: 'scene-clip',
      animation: undefined,
      sourceRange: { startFrame: 0, durationFrames: 12 },
      sourceTimeMap: defaultSourceTimeMap(0, 12),
      timelineRange: { startFrame: 8, durationFrames: 12 },
    }
    resetDocumentStoreForTest(docWithClip(clip))
    const created = useDocumentStore.getState().createCompoundFromClips(['scene-clip'], 'Scene')
    expect(created).not.toBeNull()
    act(() => useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(created!.instanceId))
    const renders = vi.fn()
    render(<Profiler id="sequences" onRender={renders}><SequenceControls /></Profiler>)
    const split = screen.getByRole('button', { name: 'Split compound' })
    expect(split).toBeDisabled()

    let before = renders.mock.calls.length
    movePlayhead(3, 5, 8)
    expect(renders.mock.calls.length).toBe(before)

    movePlayhead(9)
    expect(renders.mock.calls.length).toBe(before + 1)
    expect(split).toBeEnabled()
    before = renders.mock.calls.length
    movePlayhead(10, 12)
    expect(renders.mock.calls.length).toBe(before)

    fireEvent.click(split)
    const instances = useDocumentStore.getState().doc.tracks[0].sequenceInstances ?? []
    expect(instances.map((instance) => instance.timelineRange)).toEqual([
      { startFrame: 8, durationFrames: 4 },
      { startFrame: 12, durationFrames: 8 },
    ])
  })

  test('a selected multicam follows the playhead through one keyboard listener', () => {
    act(() => useMediaStore.getState().replaceAssets([
      videoDescriptor('wide', 'Wide.mp4'),
      videoDescriptor('close', 'Close.mp4'),
    ], []))
    render(<MulticamControls />)
    fireEvent.click(screen.getByRole('button', { name: 'New multicam' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create multicam' }))
    expect(useMulticamSelectionStore.getState().selectedInstanceId).not.toBeNull()

    const addListener = vi.spyOn(window, 'addEventListener')
    movePlayhead(7, 8, 9)
    expect(screen.getByText(/^Frame 9 ·/)).toBeInTheDocument()
    expect(addListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0)

    fireEvent.keyDown(window, { key: '2', altKey: true })
    expect(useDocumentStore.getState().project.multicams?.[0]?.switches.at(-1))
      .toMatchObject({ frame: 9 })
  })

  test('meter publishes repaint mixer meters without re-rendering the strips', () => {
    render(<AudioMixer />)
    const shellCalls = vi.mocked(mixerAudioTracks).mock.calls.length
    const readout = (db: number) => ({
      db: { left: db, right: db, master: db },
      overloadHeld: { left: false, right: false, master: false },
      overloadLatched: { left: false, right: false, master: false },
    })
    for (const [sequence, db] of [[1, -12], [2, -9]] as const) {
      act(() => useAudioMeterStore.getState().publishAudioMeter({
        ...useAudioMeterStore.getState(),
        status: 'active',
        readout: readout(db),
        trackReadouts: { A1: readout(db - 1) },
        sequence,
      }))
    }

    expect(screen.getByRole('meter', { name: 'A1 left level' }))
      .toHaveAttribute('aria-valuenow', '-10')
    expect(screen.getByRole('meter', { name: 'Master left level' }))
      .toHaveAttribute('aria-valuenow', '-9')
    expect(vi.mocked(mixerAudioTracks).mock.calls.length).toBe(shellCalls)
  })
})
