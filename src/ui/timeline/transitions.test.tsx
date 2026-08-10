/**
 * Timeline transition authoring (Phase 5.1e-3).
 *
 * These are full Timeline integration tests: accessible seam controls write
 * through documentStore, and undo/redo must drive the rendered controls back
 * to the exact stored transition snapshot.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  Clip,
  TimelineDoc,
  Track as TrackData,
  Transition,
} from '../../domain/schema'
import { defaultTextProps } from '../../domain/textOverlay'
import type { PortableAssetDescriptor } from '../../domain/projectFile'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import {
  resetMediaStoreForTest,
  resetTransportStoreForTest,
} from '../../test/storeFixtures'
import Timeline from './Timeline'

function makeClip(id: string, startFrame: number, durationFrames: number): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 30, durationFrames },
    timelineRange: { startFrame, durationFrames },
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
    effects: [],
  }
}

function makeTextClip(id: string, startFrame: number, durationFrames: number): Clip {
  return {
    ...makeClip(id, startFrame, durationFrames),
    text: {
      ...defaultTextProps(1920, 1080),
      content: 'Title',
      fontFamily: 'sans-serif',
      fontSizePx: 48,
      color: '#ffffff',
      align: 'center',
      bold: false,
      italic: false,
    },
  }
}

function crossfade(
  id: string,
  fromClipId: string,
  toClipId: string,
  durationFrames: number,
): Transition {
  return {
    id,
    type: 'crossfade',
    fromClipId,
    toClipId,
    durationFrames,
    audio: { enabled: true, curve: 'equal-power' },
  }
}

function descriptor(id: string): PortableAssetDescriptor {
  return {
    id: `asset-${id}`,
    fileName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 1,
    lastModified: 1,
    kind: 'video',
    durationMicroseconds: 10_000_000,
    sourceBounds: {
      video: {
        status: 'exact',
        firstTimestampUs: 0,
        endTimestampUs: 10_000_000,
      },
      audio: {
        status: 'exact',
        firstTimestampUs: 0,
        endTimestampUs: 10_000_000,
      },
    },
    nativeFrameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
  }
}

function makeTrack(
  id: string,
  kind: TrackData['kind'],
  clips: Clip[],
  transitions: Transition[] = [],
  locked = false,
): TrackData {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions,
    hidden: false,
    muted: false,
    solo: false,
    locked,
  }
}

function makeDoc(options: { seeded?: boolean; lockedSeeded?: boolean } = {}): TimelineDoc {
  const { seeded = false, lockedSeeded = false } = options
  return {
    schemaVersion: 13,
    id: 'transition-ui-doc',
    name: 'Transition UI fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack(
        'V1',
        'video',
        [
          makeClip('A', 0, 30),
          makeClip('B', 30, 30),
          makeClip('gap', 75, 15),
          makeTextClip('title', 90, 15),
        ],
        seeded ? [crossfade('t1', 'A', 'B', 5)] : [],
      ),
      makeTrack(
        'V2',
        'video',
        [makeClip('X', 0, 20), makeClip('Y', 20, 20)],
        lockedSeeded ? [crossfade('locked-t', 'X', 'Y', 5)] : [],
        true,
      ),
      makeTrack(
        'A1',
        'audio',
        [makeClip('M', 0, 20), makeClip('N', 20, 20)],
      ),
    ],
  }
}

/** Adjacent transition windows: A->B D15 is [23,38); B->C defaults to
 * D15 [33,48) (overlap), while D4 [38,42) merely touches and is valid. */
function makeNeighboringTransitionDoc(): TimelineDoc {
  return {
    schemaVersion: 13,
    id: 'transition-neighbor-doc',
    name: 'Neighboring transition fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack(
        'V1',
        'video',
        [
          makeClip('A', 0, 30),
          makeClip('B', 30, 10),
          makeClip('C', 40, 30),
        ],
        [crossfade('tAB', 'A', 'B', 15)],
      ),
    ],
  }
}

function makeLinkedAudioDoc(): TimelineDoc {
  const base = makeDoc({ seeded: true })
  const video = base.tracks[0]
  return {
    ...base,
    tracks: [
      {
        ...video,
        clips: video.clips.map((clip) => clip.id === 'A'
          ? { ...clip, linkGroupId: 'link-A' }
          : clip.id === 'B'
            ? { ...clip, linkGroupId: 'link-B' }
            : clip),
      },
      base.tracks[1],
      makeTrack('A1', 'audio', [
        { ...makeClip('M', 0, 30), linkGroupId: 'link-A' },
        { ...makeClip('N', 30, 30), linkGroupId: 'link-B' },
      ]),
    ],
  }
}

const documentState = () => useDocumentStore.getState()
const track = (trackId: string) => {
  const found = documentState().doc.tracks.find((candidate) => candidate.id === trackId)
  if (!found) throw new Error(`missing track ${trackId}`)
  return found
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetTransportStoreForTest()
  resetMediaStoreForTest({
    descriptors: new Map(
      ['A', 'B', 'C', 'gap', 'title', 'X', 'Y', 'M', 'N'].map(
        (id): [string, PortableAssetDescriptor] => [
          `asset-${id}`,
          descriptor(id),
        ],
      ),
    ),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
  documentState().setDoc(makeDoc())
})

afterEach(() => {
  // Unmount subscribers before clearing shared media state. One media reset
  // otherwise fans out into an act warning for every rendered clip and seam.
  cleanup()
  resetMediaStoreForTest()
  warnSpy.mockRestore()
})

describe('timeline crossfade controls', () => {
  test('renders only eligible video seams and disables controls on a locked track', () => {
    render(<Timeline />)

    expect(screen.getByTestId('transition-seam-A-B')).toBeInTheDocument()
    expect(screen.getByLabelText('Add crossfade A to B')).toBeEnabled()
    expect(screen.queryByTestId('transition-duration-A-B')).not.toBeInTheDocument()
    expect(screen.queryByTestId('transition-seam-B-gap')).not.toBeInTheDocument()
    expect(screen.queryByTestId('transition-seam-gap-title')).not.toBeInTheDocument()
    expect(screen.queryByTestId('transition-seam-M-N')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('transition-add-A-B'))
    expect(screen.getByTestId('transition-duration-A-B')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByTestId('track-A1'), { pointerId: 1 })
    expect(screen.queryByTestId('transition-duration-A-B')).not.toBeInTheDocument()

    const lockedAdd = screen.getByLabelText('Add crossfade X to Y')
    expect(lockedAdd).toBeDisabled()
    fireEvent.click(lockedAdd)
    expect(track('V2').transitions).toEqual([])
    expect(documentState().past).toHaveLength(0)

    act(() => documentState().setDoc(makeDoc({ lockedSeeded: true })))
    expect(screen.getByTestId('transition-toggle-locked-t')).toBeDisabled()
    expect(screen.queryByTestId('transition-duration-locked-t')).not.toBeInTheDocument()
    expect(screen.queryByTestId('transition-remove-locked-t')).not.toBeInTheDocument()
  })

  test('adds the fitted default once and undo/redo preserve its generated id', () => {
    render(<Timeline />)
    fireEvent.click(screen.getByTestId('transition-add-A-B'))

    expect(screen.getByTestId('transition-duration-A-B')).toHaveValue(15)
    expect(track('V1').transitions).toEqual([])
    expect(documentState().past).toHaveLength(0)
    fireEvent.click(screen.getByTestId('transition-submit-A-B'))

    const authored = documentState().doc
    const authoredJson = JSON.stringify(authored)
    const transition = track('V1').transitions[0]
    expect(transition.durationFrames).toBe(15)
    expect(transition.audio).toEqual({ enabled: true, curve: 'equal-power' })
    expect(documentState().past).toHaveLength(1)
    expect(screen.getByTestId(`transition-toggle-${transition.id}`)).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    act(() => documentState().undo())
    expect(track('V1').transitions).toEqual([])
    expect(screen.getByTestId('transition-add-A-B')).toBeInTheDocument()

    act(() => documentState().redo())
    expect(documentState().doc).toBe(authored)
    expect(JSON.stringify(documentState().doc)).toBe(authoredJson)
    expect(track('V1').transitions[0].id).toBe(transition.id)
    expect(screen.getByTestId(`transition-toggle-${transition.id}`)).toBeInTheDocument()
  })

  test('duration submits once, resyncs on undo/redo, and rejects invalid drafts', () => {
    act(() => documentState().setDoc(makeDoc({ seeded: true })))
    render(<Timeline />)
    fireEvent.click(screen.getByTestId('transition-toggle-t1'))
    const duration = screen.getByTestId('transition-duration-t1')
    expect(duration).toHaveValue(5)
    expect(screen.getByLabelText('Crossfade duration in frames')).toBe(duration)
    expect(screen.getByLabelText('Crossfade linked audio')).toBeChecked()
    expect(screen.getByLabelText('Audio crossfade curve')).toHaveValue(
      'equal-power',
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Visual crossfade available up to 60 frames.',
    )

    fireEvent.change(duration, { target: { value: '9' } })
    fireEvent.change(screen.getByLabelText('Audio crossfade curve'), {
      target: { value: 'linear' },
    })
    fireEvent.click(screen.getByLabelText('Crossfade linked audio'))
    expect(track('V1').transitions[0].durationFrames).toBe(5)
    expect(documentState().past).toHaveLength(0)
    fireEvent.submit(screen.getByRole('form', { name: 'Edit crossfade A to B' }))

    expect(track('V1').transitions[0].durationFrames).toBe(9)
    expect(track('V1').transitions[0].audio).toEqual({
      enabled: false,
      curve: 'linear',
    })
    expect(documentState().past).toHaveLength(1)
    expect(screen.getByTestId('transition-duration-t1')).toHaveValue(9)

    const edited = documentState().doc
    act(() => documentState().undo())
    expect(screen.getByTestId('transition-duration-t1')).toHaveValue(5)
    expect(screen.getByLabelText('Crossfade linked audio')).toBeChecked()
    expect(screen.getByLabelText('Audio crossfade curve')).toHaveValue(
      'equal-power',
    )
    act(() => documentState().redo())
    expect(documentState().doc).toBe(edited)
    expect(screen.getByTestId('transition-duration-t1')).toHaveValue(9)
    expect(screen.getByLabelText('Crossfade linked audio')).not.toBeChecked()
    expect(screen.getByLabelText('Audio crossfade curve')).toHaveValue('linear')

    const current = screen.getByTestId('transition-duration-t1')
    fireEvent.change(current, { target: { value: '0' } })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Enter a whole number from 1 to 60 frames to check availability.',
    )
    expect(screen.getByTestId('transition-submit-A-B')).toBeDisabled()
    expect(track('V1').transitions[0].durationFrames).toBe(9)
    expect(documentState().past).toHaveLength(1)

    fireEvent.keyDown(screen.getByTestId('transition-duration-t1'), { key: 'Escape' })
    expect(screen.queryByTestId('transition-duration-t1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('transition-toggle-t1'))
    expect(screen.getByTestId('transition-duration-t1')).toHaveValue(9)
    expect(documentState().past).toHaveLength(1)
  })

  test('reports exact linked-audio availability from aligned partners', () => {
    act(() => documentState().setDoc(makeLinkedAudioDoc()))
    render(<Timeline />)

    fireEvent.click(screen.getByTestId('transition-toggle-t1'))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Linked audio available up to 60 frames.',
    )
    expect(screen.getByLabelText('Crossfade linked audio')).toBeChecked()

    fireEvent.click(screen.getByLabelText('Crossfade linked audio'))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Linked audio crossfade is off.',
    )
    expect(screen.getByLabelText('Audio crossfade curve')).toBeDisabled()
  })

  test('announces the real handle maximum and enables only a valid duration', () => {
    const limited = descriptor('B')
    limited.sourceBounds.video = {
      status: 'exact',
      firstTimestampUs: 933_334,
      endTimestampUs: 10_000_000,
    }
    useMediaStore.setState((state) => ({
      descriptors: new Map(state.descriptors).set(limited.id, limited),
    }))
    render(<Timeline />)

    fireEvent.click(screen.getByTestId('transition-add-A-B'))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Visual crossfade unavailable at this duration; maximum is 3 frames.',
    )
    expect(screen.getByTestId('transition-submit-A-B')).toBeDisabled()

    fireEvent.change(screen.getByTestId('transition-duration-A-B'), {
      target: { value: '3' },
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Visual crossfade available up to 3 frames.',
    )
    expect(screen.getByTestId('transition-submit-A-B')).toBeEnabled()
  })

  test('closes an open editor when its transition identity becomes stale', () => {
    act(() => documentState().setDoc(makeDoc({ seeded: true })))
    render(<Timeline />)
    fireEvent.click(screen.getByTestId('transition-toggle-t1'))
    expect(screen.getByTestId('transition-duration-t1')).toBeInTheDocument()

    act(() => documentState().setDoc(makeDoc()))
    expect(screen.queryByTestId('transition-duration-A-B')).not.toBeInTheDocument()
    expect(screen.getByTestId('transition-add-A-B')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  test('remove ignores a dirty duration draft; undo restores the committed D5 exactly', () => {
    act(() => documentState().setDoc(makeDoc({ seeded: true })))
    const initial = documentState().doc
    render(<Timeline />)

    fireEvent.click(screen.getByTestId('transition-toggle-t1'))
    fireEvent.change(screen.getByTestId('transition-duration-t1'), {
      target: { value: '12' },
    })
    fireEvent.click(screen.getByTestId('transition-remove-t1'))
    const removed = documentState().doc
    expect(track('V1').transitions).toEqual([])
    expect(documentState().past).toHaveLength(1)
    expect(screen.getByTestId('transition-add-A-B')).toBeInTheDocument()

    act(() => documentState().undo())
    expect(documentState().doc).toBe(initial)
    expect(track('V1').transitions).toEqual([crossfade('t1', 'A', 'B', 5)])
    expect(screen.getByTestId('transition-toggle-t1')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('transition-toggle-t1'))
    expect(screen.getByTestId('transition-duration-t1')).toHaveValue(5)

    act(() => documentState().redo())
    expect(documentState().doc).toBe(removed)
    expect(track('V1').transitions).toEqual([])
    expect(screen.getByTestId('transition-add-A-B')).toBeInTheDocument()
  })

  test('neighbor overlap reports an accessible error, then a touching D4 adds once', () => {
    act(() => documentState().setDoc(makeNeighboringTransitionDoc()))
    render(<Timeline />)

    fireEvent.click(screen.getByTestId('transition-add-B-C'))
    expect(screen.getByTestId('transition-duration-B-C')).toHaveValue(15)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Visual crossfade unavailable: the window overlaps a neighboring transition.',
    )
    expect(screen.getByTestId('transition-submit-B-C')).toBeDisabled()
    expect(track('V1').transitions).toEqual([
      crossfade('tAB', 'A', 'B', 15),
    ])
    expect(documentState().past).toHaveLength(0)

    fireEvent.change(screen.getByTestId('transition-duration-B-C'), {
      target: { value: '4' },
    })
    expect(screen.getByTestId('transition-submit-B-C')).toBeEnabled()
    fireEvent.click(screen.getByTestId('transition-submit-B-C'))

    expect(track('V1').transitions).toHaveLength(2)
    expect(track('V1').transitions[1]).toMatchObject({
      type: 'crossfade',
      fromClipId: 'B',
      toClipId: 'C',
      durationFrames: 4,
    })
    expect(documentState().past).toHaveLength(1)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
