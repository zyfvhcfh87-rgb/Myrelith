import { act, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { CaptionTranscriptionSnapshot } from '../app/captionTranscriptionController'
import CaptionTranscriptionPanel from './CaptionTranscriptionPanel'

const owner = vi.hoisted(() => {
  let snapshot: CaptionTranscriptionSnapshot = { phase: 'idle', installed: null, message: '', progress: 0, rows: [], error: null, sourceSampleRate: 16000 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh: async () => {},
    phase: (phase: CaptionTranscriptionSnapshot['phase']) => {
      snapshot = { ...snapshot, phase }
      for (const listener of listeners) listener()
    },
  }
})
vi.mock('../app/captionTranscriptionController', async () => ({
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
