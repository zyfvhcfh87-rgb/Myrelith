import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import MaskPathAnimation from './MaskPathAnimation'
import Inspector from './Inspector'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useMediaStore } from '../state/mediaStore'
import { foundationProject, pathTrack, ATTRIBUTE_ASSET_DESCRIPTOR } from '../test/animationFoundationFixtures'
import { createMaskEffect } from '../domain/effectStack'
import { resolveClipAnimationAtFrame } from '../domain/clipAnimation'
import { commitMaskParams } from '../app/maskEditingController'

const target = { sequenceId: 'animation-foundation', clipId: 'clip', effectId: 'mask' }
const path = 'M 0 0 C 1 0 1 1 0 0 Z'
const currentClip = () => useDocumentStore.getState().doc.tracks[0].clips[0]
function Harness() {
  const doc = useDocumentStore((state) => state.doc), frame = useTransportStore((state) => state.playheadFrame)
  const clip = doc.tracks[0].clips[0], resolved = resolveClipAnimationAtFrame(clip, frame)
  return <MaskPathAnimation clip={clip} effect={resolved.effects[0]} playheadFrame={frame} locked={doc.tracks[0].locked} />
}
beforeEach(() => {
  useTransportStore.getState().resetTransport()
  useMediaStore.setState({ descriptors: new Map([['asset', ATTRIBUTE_ASSET_DESCRIPTOR]]), collections: [] })
  const project = foundationProject(); project.sequences[0].tracks[0].clips[0].effects = [createMaskEffect('mask', 'bezier')]
  useDocumentStore.getState().setProject(project)
  useTransportStore.getState().setSelectedClip('clip')
})
afterEach(() => { cleanup(); useTransportStore.getState().resetTransport() })

test('Animate, explicit held keys, navigation, removal and reset use actual history', () => {
  render(<Harness />)
  const fallback = currentClip().effects[0].params.path
  fireEvent.click(screen.getByRole('button', { name: 'Animate mask path' }))
  act(() => useTransportStore.getState().setPlayheadFrame(15))
  act(() => { expect(commitMaskParams(target, { path })).toBeNull() })
  expect(screen.getByText(/2 held path keys/)).toBeVisible()
  expect(currentClip().effects[0].params.path).toBe(fallback)
  fireEvent.click(screen.getByRole('button', { name: 'Previous path key' }))
  expect(useTransportStore.getState().playheadFrame).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Next path key' }))
  expect(useTransportStore.getState().playheadFrame).toBe(15)
  const before = useDocumentStore.getState().project
  fireEvent.click(screen.getByRole('button', { name: 'Remove path key at playhead' }))
  expect(currentClip().animation?.effectPathTracks?.[0].keyframes).toHaveLength(1)
  act(() => useDocumentStore.getState().undo()); expect(useDocumentStore.getState().project).toBe(before)
  fireEvent.click(screen.getByRole('button', { name: 'Clear path keys' }))
  expect(currentClip().animation?.effectPathTracks).toEqual([])
  expect(resolveClipAnimationAtFrame(currentClip(), 15).effects[0].params.path).toBe(fallback)
})

test.each(['future', 'malformed', 'dormant'] as const)('shows %s intent without overwriting it', (kind) => {
  const doc = structuredClone(useDocumentStore.getState().doc), clip = doc.tracks[0].clips[0], lane = pathTrack()
  if (kind === 'future') lane.valueVersion = 8
  if (kind === 'malformed') lane.keyframes[1].value = 'preserved malformed intent'
  if (kind === 'dormant') clip.effects[0].params.shape = 'ellipse'
  clip.animation = { tracks: [], effectPathTracks: [lane] }
  useDocumentStore.getState().setDoc(doc)
  const before = JSON.stringify(useDocumentStore.getState().project)
  render(<Harness />)
  expect(screen.getByRole('button', { name: 'Set path key at playhead' })).toBeDisabled()
  if (kind === 'dormant') expect(screen.getByText(/keys are dormant/)).toBeVisible()
  else {
    expect(screen.getByRole('status')).toHaveTextContent(/unavailable/)
    expect(screen.getByRole('button', { name: 'Clear path keys' })).toBeDisabled()
  }
  expect(JSON.stringify(useDocumentStore.getState().project)).toBe(before)
})

test('path field writes the animated key, Escape discards, and changing frame cancels a typed draft', () => {
  render(<Inspector />)
  fireEvent.click(screen.getByRole('tab', { name: 'Effects' }))
  fireEvent.click(screen.getByRole('button', { name: 'Animate mask path' }))
  act(() => useTransportStore.getState().setPlayheadFrame(15))
  const field = screen.getByTestId('inspector-effect-mask-path-mask')
  const before = useDocumentStore.getState().project
  fireEvent.change(field, { target: { value: path } })
  fireEvent.keyDown(field, { key: 'Escape' }); fireEvent.blur(field)
  expect(useDocumentStore.getState().project).toBe(before)
  fireEvent.change(field, { target: { value: path } })
  act(() => useTransportStore.getState().setPlayheadFrame(16))
  fireEvent.blur(field)
  expect(useDocumentStore.getState().project).toBe(before)
  fireEvent.change(field, { target: { value: path } }); fireEvent.blur(field)
  expect(currentClip().animation?.effectPathTracks?.[0].keyframes.at(-1)).toMatchObject({ frame: 16, value: path })
  expect(useDocumentStore.getState().past).toHaveLength(2)
})
