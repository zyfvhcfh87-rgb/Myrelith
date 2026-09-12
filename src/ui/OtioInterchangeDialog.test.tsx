import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  resetOtioInterchangeForTests,
  setOtioDownloadHandlerForTests,
} from '../app/otioInterchangeController'
import OtioInterchangeDialog from './OtioInterchangeDialog'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/otio')

function resetEditor(): void {
  resetOtioInterchangeForTests()
  useDocumentStore.getState().setProject(
    sequenceProjectFromTimeline(
      createTimelineDoc('Untitled', DEFAULT_PROJECT_SETTINGS, 'doc_default'),
    ),
  )
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
    collections: [],
    collectionPast: [],
    collectionFuture: [],
  })
}

describe('OtioInterchangeDialog', () => {
  beforeEach(() => {
    resetEditor()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    resetEditor()
    vi.restoreAllMocks()
  })

  test('reviews an official fixture then commits offline media in one edit', async () => {
    const onClose = vi.fn()
    const { container } = render(<OtioInterchangeDialog onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: 'OTIO interchange' })).toBeInTheDocument()

    const text = readFileSync(join(fixturesDir, 'simple_cut.otio'), 'utf8')
    const input = container.querySelector('input[type="file"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    await act(async () => {
      fireEvent.change(input as HTMLInputElement, {
        target: { files: [new File([text], 'simple_cut.otio', { type: 'application/json' })] },
      })
    })

    expect(await screen.findByText(/4 clips/)).toBeInTheDocument()
    expect(screen.getByText(/titles\.mov/)).toBeInTheDocument()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Import into project' }))
    })

    await waitFor(() => {
      expect(useDocumentStore.getState().project.sequences).toHaveLength(2)
    })
    expect(
      [...useMediaStore.getState().descriptors.values()].some(
        (item) => item.fileName === 'titles.mov',
      ),
    ).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('reviews export losses before downloading JSON', () => {
    const downloads: string[] = []
    setOtioDownloadHandlerForTests((_name, _type, content) => {
      downloads.push(content)
    })
    render(<OtioInterchangeDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review OTIO export' }))
    expect(screen.getByRole('region', { name: 'OTIO export preview' })).toBeInTheDocument()
    expect(downloads).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Download .otio' }))
    expect(downloads).toHaveLength(1)
    expect(downloads[0]).toContain('"OTIO_SCHEMA": "Timeline.1"')
  })
})
