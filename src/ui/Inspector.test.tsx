/**
 * ui/Inspector.test.tsx — Phase 4.3.
 *
 * The commit model is the whole contract: drafts while typing, ONE
 * updateClipTransform per blur/Enter (one undo entry), no commit for
 * unchanged/junk/empty input, Escape reverts, and the fields resync when
 * the doc changes under them (undo, canvas gestures, clip switching).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import Inspector from './Inspector'

function makeClip(id: string, tlStart: number, duration: number): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: `${id}.mp4`,
    sourceRange: { startFrame: 0, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, clips: Clip[], kind: Track['kind'] = 'video'): Track {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked: false }
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc-inspector',
    name: 'inspector fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', [makeClip('clipA', 0, 100), makeClip('clipB', 100, 50)]),
      makeTrack('A1', [makeClip('clipD', 0, 80)], 'audio'),
    ],
  }
}

function makeLinkedFixture(): TimelineDoc {
  return {
    ...makeDoc(),
    tracks: [
      makeTrack('V1', [{ ...makeClip('clipV', 0, 50), linkGroupId: 'link_1' }]),
      makeTrack(
        'A1',
        [{ ...makeClip('clipLinkedA', 0, 50), linkGroupId: 'link_1' }],
        'audio',
      ),
    ],
  }
}

const doc = () => useDocumentStore.getState()
const transport = () => useTransportStore.getState()
const clipA = () => doc().doc.tracks[0].clips.find((c) => c.id === 'clipA') as Clip

function setMultiSelection(selectedClipIds: readonly string[], primaryId?: string): void {
  useTransportStore.setState({
    selectedClipIds,
    selectedClipId: primaryId ?? selectedClipIds[selectedClipIds.length - 1] ?? null,
  })
}

const linkButton = () =>
  screen.getByRole('button', { name: 'Link selected audio and video clips' })

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    inOut: null,
    dragPreview: null,
    tool: 'select',
    selectedClipIds: [],
    selectedClipId: null,
    editPreview: null,
  })
  doc().setDoc(makeDoc())
  warnSpy.mockClear()
})

describe('Inspector', () => {
  test('shows a hint without a selection, fields with one', () => {
    const { rerender } = render(<Inspector />)
    expect(screen.getByText('select a clip to edit it')).toBeInTheDocument()

    fireEvent.pointerDown(document.body) // no-op; just anchor the rerender
    transport().setSelectedClip('clipA')
    rerender(<Inspector />)

    expect(screen.getByText('clipA.mp4')).toBeInTheDocument()
    expect(screen.getByTestId('inspector-x')).toHaveValue(0)
    expect(screen.getByTestId('inspector-scale-x')).toHaveValue(1)
    expect(screen.getByTestId('inspector-opacity')).toHaveValue(1)
  })

  test('Enter commits ONE updateClipTransform (one undo entry)', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const x = screen.getByTestId('inspector-x')

    fireEvent.change(x, { target: { value: '40' } })
    expect(clipA().transform.x).toBe(0) // drafting: doc untouched
    expect(doc().past).toHaveLength(0)

    fireEvent.keyDown(x, { key: 'Enter' })
    expect(clipA().transform.x).toBe(40)
    expect(doc().past).toHaveLength(1)

    // The field now shows the committed value; blurring commits nothing new.
    fireEvent.blur(x)
    expect(doc().past).toHaveLength(1)
  })

  test('blur commits too; an untouched field never commits', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const rotation = screen.getByTestId('inspector-rotation')

    fireEvent.change(rotation, { target: { value: '15' } })
    fireEvent.blur(rotation)
    expect(clipA().transform.rotation).toBe(15)
    expect(doc().past).toHaveLength(1)

    fireEvent.blur(screen.getByTestId('inspector-y')) // untouched
    expect(doc().past).toHaveLength(1)
  })

  test('junk and empty input revert without committing', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const scaleX = screen.getByTestId('inspector-scale-x')

    fireEvent.change(scaleX, { target: { value: '' } })
    fireEvent.blur(scaleX)
    expect(scaleX).toHaveValue(1) // reverted
    expect(doc().past).toHaveLength(0)
  })

  test('Escape reverts the draft to the committed value', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const y = screen.getByTestId('inspector-y')

    fireEvent.change(y, { target: { value: '99' } })
    fireEvent.keyDown(y, { key: 'Escape' })
    expect(y).toHaveValue(0)
    fireEvent.blur(y)
    expect(doc().past).toHaveLength(0)
  })

  test('typed opacity is clamped by the domain op before entering the doc', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const opacity = screen.getByTestId('inspector-opacity')

    fireEvent.change(opacity, { target: { value: '5' } })
    fireEvent.keyDown(opacity, { key: 'Enter' })
    expect(clipA().opacity).toBe(1) // clamped
    expect(doc().past).toHaveLength(1)
  })

  test('fields resync on undo and when switching clips', () => {
    transport().setSelectedClip('clipA')
    const { rerender } = render(<Inspector />)
    const x = screen.getByTestId('inspector-x')

    fireEvent.change(x, { target: { value: '40' } })
    fireEvent.keyDown(x, { key: 'Enter' })
    expect(x).toHaveValue(40)

    doc().undo()
    rerender(<Inspector />)
    expect(screen.getByTestId('inspector-x')).toHaveValue(0)

    transport().setSelectedClip('clipB')
    rerender(<Inspector />)
    expect(screen.getByText('clipB.mp4')).toBeInTheDocument()

    transport().setSelectedClip('gone')
    rerender(<Inspector />)
    expect(screen.getByText('select a clip to edit it')).toBeInTheDocument()
  })
})

describe('audio clips (clip audio upgrade)', () => {
  const clipD = () =>
    doc().doc.tracks[1].clips.find((c) => c.id === 'clipD') as Clip

  test('an audio-lane clip shows Volume and NOT the transform fields', () => {
    transport().setSelectedClip('clipD')
    render(<Inspector />)
    expect(screen.getByTestId('inspector-volume')).toHaveValue(1)
    expect(screen.queryByTestId('inspector-x')).not.toBeInTheDocument()
    expect(screen.queryByTestId('inspector-opacity')).not.toBeInTheDocument()
  })

  test('a video-lane clip shows no Volume field', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    expect(screen.queryByTestId('inspector-volume')).not.toBeInTheDocument()
  })

  test('volume commits ONE setClipVolume; the domain clamps to [0,2]', () => {
    transport().setSelectedClip('clipD')
    render(<Inspector />)
    const volume = screen.getByTestId('inspector-volume')

    fireEvent.change(volume, { target: { value: '0.5' } })
    expect(clipD().volume).toBe(1) // drafting: doc untouched
    fireEvent.keyDown(volume, { key: 'Enter' })
    expect(clipD().volume).toBe(0.5)
    expect(doc().past).toHaveLength(1)

    fireEvent.change(volume, { target: { value: '9' } })
    fireEvent.blur(volume)
    expect(clipD().volume).toBe(2) // clamped by the domain op
    expect(doc().past).toHaveLength(2)
  })

  test('undo restores the volume and the field resyncs', () => {
    transport().setSelectedClip('clipD')
    const { rerender } = render(<Inspector />)
    const volume = screen.getByTestId('inspector-volume')

    fireEvent.change(volume, { target: { value: '0.2' } })
    fireEvent.keyDown(volume, { key: 'Enter' })
    expect(clipD().volume).toBe(0.2)

    doc().undo()
    rerender(<Inspector />)
    expect(screen.getByTestId('inspector-volume')).toHaveValue(1)
  })
})

describe('manual A/V link control (Issue 12 Slice 3)', () => {
  test('disabled states explain no, partial, same-kind, oversized, and stale selections', () => {
    const { rerender } = render(<Inspector />)
    expect(linkButton()).toBeDisabled()
    expect(linkButton()).toHaveAccessibleDescription(
      'Select one video clip and one audio clip to link them.',
    )

    transport().setSelectedClip('clipA')
    rerender(<Inspector />)
    expect(linkButton()).toBeDisabled()
    expect(linkButton()).toHaveAccessibleDescription(
      'Select one more clip with Ctrl/Cmd-click, or focus it and press Ctrl/Cmd+Enter.',
    )

    setMultiSelection(['clipA', 'clipB'], 'clipB')
    rerender(<Inspector />)
    expect(linkButton()).toHaveAccessibleDescription(
      'Select one video clip and one audio clip; clips on the same kind of track cannot be linked.',
    )

    setMultiSelection(['clipA', 'clipB', 'clipD'], 'clipD')
    rerender(<Inspector />)
    expect(linkButton()).toHaveAccessibleDescription(
      'Select exactly two clips: one video and one audio.',
    )

    setMultiSelection(['clipA', 'deleted-clip'], 'clipA')
    rerender(<Inspector />)
    expect(linkButton()).toHaveAccessibleDescription(
      'A selected clip is no longer available. Reselect the video and audio clips.',
    )

    setMultiSelection(['deleted-clip'], 'deleted-clip')
    rerender(<Inspector />)
    expect(linkButton()).toHaveAccessibleDescription(
      'A selected clip is no longer available. Reselect the video and audio clips.',
    )
  })

  test('accepts either selection order and uses a native keyboard-operable button', () => {
    setMultiSelection(['clipD', 'clipA'], 'clipA')
    const { rerender } = render(<Inspector />)

    expect(linkButton()).toBeEnabled()
    expect(linkButton()).toHaveAccessibleDescription(
      'Ready to link the selected video and audio clips.',
    )
    expect(linkButton().tagName).toBe('BUTTON')
    expect(linkButton()).toHaveAttribute('type', 'button')
    linkButton().focus()
    expect(linkButton()).toHaveFocus()

    setMultiSelection(['clipA', 'clipD'], 'clipD')
    rerender(<Inspector />)
    expect(linkButton()).toBeEnabled()
  })

  test('links a valid pair in one history action without changing selection or primary', () => {
    // Different assets/source offsets, hidden video, and muted audio are valid:
    // manual linking joins existing timeline items without rewriting metadata.
    const mixedDoc = makeDoc()
    const videoTrack = mixedDoc.tracks[0]
    const audioTrack = mixedDoc.tracks[1]
    doc().setDoc({
      ...mixedDoc,
      tracks: [
        { ...videoTrack, hidden: true },
        {
          ...audioTrack,
          muted: true,
          clips: audioTrack.clips.map((clip) => ({
            ...clip,
            assetId: 'different-asset',
            sourceRange: { ...clip.sourceRange, startFrame: 17 },
          })),
        },
      ],
    })
    setMultiSelection(['clipD', 'clipA'], 'clipA')
    render(<Inspector />)

    const selectionBefore = transport().selectedClipIds
    fireEvent.click(linkButton())

    const video = doc().doc.tracks[0].clips[0]
    const audio = doc().doc.tracks[1].clips[0]
    expect(video.linkGroupId).toBeDefined()
    expect(audio.linkGroupId).toBe(video.linkGroupId)
    expect(doc().past).toHaveLength(1)
    expect(transport().selectedClipIds).toBe(selectionBefore)
    expect(transport().selectedClipIds).toEqual(['clipD', 'clipA'])
    expect(transport().selectedClipId).toBe('clipA')

    expect(linkButton()).toBeDisabled()
    expect(linkButton()).toHaveAccessibleDescription(
      'The selected video clip is already linked. Unlink it first.',
    )
    expect(screen.getByTestId('inspector-unlink')).toBeInTheDocument()
  })

  test('locked and already-linked pairs remain disabled with actionable reasons', () => {
    const unlocked = makeDoc()
    doc().setDoc({
      ...unlocked,
      tracks: unlocked.tracks.map((track) =>
        track.id === 'V1' ? { ...track, locked: true } : track,
      ),
    })
    setMultiSelection(['clipA', 'clipD'], 'clipA')
    const { rerender } = render(<Inspector />)
    expect(linkButton()).toBeDisabled()
    expect(linkButton()).toHaveAccessibleDescription(
      'Unlock the selected video track before linking.',
    )

    doc().setDoc(makeLinkedFixture())
    setMultiSelection(['clipV', 'clipLinkedA'], 'clipV')
    rerender(<Inspector />)
    expect(linkButton()).toBeDisabled()
    expect(linkButton()).toHaveAccessibleDescription(
      'The selected video clip is already linked. Unlink it first.',
    )
    expect(screen.getByTestId('inspector-unlink')).toBeInTheDocument()
  })
})

describe('linked clips (unlink control)', () => {
  /** V1's 'clipV' and A1's 'clipLinkedA' share a group — a linked pair. */
  function makeLinkedDoc(): TimelineDoc {
    return {
      ...makeDoc(),
      tracks: [
        makeTrack('V1', [{ ...makeClip('clipV', 0, 50), linkGroupId: 'link_1' }]),
        makeTrack('A1', [{ ...makeClip('clipLinkedA', 0, 50), linkGroupId: 'link_1' }], 'audio'),
      ],
    }
  }

  test('a linked video clip shows the unlink button', () => {
    doc().setDoc(makeLinkedDoc())
    transport().setSelectedClip('clipV')
    render(<Inspector />)
    expect(screen.getByTestId('inspector-unlink')).toBeInTheDocument()
  })

  test('a linked audio clip shows the unlink button too', () => {
    doc().setDoc(makeLinkedDoc())
    transport().setSelectedClip('clipLinkedA')
    render(<Inspector />)
    expect(screen.getByTestId('inspector-unlink')).toBeInTheDocument()
  })

  test('clicking unlink dissolves the WHOLE pair in ONE history entry; the button then disappears', () => {
    doc().setDoc(makeLinkedDoc())
    transport().setSelectedClip('clipV')
    const { rerender } = render(<Inspector />)

    fireEvent.click(screen.getByTestId('inspector-unlink'))
    rerender(<Inspector />)

    const v = doc().doc.tracks[0].clips.find((c) => c.id === 'clipV') as Clip
    const a = doc().doc.tracks[1].clips.find((c) => c.id === 'clipLinkedA') as Clip
    expect(v.linkGroupId).toBeUndefined()
    expect(a.linkGroupId).toBeUndefined()
    expect(doc().past).toHaveLength(1)
    expect(screen.queryByTestId('inspector-unlink')).not.toBeInTheDocument()
  })

  test('an unlinked clip shows no unlink button', () => {
    transport().setSelectedClip('clipA') // default fixture: no linkGroupId
    render(<Inspector />)
    expect(screen.queryByTestId('inspector-unlink')).not.toBeInTheDocument()
  })
})
