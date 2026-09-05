import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { MulticamDefinition } from '../domain/schema'
import { INITIAL_MULTICAM_ALIGNMENT, useMulticamAlignmentStore } from '../state/multicamAlignmentStore'
import { analyzeMulticam, applyMulticamAlignment, cancelMulticamAlignment } from '../app/multicamAlignmentController'
import MulticamAlignmentControls from './MulticamAlignmentControls'
vi.mock('../app/multicamAlignmentController', () => ({ analyzeMulticam: vi.fn(async () => {}),
  applyMulticamAlignment: vi.fn(() => true), cancelMulticamAlignment: vi.fn(async () => {}) }))
const definition: MulticamDefinition = { id: 'multicam', name: 'Concert', durationFrames: 600,
  angles: ['A', 'B'].map((name) => ({ id: name, name, assetId: name, sourceStartFrame: 0, coverage: { startFrame: 0, durationFrames: 500 } })),
  switches: [{ frame: 0, videoAngleId: 'A' }], audioPolicy: { kind: 'fixed', angleId: 'A' } }
beforeEach(() => { vi.clearAllMocks(); useMulticamAlignmentStore.setState({ ...INITIAL_MULTICAM_ALIGNMENT }) })
test('admits exact 5ms decimal windows without floating-point rejection', () => {
  render(<MulticamAlignmentControls definition={definition} />)
  fireEvent.click(screen.getByText('Align by audio or timecode'))
  fireEvent.change(screen.getByLabelText('Window start for B (seconds)'), { target: { value: '1.005' } })
  fireEvent.click(screen.getByRole('button', { name: 'Analyze alignment' }))
  expect(analyzeMulticam).toHaveBeenCalledWith(expect.objectContaining({ startBins: { A: 200, B: 201 } }))
})
test('timecode asks for common clock/day confirmation before analysis', () => {
  render(<MulticamAlignmentControls definition={definition} />)
  fireEvent.click(screen.getByText('Align by audio or timecode'))
  fireEvent.change(screen.getByLabelText('Alignment method'), { target: { value: 'timecode' } })
  expect(screen.getByRole('button', { name: 'Analyze alignment' })).toBeDisabled()
  fireEvent.click(screen.getByLabelText('These recordings share a timecode clock and calendar day, with no midnight crossing.'))
  expect(screen.getByRole('button', { name: 'Analyze alignment' })).toBeEnabled()
})
test('only eligible rows expose correction and apply; changing settings dismisses the old proposal', () => {
  useMulticamAlignmentStore.setState({ definitionId: definition.id, phase: 'ready', rows: [{ angleId: 'B', name: 'B', currentFrame: 0,
    proposedFrame: 23, state: 'aligned', detail: 'Unique match', fromCache: false, facts: null }] })
  render(<MulticamAlignmentControls definition={definition} />)
  fireEvent.click(screen.getByText('Align by audio or timecode'))
  fireEvent.change(screen.getByLabelText('Proposed offset for B (frames)'), { target: { value: '24' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed offsets' }))
  expect(applyMulticamAlignment).toHaveBeenCalledWith([{ angleId: 'B', coverageStartFrame: 24 }])
  fireEvent.change(screen.getByLabelText('Window duration (seconds)'), { target: { value: '5' } })
  expect(cancelMulticamAlignment).toHaveBeenCalled()
})
