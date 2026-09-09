import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useMediaStore } from '../state/mediaStore'
import type { MediaAsset } from '../domain/schema'
import type { CaptionTranscriptionSnapshot } from '../app/captionTranscriptionController'
import CaptionTranscriptionPanel from './CaptionTranscriptionPanel'

const owner = vi.hoisted(() => {
  let snapshot: CaptionTranscriptionSnapshot = { phase: 'idle', installed: null, message: '', progress: 0, rows: [], error: null, sourceSampleRate: 16000 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh: async () => {},
    reviewRows: (rows: CaptionTranscriptionSnapshot['rows']) => { snapshot = { ...snapshot, rows } },
    phase: (phase: CaptionTranscriptionSnapshot['phase']) => {
      snapshot = { ...snapshot, phase }
      for (const listener of listeners) listener()
    },
  }
})
vi.mock('../app/captionTranscriptionController', async () => ({
  ...(await vi.importActual('../app/captionTranscriptionController')),
  captionTranscription: owner,
  SPEECH_MODEL: (await import('../domain/speechModel')).SPEECH_MODEL,
}))

test('speech phase changes keep focus inside the dialog on an enabled control or heading', () => {
  render(<CaptionTranscriptionPanel onClose={() => {}} />)
  expect(screen.getByRole('heading', { name: 'Transcribe local audio' })).toHaveFocus()
  act(() => owner.phase('preparing'))
  expect(screen.getByRole('button', { name: 'Cancel speech' })).toHaveFocus()
  act(() => owner.phase('running'))
  expect(screen.getByRole('button', { name: 'Cancel speech' })).toHaveFocus()
  act(() => owner.phase('stopping'))
  expect(screen.getByRole('button', { name: 'Cancel speech' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Close transcription' })).toHaveFocus()
  act(() => owner.phase('idle'))
  expect(screen.getByRole('heading', { name: 'Transcribe local audio' })).toHaveFocus()
  act(() => owner.phase('review'))
  expect(screen.getByRole('heading', { name: 'Review transcript' })).toHaveFocus()
})

test('review text explicitly disables browser spellcheck', () => {
  owner.reviewRows([{ id: 'row', text: 'Private speech', startFrame: 0, endFrame: 30,
    included: true, timing: 'model', sourceStartSample: 0, sourceSampleCount: 16000 }])
  owner.phase('review')
  render(<CaptionTranscriptionPanel onClose={() => {}} />)
  expect(screen.getByRole('textbox', { name: /Text 1/ })).toHaveAttribute('spellcheck', 'false')
})

test('default window follows audio bounds when video starts earlier or lasts longer', () => {
  const asset = (id: string, first: number, end: number): MediaAsset => ({ id, fileName: id + '.mp4',
    mimeType: 'video/mp4', size: 16, lastModified: 1, objectUrl: 'blob:' + id, kind: 'video',
    durationFrames: 36000, durationMicroseconds: 1200_000_000, frameRate: null, width: 16, height: 16,
    hasAudio: true, audioSampleRate: 48000, audioChannels: 2, decoderConfigB64: null,
    sourceBounds: { video: null, audio: { status: 'exact', firstTimestampUs: first, endTimestampUs: end } } })
  owner.phase('idle')
  useMediaStore.setState({ assets: new Map([['delayed', asset('delayed', 21_333, 2_345_678)], ['later', asset('later', 600_000_000, 1200_000_000)]]) })
  render(<CaptionTranscriptionPanel onClose={() => {}} />)
  expect(screen.getByLabelText('Source start (seconds)')).toHaveValue(0.022)
  expect(screen.getByLabelText('Source end (seconds)')).toHaveValue(2.345)
  fireEvent.change(screen.getByLabelText('Connected audio source'), { target: { value: 'later' } })
  expect(screen.getByLabelText('Source start (seconds)')).toHaveValue(600)
  expect(screen.getByLabelText('Source end (seconds)')).toHaveValue(900)
})
