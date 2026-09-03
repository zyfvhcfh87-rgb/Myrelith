/**
 * ui/timeline/trackheader.test.tsx — timeline tracks upgrade.
 *
 * The header gutter: one TrackHeader per track in DISPLAY order (video
 * stack top-down — the topmost composite layer first — then audio), with
 * working hide/mute/lock toggles and add-track buttons. Toggle behavior
 * itself (compositor skips, edit rejection) is enforced elsewhere; here we
 * verify the wiring: click → documentStore change → one undo entry.
 */

import { beforeEach, describe, expect, test } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  createTimelineDoc,
  DEFAULT_PROJECT_SETTINGS,
} from '../../domain/projectSettings'
import type { Clip, TimelineDoc, Track as TrackData } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { resetTransportStoreForTest } from '../../test/storeFixtures'
import Timeline from './Timeline'

function makeClip(id: string, tlStart: number, duration: number): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, kind: TrackData['kind'], clips: Clip[] = []): TrackData {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked: false }
}

/** V1 (2 clips), V2 (empty), A1 (1 clip) — doc order = compositing order. */
function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 19,
    id: 'doc-headers',
    name: 'header fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', 'video', [makeClip('c1', 0, 50), makeClip('c2', 100, 50)]),
      makeTrack('V2', 'video'),
      makeTrack('A1', 'audio', [makeClip('c3', 0, 80)]),
    ],
  }
}

const getState = () => useDocumentStore.getState()
const trackById = (id: string) =>
  getState().doc.tracks.find((t) => t.id === id) as TrackData

beforeEach(() => {
  getState().setDoc(makeDoc())
  resetTransportStoreForTest()
})

describe('header gutter', () => {
  test('a fresh project renders four video and four audio lanes in display order', () => {
    getState().setDoc(createTimelineDoc(
      'Fresh tracks',
      DEFAULT_PROJECT_SETTINGS,
      'doc-fresh-tracks',
    ))
    render(<Timeline />)

    const headerIds = screen
      .getAllByTestId(/^track-header-/)
      .map((element) => element.dataset.testid)
    expect(headerIds).toEqual([
      'track-header-V4',
      'track-header-V3',
      'track-header-V2',
      'track-header-V1',
      'track-header-A1',
      'track-header-A2',
      'track-header-A3',
      'track-header-A4',
    ])

    const laneIds = screen
      .getAllByTestId(/^track-(V|A)\d/)
      .map((element) => element.dataset.testid)
    expect(laneIds).toEqual(headerIds.map((id) => id?.replace('-header', '')))
  })

  test('headers AND lanes render in display order: V2 over V1, audio below', () => {
    render(<Timeline />)
    const headerIds = screen
      .getAllByTestId(/^track-header-/)
      .map((el) => el.dataset.testid)
    expect(headerIds).toEqual(['track-header-V2', 'track-header-V1', 'track-header-A1'])

    const laneIds = screen.getAllByTestId(/^track-(V|A)\d/).map((el) => el.dataset.testid)
    expect(laneIds).toEqual(['track-V2', 'track-V1', 'track-A1'])
  })

  test('a header shows the track badge, kind and clip count', () => {
    render(<Timeline />)
    const v1 = screen.getByTestId('track-header-V1')
    expect(v1).toHaveTextContent('V1')
    expect(v1).toHaveTextContent('Video')
    expect(v1).toHaveTextContent('2 clips')
    expect(screen.getByTestId('track-header-A1')).toHaveTextContent('1 clip')
    expect(screen.getByTestId('track-header-V2')).toHaveTextContent('0 clips')
  })

  test('video headers offer hide, audio headers offer mute, both offer lock', () => {
    render(<Timeline />)
    expect(screen.getByLabelText('target track V1')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('target track V2')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('target track A1')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('hide track V1')).toBeInTheDocument()
    expect(screen.queryByLabelText('mute track V1')).not.toBeInTheDocument()
    expect(screen.getByLabelText('mute track A1')).toBeInTheDocument()
    expect(screen.queryByLabelText('hide track A1')).not.toBeInTheDocument()
    expect(screen.getByLabelText('lock track V1')).toBeInTheDocument()
    expect(screen.getByLabelText('lock track A1')).toBeInTheDocument()
  })
})

describe('toggle wiring', () => {
  test('target toggle is session-only and writes no history', () => {
    render(<Timeline />)
    expect(getState().past).toHaveLength(0)
    fireEvent.click(screen.getByLabelText('target track V2'))
    expect(screen.getByLabelText('target track V2')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('target track V1')).toHaveAttribute('aria-pressed', 'false')
    expect(getState().past).toHaveLength(0)
  })

  test('hide toggles doc.hidden; each real change is ONE undo entry', () => {
    render(<Timeline />)
    const hide = screen.getByLabelText('hide track V1')
    expect(hide).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(hide)
    expect(trackById('V1').hidden).toBe(true)
    expect(getState().past).toHaveLength(1)
    expect(screen.getByLabelText('hide track V1')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByLabelText('hide track V1'))
    expect(trackById('V1').hidden).toBe(false)
    expect(getState().past).toHaveLength(2)
  })

  test('mute and lock write their flags', () => {
    render(<Timeline />)
    fireEvent.click(screen.getByLabelText('mute track A1'))
    expect(trackById('A1').muted).toBe(true)

    fireEvent.click(screen.getByLabelText('lock track V1'))
    expect(trackById('V1').locked).toBe(true)
  })

  test('the lock button UNLOCKS a locked track (flags bypass the locked rule)', () => {
    getState().setTrackFlags('V1', { locked: true })
    render(<Timeline />)
    fireEvent.click(screen.getByLabelText('lock track V1'))
    expect(trackById('V1').locked).toBe(false)
  })

  test('lanes mirror the flags as classes (visual state only)', () => {
    getState().setTrackFlags('V1', { hidden: true })
    getState().setTrackFlags('A1', { muted: true, locked: true })
    render(<Timeline />)
    expect(screen.getByTestId('track-V1')).toHaveClass('track-hidden')
    expect(screen.getByTestId('track-A1')).toHaveClass('track-muted', 'track-locked')
  })
})

describe('add-track buttons', () => {
  test('a fresh four-by-four stack continues with V5 and A5', () => {
    getState().setDoc(createTimelineDoc(
      'Fresh tracks',
      DEFAULT_PROJECT_SETTINGS,
      'doc-fresh-tracks',
    ))
    render(<Timeline />)

    fireEvent.click(screen.getByLabelText('add video track'))
    fireEvent.click(screen.getByLabelText('add audio track'))

    expect(getState().doc.tracks.map((track) => track.id)).toEqual([
      'V1', 'V2', 'V3', 'V4', 'V5',
      'A1', 'A2', 'A3', 'A4', 'A5',
    ])
    expect(screen.getByTestId('track-header-V5')).toBeInTheDocument()
    expect(screen.getByTestId('track-header-A5')).toBeInTheDocument()
  })

  test('+ Video inserts above the video stack (display top) as one undo entry', () => {
    render(<Timeline />)
    fireEvent.click(screen.getByLabelText('add video track'))

    // Doc order: after the last video → composites above V2.
    expect(getState().doc.tracks.map((t) => t.id)).toEqual(['V1', 'V2', 'V3', 'A1'])
    // Display order: the new top layer is the top row.
    const headerIds = screen
      .getAllByTestId(/^track-header-/)
      .map((el) => el.dataset.testid)
    expect(headerIds).toEqual([
      'track-header-V3',
      'track-header-V2',
      'track-header-V1',
      'track-header-A1',
    ])

    expect(getState().past).toHaveLength(1)
    act(() => getState().undo())
    expect(getState().doc.tracks.map((t) => t.id)).toEqual(['V1', 'V2', 'A1'])
  })

  test('+ Audio appends below the audio stack', () => {
    render(<Timeline />)
    fireEvent.click(screen.getByLabelText('add audio track'))
    expect(getState().doc.tracks.map((t) => t.id)).toEqual(['V1', 'V2', 'A1', 'A2'])
    const headerIds = screen
      .getAllByTestId(/^track-header-/)
      .map((el) => el.dataset.testid)
    expect(headerIds[headerIds.length - 1]).toBe('track-header-A2')
  })

  test('a drop lane exists for the new track immediately', () => {
    render(<Timeline />)
    fireEvent.click(screen.getByLabelText('add video track'))
    expect(screen.getByTestId('track-V3')).toBeInTheDocument()
  })
})

describe('rename (double-click the header)', () => {
  test('Enter commits the trimmed name as ONE entry; badge shows it', () => {
    render(<Timeline />)
    fireEvent.doubleClick(screen.getByTestId('track-header-V1'))
    const input = screen.getByTestId('track-rename-V1') as HTMLInputElement
    expect(input.value).toBe('V1') // prefilled with the current name

    fireEvent.change(input, { target: { value: '  Main cam ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(trackById('V1').name).toBe('Main cam')
    expect(trackById('V1').id).toBe('V1') // id is stable
    expect(getState().past).toHaveLength(1)
    expect(screen.queryByTestId('track-rename-V1')).not.toBeInTheDocument()
    expect(screen.getByTestId('track-header-V1')).toHaveTextContent('Main cam')
  })

  test('Escape cancels, and an emptied name cancels too — no history', () => {
    render(<Timeline />)
    fireEvent.doubleClick(screen.getByTestId('track-header-V1'))
    fireEvent.keyDown(screen.getByTestId('track-rename-V1'), { key: 'Escape' })
    expect(screen.queryByTestId('track-rename-V1')).not.toBeInTheDocument()

    fireEvent.doubleClick(screen.getByTestId('track-header-V1'))
    const input = screen.getByTestId('track-rename-V1')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(trackById('V1').name).toBe('V1')
    expect(getState().past).toHaveLength(0)
  })

  test('blur commits like Enter', () => {
    render(<Timeline />)
    fireEvent.doubleClick(screen.getByTestId('track-header-A1'))
    const input = screen.getByTestId('track-rename-A1')
    fireEvent.change(input, { target: { value: 'Music' } })
    fireEvent.blur(input)
    expect(trackById('A1').name).toBe('Music')
    expect(getState().past).toHaveLength(1)
  })
})

describe('rename from the keyboard', () => {
  test('the Rename button opens, commits, restores focus, and undoes', () => {
    render(<Timeline />)
    const trigger = screen.getByRole('button', { name: 'rename track V1' })
    trigger.focus()
    fireEvent.click(trigger)

    const input = screen.getByTestId('track-rename-V1') as HTMLInputElement
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'Main cam' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(trackById('V1').name).toBe('Main cam')
    expect(getState().past).toHaveLength(1)
    expect(screen.queryByTestId('track-rename-V1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'rename track Main cam' })).toHaveFocus()

    act(() => getState().undo())
    expect(trackById('V1').name).toBe('V1')
    expect(screen.getByRole('button', { name: 'rename track V1' })).toBeInTheDocument()
  })

  test('Escape cancels rename and restores focus without history', () => {
    render(<Timeline />)
    const trigger = screen.getByRole('button', { name: 'rename track V2' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByTestId('track-rename-V2'), { key: 'Escape' })

    expect(screen.queryByTestId('track-rename-V2')).not.toBeInTheDocument()
    expect(trackById('V2').name).toBe('V2')
    expect(getState().past).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'rename track V2' })).toHaveFocus()
  })
})

describe('delete button', () => {
  test('removes header + lane as ONE entry; one undo restores the clips too', () => {
    render(<Timeline />)
    fireEvent.click(screen.getByLabelText('delete track V1')) // carries 2 clips

    expect(getState().doc.tracks.map((t) => t.id)).toEqual(['V2', 'A1'])
    expect(screen.queryByTestId('track-header-V1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('track-V1')).not.toBeInTheDocument()
    expect(getState().past).toHaveLength(1)

    act(() => getState().undo())
    expect(trackById('V1').clips).toHaveLength(2)
    expect(screen.getByTestId('track-header-V1')).toBeInTheDocument()
  })

  test('disabled while the track is locked', () => {
    getState().setTrackFlags('V1', { locked: true })
    render(<Timeline />)
    expect(screen.getByLabelText('delete track V1')).toBeDisabled()
    expect(screen.getByLabelText('delete track V2')).toBeEnabled()
  })
})

describe('solo button', () => {
  test('audio headers offer solo; video headers do not', () => {
    render(<Timeline />)
    expect(screen.getByLabelText('solo track A1')).toBeInTheDocument()
    expect(screen.queryByLabelText('solo track V1')).not.toBeInTheDocument()
  })

  test('solo dims every OTHER audio lane, and clears when unsolo’d', () => {
    getState().addTrack('audio') // A2 joins A1
    render(<Timeline />)

    fireEvent.click(screen.getByLabelText('solo track A1'))
    expect(trackById('A1').solo).toBe(true)
    expect(screen.getByTestId('track-A2')).toHaveClass('track-solo-dimmed')
    expect(screen.getByTestId('track-A1')).not.toHaveClass('track-solo-dimmed')
    expect(screen.getByTestId('track-V1')).not.toHaveClass('track-solo-dimmed')

    fireEvent.click(screen.getByLabelText('solo track A1'))
    expect(screen.getByTestId('track-A2')).not.toHaveClass('track-solo-dimmed')
  })
})
