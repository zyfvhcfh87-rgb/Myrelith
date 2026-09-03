import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createAdjustmentItem,
  findAdjustment,
  insertAdjustment,
} from '../domain/adjustmentItems'
import { createColorAdjustEffect } from '../domain/effectStack'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { resetDocumentStoreForTest } from '../test/storeFixtures'
import AdjustmentDialog from './AdjustmentDialog'
import Inspector from './Inspector'
import AdjustmentView from './timeline/AdjustmentView'

function documentWithAdjustment(includeUnknown = false) {
  let document = createTimelineDoc('Adjustments', DEFAULT_PROJECT_SETTINGS, 'adjustments')
  const item = createAdjustmentItem(10, 30, 'Look pass')
  const effect = createColorAdjustEffect('existing-color')
  effect.params.exposure = 1
  item.effects = [effect]
  if (includeUnknown) {
    item.effects.push({
      id: 'future-effect',
      type: 'future.full-frame-effect',
      version: 7,
      enabled: true,
      params: { intent: 'keep' },
    })
  }
  document = insertAdjustment(document, 'V1', item)
  return { document, item }
}

beforeEach(() => {
  const document = createTimelineDoc('Empty', DEFAULT_PROJECT_SETTINGS, 'empty')
  resetDocumentStoreForTest(document)
  useTransportStore.getState().resetTransport()
})

describe('adjustment editor surfaces', () => {
  test('uses canonical integer-frame conversion for the default duration', () => {
    const doc = createTimelineDoc('NTSC', {
      ...DEFAULT_PROJECT_SETTINGS,
      frameRate: { num: 30_000, den: 1_001 },
    }, 'ntsc')
    resetDocumentStoreForTest(doc)

    render(<AdjustmentDialog onClose={vi.fn()} />)

    expect(screen.getByRole('spinbutton', { name: 'Duration (frames)' }))
      .toHaveValue(150)
  })

  test('adds an explicit adjustment item and selects it without fake media', () => {
    const onClose = vi.fn()
    render(<AdjustmentDialog onClose={onClose} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: '  Full frame look  ' },
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Start frame' }), {
      target: { value: '12' },
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Duration (frames)' }), {
      target: { value: '24' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add adjustment' }))

    const track = useDocumentStore.getState().doc.tracks.find((candidate) => candidate.id === 'V1')!
    expect(track.adjustments).toHaveLength(1)
    expect(track.adjustments?.[0]).toMatchObject({
      kind: 'adjustment',
      name: 'Full frame look',
      timelineRange: { startFrame: 12, durationFrames: 24 },
      effects: [],
    })
    expect(track.adjustments?.[0]).not.toHaveProperty('assetId')
    expect(track.adjustments?.[0]).not.toHaveProperty('sourceRange')
    expect(useTransportStore.getState().selectedAdjustmentId)
      .toBe(track.adjustments?.[0]?.id)
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('edits opacity/effects and exposes a portable unknown effect as bypassed', () => {
    const { document, item } = documentWithAdjustment(true)
    resetDocumentStoreForTest(document)
    useTransportStore.getState().setPlayheadFrame(20)
    useTransportStore.getState().setSelectedAdjustment(item.id)
    render(<Inspector />)

    expect(screen.getByTestId('adjustment-inspector')).toBeInTheDocument()
    expect(screen.getByText('future.full-frame-effect')).toBeInTheDocument()
    expect(screen.getByText(/not installed; its data is preserved/i)).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('adjustment-opacity'), {
      target: { value: '50' },
    })
    fireEvent.blur(screen.getByTestId('adjustment-opacity'))
    expect(findAdjustment(useDocumentStore.getState().doc, item.id)?.opacity).toBe(0.5)

    fireEvent.click(screen.getByRole('button', { name: 'Add color' }))
    expect(findAdjustment(useDocumentStore.getState().doc, item.id)?.effects).toHaveLength(3)
    expect(useDocumentStore.getState().past).toHaveLength(2)
  })

  test('keyboard move and split each commit one history entry', () => {
    const { document, item } = documentWithAdjustment()
    resetDocumentStoreForTest(document)
    useTransportStore.getState().setPlayheadFrame(20)
    render(
      <AdjustmentView
        adjustment={item}
        trackId="V1"
        locked={false}
        timelineOriginFrame={0}
        timelineWindowEndFrame={100}
      />,
    )
    const view = screen.getByRole('button', { name: 'Look pass, adjustment layer' })

    fireEvent.keyDown(view, { key: 'ArrowRight' })
    expect(findAdjustment(useDocumentStore.getState().doc, item.id)?.timelineRange.startFrame)
      .toBe(11)
    expect(useDocumentStore.getState().past).toHaveLength(1)

    act(() => useTransportStore.getState().setPlayheadFrame(20))
    fireEvent.keyDown(view, { key: 's' })
    expect(useDocumentStore.getState().doc.tracks[0].adjustments).toHaveLength(2)
    expect(useDocumentStore.getState().past).toHaveLength(2)
  })
})
