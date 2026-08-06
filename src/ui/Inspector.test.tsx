/**
 * ui/Inspector.test.tsx — Phase 4.3.
 *
 * The commit model is the whole contract: drafts while typing, ONE
 * updateClipTransform per blur/Enter (one undo entry), no commit for
 * unchanged/junk/empty input, Escape reverts, and the fields resync when
 * the doc changes under them (undo, canvas gestures, clip switching).
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { defaultClipVisualSettings } from '../domain/clipInspector'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import { initSelectionReconciliation } from '../app/selectionReconciliationController'
import {
  resetDocumentStoreForTest,
  resetTransportStoreForTest,
} from '../test/storeFixtures'
import Inspector from './Inspector'
import Timeline from './timeline/Timeline'

function makeClip(id: string, tlStart: number, duration: number): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: `${id}.mp4`,
    sourceMode: 'timed',
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
    schemaVersion: 6,
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
const unlinkButton = () =>
  screen.getByRole('button', { name: 'Unlink audio/video' })

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetTransportStoreForTest()
  resetDocumentStoreForTest(makeDoc())
  useMediaStore.getState().clearAssets()
  warnSpy.mockClear()
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('Inspector', () => {
  test('shows a hint without a selection, fields with one', () => {
    const { rerender } = render(<Inspector />)
    expect(screen.getByText('select a clip to edit it')).toBeInTheDocument()

    fireEvent.pointerDown(document.body) // no-op; just anchor the rerender
    act(() => transport().setSelectedClip('clipA'))
    rerender(<Inspector />)

    expect(screen.getByText('clipA.mp4')).toBeInTheDocument()
    expect(screen.getByTestId('inspector-x')).toHaveValue(0)
    expect(screen.getByTestId('inspector-scale-x')).toHaveValue(1)
    expect(screen.getByTestId('inspector-opacity')).toHaveValue(1)
  })

  test('mirrors the ephemeral canvas geometry without committing document history', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)

    act(() => transport().setClipVisualPreview({
      clipId: 'clipA',
      transform: { ...clipA().transform, x: 88, rotation: 12 },
      visual: {
        ...defaultClipVisualSettings(),
        crop: { left: 0.25, right: 0, top: 0, bottom: 0 },
      },
    }))

    expect(screen.getByTestId('inspector-x')).toHaveValue(88)
    expect(screen.getByTestId('inspector-rotation')).toHaveValue(12)
    expect(screen.getByTestId('inspector-crop-left')).toHaveValue(25)
    expect(clipA().transform.x).toBe(0)
    expect(doc().past).toHaveLength(0)

    act(() => transport().setClipVisualPreview(null))
    expect(screen.getByTestId('inspector-x')).toHaveValue(0)
  })

  test('edits and resets the complete static video surface', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)

    fireEvent.change(screen.getByTestId('inspector-scale-x'), {
      target: { value: '2' },
    })
    fireEvent.keyDown(screen.getByTestId('inspector-scale-x'), { key: 'Enter' })
    expect(clipA().transform.scaleX).toBe(2)
    expect(clipA().transform.scaleY).toBe(2)

    fireEvent.click(screen.getByTestId('inspector-scale-lock'))
    fireEvent.change(screen.getByTestId('inspector-scale-y'), {
      target: { value: '3' },
    })
    fireEvent.keyDown(screen.getByTestId('inspector-scale-y'), { key: 'Enter' })
    expect(clipA().transform.scaleX).toBe(2)
    expect(clipA().transform.scaleY).toBe(3)

    fireEvent.change(screen.getByTestId('inspector-anchor-x-slider'), {
      target: { value: '25' },
    })
    fireEvent.click(screen.getByTestId('inspector-flip-horizontal'))
    const opacitySlider = screen.getByTestId('inspector-opacity-slider')
    fireEvent.change(opacitySlider, {
      target: { value: '0.4' },
    })
    fireEvent.keyDown(opacitySlider, { key: 'ArrowRight' })
    expect(clipA().opacity).toBe(0.41)
    fireEvent.keyDown(opacitySlider, { key: 'Home' })
    expect(clipA().opacity).toBe(0)
    fireEvent.keyDown(opacitySlider, { key: 'End' })
    expect(clipA().opacity).toBe(1)
    fireEvent.change(opacitySlider, { target: { value: '0.4' } })
    fireEvent.change(screen.getByTestId('inspector-crop-left-slider'), {
      target: { value: '33' },
    })

    expect(clipA()).toMatchObject({
      transform: { anchorX: 0.25 },
      opacity: 0.4,
      visual: {
        crop: { left: 0.33 },
        flipHorizontal: true,
        scaleLocked: false,
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Reset video transform' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset video opacity' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Crop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset video crop' }))
    expect(clipA()).toMatchObject({
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
      visual: {
        crop: { left: 0, right: 0, top: 0, bottom: 0 },
        flipHorizontal: false,
        flipVertical: false,
        scaleLocked: true,
      },
    })
  })

  test('edits, disables, and resets the complete audio surface', () => {
    transport().setSelectedClip('clipD')
    render(<Inspector />)

    fireEvent.change(screen.getByTestId('inspector-volume-slider'), {
      target: { value: '1.5' },
    })
    fireEvent.change(screen.getByTestId('inspector-balance-slider'), {
      target: { value: '0.35' },
    })
    fireEvent.change(screen.getByTestId('inspector-fade-in'), {
      target: { value: '12' },
    })
    fireEvent.keyDown(screen.getByTestId('inspector-fade-in'), { key: 'Enter' })
    fireEvent.change(screen.getByTestId('inspector-fade-out'), {
      target: { value: '15' },
    })
    fireEvent.keyDown(screen.getByTestId('inspector-fade-out'), { key: 'Enter' })

    const audioClip = () => doc().doc.tracks[1].clips[0]
    expect(audioClip()).toMatchObject({
      volume: 1.5,
      audio: {
        enabled: true,
        balance: 0.35,
        fadeInFrames: 12,
        fadeOutFrames: 15,
      },
    })

    fireEvent.click(screen.getByTestId('inspector-audio-enabled'))
    expect(audioClip().audio?.enabled).toBe(false)
    expect(screen.getByTestId('inspector-volume')).toBeDisabled()
    expect(screen.getByTestId('inspector-balance-slider')).toBeDisabled()
    expect(screen.getByTestId('inspector-fade-in')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Reset audio settings' }))
    expect(audioClip()).toMatchObject({
      volume: 1,
      audio: {
        enabled: true,
        balance: 0,
        fadeInFrames: 0,
        fadeOutFrames: 0,
      },
    })
  })

  test('keeps balance disabled for an offline mono source descriptor', () => {
    const descriptor: PortableAssetDescriptor = {
      id: 'asset-1',
      fileName: 'source.mp4',
      mimeType: 'video/mp4',
      size: 1_024,
      lastModified: 0,
      kind: 'video',
      durationMicroseconds: 3_000_000,
      sourceBounds: {
        video: { status: 'unknown' },
        audio: { status: 'unknown' },
      },
      nativeFrameRate: { num: 30, den: 1 },
      width: 1_920,
      height: 1_080,
      hasAudio: true,
      audioSampleRate: 48_000,
      audioChannels: 1,
    }
    useMediaStore.setState({
      descriptors: new Map([[descriptor.id, descriptor]]),
    })
    transport().setSelectedClip('clipD')
    render(<Inspector />)

    expect(screen.getByTestId('inspector-balance')).toBeDisabled()
    expect(screen.getByText(
      'This source is mono, so stereo balance is unavailable.',
    )).toBeInTheDocument()
  })

  test('shows both video and audio surfaces for either member of a linked pair', () => {
    resetDocumentStoreForTest(makeLinkedFixture())
    transport().setSelectedClip('clipLinkedA')
    render(<Inspector />)

    expect(screen.getByText('Video · clipV.mp4')).toBeInTheDocument()
    expect(screen.getByText('Audio · clipLinkedA.mp4')).toBeInTheDocument()
    expect(screen.getByTestId('inspector-x')).toBeEnabled()
    expect(screen.getByTestId('inspector-volume')).toBeEnabled()
    expect(screen.getByTestId('inspector-crop-top-slider')).toBeEnabled()
    expect(screen.getByTestId('inspector-fade-out')).toBeEnabled()
  })

  test('follows the promoted primary when the selected clip is deleted', () => {
    const dispose = initSelectionReconciliation()
    try {
      setMultiSelection(['clipA', 'clipB'], 'clipB')
      render(<Inspector />)
      expect(screen.getByText('clipB.mp4')).toBeInTheDocument()

      act(() => doc().rippleDelete('clipB'))

      expect(transport()).toMatchObject({
        selectedClipIds: ['clipA'],
        selectedClipId: 'clipA',
      })
      expect(screen.getByText('clipA.mp4')).toBeInTheDocument()
    } finally {
      dispose()
    }
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

  test('typed opacity is clamped without adding history when the value stays unchanged', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const opacity = screen.getByTestId('inspector-opacity')

    fireEvent.change(opacity, { target: { value: '5' } })
    fireEvent.keyDown(opacity, { key: 'Enter' })
    expect(clipA().opacity).toBe(1) // clamped
    expect(doc().past).toHaveLength(0)
  })

  test('fields resync on undo and when switching clips', () => {
    transport().setSelectedClip('clipA')
    const { rerender } = render(<Inspector />)
    const x = screen.getByTestId('inspector-x')

    fireEvent.change(x, { target: { value: '40' } })
    fireEvent.keyDown(x, { key: 'Enter' })
    expect(x).toHaveValue(40)

    act(() => doc().undo())
    rerender(<Inspector />)
    expect(screen.getByTestId('inspector-x')).toHaveValue(0)

    act(() => transport().setSelectedClip('clipB'))
    rerender(<Inspector />)
    expect(screen.getByText('clipB.mp4')).toBeInTheDocument()

    act(() => transport().setSelectedClip('gone'))
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

    act(() => doc().undo())
    rerender(<Inspector />)
    expect(screen.getByTestId('inspector-volume')).toHaveValue(1)
  })
})

describe('manual A/V link controls (Issue 12 Slice 6)', () => {
  test('unavailable Link stays discoverable and explains no, partial, same-kind, oversized, and stale selections', () => {
    const { rerender } = render(<Inspector />)
    expect(linkButton()).not.toBeDisabled()
    expect(linkButton()).toHaveAttribute('aria-disabled', 'true')
    expect(linkButton()).toHaveAccessibleDescription(
      'Select one video clip and one audio clip to link them.',
    )
    linkButton().focus()
    expect(linkButton()).toHaveFocus()

    const initialDoc = doc().doc
    const initialPast = doc().past
    fireEvent.click(linkButton())
    expect(doc().doc).toBe(initialDoc)
    expect(doc().past).toBe(initialPast)
    expect(warnSpy).not.toHaveBeenCalled()

    act(() => transport().setSelectedClip('clipA'))
    rerender(<Inspector />)
    expect(linkButton()).toHaveAttribute('aria-disabled', 'true')
    expect(linkButton()).toHaveAccessibleDescription(
      'Select one more clip with Ctrl/Cmd-click, or focus it and press Ctrl/Cmd+Enter.',
    )

    act(() => setMultiSelection(['clipA', 'clipB'], 'clipB'))
    rerender(<Inspector />)
    expect(linkButton()).toHaveAccessibleDescription(
      'Select one video clip and one audio clip; clips on the same kind of track cannot be linked.',
    )

    act(() => setMultiSelection(['clipA', 'clipB', 'clipD'], 'clipD'))
    rerender(<Inspector />)
    expect(linkButton()).toHaveAccessibleDescription(
      'Select exactly two clips: one video and one audio.',
    )

    act(() => setMultiSelection(['clipA', 'deleted-clip'], 'clipA'))
    rerender(<Inspector />)
    expect(linkButton()).toHaveAccessibleDescription(
      'A selected clip is no longer available. Reselect the video and audio clips.',
    )

    act(() => setMultiSelection(['deleted-clip'], 'deleted-clip'))
    rerender(<Inspector />)
    expect(linkButton()).toHaveAccessibleDescription(
      'A selected clip is no longer available. Reselect the video and audio clips.',
    )
  })

  test('accepts either selection order and uses a native keyboard-operable button', () => {
    setMultiSelection(['clipD', 'clipA'], 'clipA')
    const { rerender } = render(<Inspector />)

    expect(linkButton()).not.toBeDisabled()
    expect(linkButton()).toHaveAttribute('aria-disabled', 'false')
    expect(linkButton()).toHaveAccessibleDescription(
      'Ready to link the selected video and audio clips.',
    )
    expect(linkButton().tagName).toBe('BUTTON')
    expect(linkButton()).toHaveAttribute('type', 'button')
    linkButton().focus()
    expect(linkButton()).toHaveFocus()

    act(() => setMultiSelection(['clipA', 'clipD'], 'clipD'))
    rerender(<Inspector />)
    expect(linkButton()).toHaveAttribute('aria-disabled', 'false')
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

    expect(linkButton()).toHaveAttribute('aria-disabled', 'true')
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
    expect(linkButton()).toHaveAttribute('aria-disabled', 'true')
    expect(linkButton()).toHaveAccessibleDescription(
      'Unlock the selected video track before linking.',
    )

    act(() => {
      doc().setDoc(makeLinkedFixture())
      setMultiSelection(['clipV', 'clipLinkedA'], 'clipV')
    })
    rerender(<Inspector />)
    expect(linkButton()).toHaveAttribute('aria-disabled', 'true')
    expect(linkButton()).toHaveAccessibleDescription(
      'The selected video clip is already linked. Unlink it first.',
    )
    expect(screen.getByTestId('inspector-unlink')).toBeInTheDocument()
  })

  test('audio-side locked and already-linked pairs expose their own reasons', () => {
    const unlocked = makeDoc()
    doc().setDoc({
      ...unlocked,
      tracks: unlocked.tracks.map((track) =>
        track.id === 'A1' ? { ...track, locked: true } : track,
      ),
    })
    setMultiSelection(['clipA', 'clipD'], 'clipD')
    const { rerender } = render(<Inspector />)
    expect(linkButton()).toHaveAttribute('aria-disabled', 'true')
    expect(linkButton()).toHaveAccessibleDescription(
      'Unlock the selected audio track before linking.',
    )

    const linked = makeLinkedFixture()
    act(() => {
      doc().setDoc({
        ...linked,
        tracks: linked.tracks.map((track) =>
          track.id === 'V1'
            ? { ...track, clips: [...track.clips, makeClip('clipA', 60, 40)] }
            : track,
        ),
      })
      setMultiSelection(['clipA', 'clipLinkedA'], 'clipLinkedA')
    })
    rerender(<Inspector />)
    expect(linkButton()).toHaveAttribute('aria-disabled', 'true')
    expect(linkButton()).toHaveAccessibleDescription(
      'The selected audio clip is already linked. Unlink it first.',
    )
  })

  test('activation rechecks fresh state and suppresses a newly locked pair without warning', () => {
    setMultiSelection(['clipA', 'clipD'], 'clipD')
    let raced = false
    render(
      <div
        onClickCapture={() => {
          if (raced) return
          raced = true
          const current = doc().doc
          doc().setDoc({
            ...current,
            tracks: current.tracks.map((track) =>
              track.id === 'A1' ? { ...track, locked: true } : track,
            ),
          })
        }}
      >
        <Inspector />
      </div>,
    )
    expect(linkButton()).toHaveAttribute('aria-disabled', 'false')

    fireEvent.click(linkButton())

    expect(doc().doc.tracks[0].clips[0].linkGroupId).toBeUndefined()
    expect(doc().doc.tracks[1].clips[0].linkGroupId).toBeUndefined()
    expect(linkButton()).toHaveAttribute('aria-disabled', 'true')
    expect(linkButton()).toHaveAccessibleDescription(
      'Unlock the selected audio track before linking.',
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('a formerly unavailable Link requires a second activation after becoming eligible', () => {
    const locked = makeDoc()
    locked.tracks[1] = { ...locked.tracks[1], locked: true }
    doc().setDoc(locked)
    setMultiSelection(['clipA', 'clipD'], 'clipD')
    let raced = false
    render(
      <div
        onClickCapture={() => {
          if (raced) return
          raced = true
          doc().setDoc(makeDoc())
        }}
      >
        <Inspector />
      </div>,
    )
    expect(linkButton()).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(linkButton())

    expect(doc().doc.tracks[0].clips[0].linkGroupId).toBeUndefined()
    expect(doc().doc.tracks[1].clips[0].linkGroupId).toBeUndefined()
    expect(doc().past).toHaveLength(0)
    expect(linkButton()).toHaveAttribute('aria-disabled', 'false')
    expect(screen.getByTestId('inspector-linking-action-status')).toHaveTextContent(
      'Link availability changed. Review the selected clips, then activate Link again.',
    )

    fireEvent.click(linkButton())
    expect(doc().doc.tracks[0].clips[0].linkGroupId).toBeDefined()
    expect(doc().doc.tracks[1].clips[0].linkGroupId).toBeDefined()
    expect(doc().past).toHaveLength(1)
  })

  test('a raced valid selection never links a different pair than the rendered target', () => {
    setMultiSelection(['clipA', 'clipD'], 'clipD')
    let raced = false
    render(
      <div
        onClickCapture={() => {
          if (raced) return
          raced = true
          setMultiSelection(['clipB', 'clipD'], 'clipD')
        }}
      >
        <Inspector />
      </div>,
    )

    fireEvent.click(linkButton())

    expect(doc().doc.tracks[0].clips[0].linkGroupId).toBeUndefined()
    expect(doc().doc.tracks[0].clips[1].linkGroupId).toBeUndefined()
    expect(doc().doc.tracks[1].clips[0].linkGroupId).toBeUndefined()
    expect(doc().past).toHaveLength(0)
    expect(screen.getByTestId('inspector-linking-action-status')).toHaveTextContent(
      'Linking was not completed because the selection changed. Review the selected clips and try again.',
    )
  })

  test('a defensive store no-op reports rejection and preserves selection/history', () => {
    setMultiSelection(['clipA', 'clipD'], 'clipD')
    const originalLinkClips = doc().linkClips
    const rejectedLink = vi.fn()
    useDocumentStore.setState({ linkClips: rejectedLink })

    try {
      render(<Inspector />)
      const beforeDoc = doc().doc
      const beforePast = doc().past
      const beforeSelection = transport().selectedClipIds

      fireEvent.click(linkButton())

      expect(rejectedLink).toHaveBeenCalledOnce()
      expect(doc().doc).toBe(beforeDoc)
      expect(doc().past).toBe(beforePast)
      expect(transport().selectedClipIds).toBe(beforeSelection)
      expect(screen.getByTestId('inspector-linking-action-status')).toHaveTextContent(
        'Linking was rejected because the project changed. Reselect both clips and try again.',
      )
    } finally {
      useDocumentStore.setState({ linkClips: originalLinkClips })
    }
  })

  test('keyboard-only Link and Unlink retain both rendered selections, primary, and badges', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Timeline />
        <Inspector />
      </>,
    )

    const video = screen.getByRole('button', {
      name: 'clipA.mp4, video clip',
    })
    const audio = screen.getByRole('button', {
      name: 'clipD.mp4, audio clip',
    })
    await user.click(video)
    audio.focus()
    await user.keyboard('{Control>}{Enter}{/Control}')

    expect(video).toHaveAttribute('aria-pressed', 'true')
    expect(audio).toHaveAttribute('aria-pressed', 'true')
    expect(video).toHaveClass('selected')
    expect(audio).toHaveClass('selected', 'primary-selected')
    expect(screen.getByTestId('inspector-panel')).toHaveTextContent('clipD.mp4')

    linkButton().focus()
    await user.keyboard('{Enter}')

    expect(doc().past).toHaveLength(1)
    expect(transport().selectedClipIds).toEqual(['clipA', 'clipD'])
    expect(transport().selectedClipId).toBe('clipD')
    expect(screen.getByTestId('clip-clipA-link')).toBeInTheDocument()
    expect(screen.getByTestId('clip-clipD-link')).toBeInTheDocument()
    expect(video).toHaveAttribute('aria-pressed', 'true')
    expect(audio).toHaveAttribute('aria-pressed', 'true')
    expect(audio).toHaveAttribute('data-primary-selected', 'true')

    unlinkButton().focus()
    expect(unlinkButton()).toHaveAccessibleDescription(
      'Ready to unlink this audio/video pair.',
    )
    await user.keyboard(' ')

    expect(doc().past).toHaveLength(2)
    expect(screen.queryByTestId('clip-clipA-link')).not.toBeInTheDocument()
    expect(screen.queryByTestId('clip-clipD-link')).not.toBeInTheDocument()
    expect(transport().selectedClipIds).toEqual(['clipA', 'clipD'])
    expect(transport().selectedClipId).toBe('clipD')
    expect(video).toHaveAttribute('aria-pressed', 'true')
    expect(audio).toHaveAttribute('aria-pressed', 'true')
    expect(audio).toHaveAttribute('data-primary-selected', 'true')
    expect(linkButton()).toHaveFocus()
    expect(warnSpy).not.toHaveBeenCalled()
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

  test('Unlink reacts to either linked track locking, stays focusable, and rejects without warning', () => {
    doc().setDoc(makeLinkedDoc())
    transport().setSelectedClip('clipV')
    render(<Inspector />)
    expect(unlinkButton()).toHaveAttribute('aria-disabled', 'false')

    const partnerLocked = makeLinkedDoc()
    partnerLocked.tracks[1] = { ...partnerLocked.tracks[1], locked: true }
    act(() => doc().setDoc(partnerLocked))

    expect(unlinkButton()).not.toBeDisabled()
    expect(unlinkButton()).toHaveAttribute('aria-disabled', 'true')
    expect(unlinkButton()).toHaveAccessibleDescription(
      'Unlock audio track A1 before unlinking.',
    )
    unlinkButton().focus()
    expect(unlinkButton()).toHaveFocus()

    const beforeDoc = doc().doc
    const beforePast = doc().past
    fireEvent.click(unlinkButton())
    expect(doc().doc).toBe(beforeDoc)
    expect(doc().past).toBe(beforePast)
    expect(warnSpy).not.toHaveBeenCalled()

    const ownerLocked = makeLinkedDoc()
    ownerLocked.tracks[0] = { ...ownerLocked.tracks[0], locked: true }
    act(() => doc().setDoc(ownerLocked))
    expect(unlinkButton()).toHaveAttribute('aria-disabled', 'true')
    expect(unlinkButton()).toHaveAccessibleDescription(
      'Unlock video track V1 before unlinking.',
    )

    const hiddenAndMuted = makeLinkedDoc()
    hiddenAndMuted.tracks[0] = { ...hiddenAndMuted.tracks[0], hidden: true }
    hiddenAndMuted.tracks[1] = { ...hiddenAndMuted.tracks[1], muted: true }
    act(() => doc().setDoc(hiddenAndMuted))
    expect(unlinkButton()).toHaveAttribute('aria-disabled', 'false')
    expect(unlinkButton()).toHaveAccessibleDescription(
      'Ready to unlink this audio/video pair.',
    )
  })

  test('a formerly unavailable Unlink requires a second activation after becoming eligible', () => {
    const locked = makeLinkedDoc()
    locked.tracks[1] = { ...locked.tracks[1], locked: true }
    doc().setDoc(locked)
    transport().setSelectedClip('clipV')
    let raced = false
    render(
      <div
        onClickCapture={() => {
          if (raced) return
          raced = true
          doc().setDoc(makeLinkedDoc())
        }}
      >
        <Inspector />
      </div>,
    )
    expect(unlinkButton()).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(unlinkButton())

    expect(doc().doc.tracks[0].clips[0].linkGroupId).toBe('link_1')
    expect(doc().doc.tracks[1].clips[0].linkGroupId).toBe('link_1')
    expect(doc().past).toHaveLength(0)
    expect(unlinkButton()).toHaveAttribute('aria-disabled', 'false')
    expect(screen.getByTestId('inspector-linking-action-status')).toHaveTextContent(
      'Unlink availability changed. Review the selected clip, then activate Unlink again.',
    )

    fireEvent.click(unlinkButton())
    expect(doc().doc.tracks[0].clips[0].linkGroupId).toBeUndefined()
    expect(doc().doc.tracks[1].clips[0].linkGroupId).toBeUndefined()
    expect(doc().past).toHaveLength(1)
  })

  test('a selection race keeps its Unlink rejection visible after the button disappears', () => {
    doc().setDoc(makeLinkedDoc())
    transport().setSelectedClip('clipV')
    let raced = false
    render(
      <div
        onClickCapture={() => {
          if (raced) return
          raced = true
          transport().setSelectedClip(null)
        }}
      >
        <Inspector />
      </div>,
    )
    const beforeDoc = doc().doc
    const beforePast = doc().past

    fireEvent.click(unlinkButton())

    expect(doc().doc).toBe(beforeDoc)
    expect(doc().past).toBe(beforePast)
    expect(screen.queryByTestId('inspector-unlink')).not.toBeInTheDocument()
    expect(screen.getByTestId('inspector-linking-action-status')).toHaveTextContent(
      'Select a linked clip to unlink its audio/video pair.',
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('a raced link-group replacement never unlinks a different pair', () => {
    doc().setDoc(makeLinkedDoc())
    transport().setSelectedClip('clipV')
    let raced = false
    render(
      <div
        onClickCapture={() => {
          if (raced) return
          raced = true
          const replacement = makeLinkedDoc()
          replacement.tracks = replacement.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) => ({
              ...clip,
              linkGroupId: 'link_2',
            })),
          }))
          doc().setDoc(replacement)
        }}
      >
        <Inspector />
      </div>,
    )

    fireEvent.click(unlinkButton())

    expect(doc().doc.tracks[0].clips[0].linkGroupId).toBe('link_2')
    expect(doc().doc.tracks[1].clips[0].linkGroupId).toBe('link_2')
    expect(doc().past).toHaveLength(0)
    expect(screen.getByTestId('inspector-linking-action-status')).toHaveTextContent(
      'Unlinking was not completed because the linked pair changed. Review the selected clip and try again.',
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('a defensive Unlink no-op reports rejection without changing references', () => {
    doc().setDoc(makeLinkedDoc())
    transport().setSelectedClip('clipV')
    const originalUnlinkClip = doc().unlinkClip
    const rejectedUnlink = vi.fn()
    useDocumentStore.setState({ unlinkClip: rejectedUnlink })

    try {
      render(<Inspector />)
      const beforeDoc = doc().doc
      const beforePast = doc().past
      const beforeSelection = transport().selectedClipIds

      fireEvent.click(unlinkButton())

      expect(rejectedUnlink).toHaveBeenCalledOnce()
      expect(doc().doc).toBe(beforeDoc)
      expect(doc().past).toBe(beforePast)
      expect(transport().selectedClipIds).toBe(beforeSelection)
      expect(screen.getByTestId('inspector-linking-action-status')).toHaveTextContent(
        'Unlinking was rejected because the project changed. Select the linked clip and try again.',
      )
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      useDocumentStore.setState({ unlinkClip: originalUnlinkClip })
    }
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
