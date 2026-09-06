import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import type { SequenceInstance, TimelineDoc, Track } from '../../domain/schema'
import type { SequenceProject } from '../../domain/projectSequences'
import { useDocumentStore } from '../../state/documentStore'
import { useSequenceInstanceSelectionStore } from '../../state/sequenceInstanceSelectionStore'
import { useTransportStore } from '../../state/transportStore'
import SequenceInstanceView from './SequenceInstanceView'

const instance: SequenceInstance = {
  kind: 'sequence',
  id: 'scene-instance',
  name: 'Opening scene',
  sequenceId: 'child',
  sourceStartFrame: 2,
  timelineRange: { startFrame: 10, durationFrames: 20 },
}

function sequence(id: string, tracks: Track[] = []): TimelineDoc {
  return {
    schemaVersion: 21,
    id,
    name: id,
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks,
    markers: [],
    captionTracks: [],
  }
}

describe('SequenceInstanceView', () => {
  beforeEach(() => {
    const root = sequence('root', [{
      id: 'V1',
      kind: 'video',
      name: 'V1',
      clips: [],
      sequenceInstances: [instance],
      adjustments: [],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }])
    const project: SequenceProject = {
      id: 'project',
      name: 'Project',
      rootSequenceId: 'root',
      sequences: [root, sequence('child')],
    }
    useDocumentStore.getState().setProject(project)
    useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(null)
    useTransportStore.getState().resetTransport()
  })

  test('selects the portable item and opens its central definition on double click', () => {
    render(
      <SequenceInstanceView
        instance={instance}
        trackId="V1"
        trackKind="video"
        timelineOriginFrame={0}
        timelineWindowEndFrame={100}
      />,
    )
    const item = screen.getByRole('button', { name: 'Compound Opening scene' })

    fireEvent.click(item)
    expect(useSequenceInstanceSelectionStore.getState().selectedInstanceId)
      .toBe('scene-instance')

    useTransportStore.getState().setPlayheadFrame(15)
    fireEvent.doubleClick(item)
    expect(useDocumentStore.getState().activeSequenceId).toBe('child')
    expect(useTransportStore.getState().playheadFrame).toBe(7)
    expect(useDocumentStore.getState().sequenceNavigation).toEqual([{
      sequenceId: 'root',
      playheadFrame: 15,
    }])
  })
})
