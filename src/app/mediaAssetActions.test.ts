import { describe, expect, test } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'
import type { Clip } from '../domain/schema'
import {
  mediaAssetIsUsedOnTimeline,
  mediaAssetRemovalDisabledReason,
} from './mediaAssetActions'

describe('project-wide media asset usage', () => {
  test('protects an asset referenced only by a dormant sequence', () => {
    const root = createTimelineDoc('Root', DEFAULT_PROJECT_SETTINGS, 'root')
    const dormant = JSON.parse(JSON.stringify(createTimelineDoc(
      'Dormant',
      DEFAULT_PROJECT_SETTINGS,
      'dormant',
    ))) as ReturnType<typeof createTimelineDoc>
    dormant.tracks[0].clips = [{
      assetId: 'asset-dormant',
    } as Clip]
    const project = {
      ...sequenceProjectFromTimeline(root),
      sequences: [root, dormant],
    }

    expect(mediaAssetIsUsedOnTimeline(project, 'asset-dormant')).toBe(true)
    expect(mediaAssetRemovalDisabledReason(project, 'asset-dormant'))
      .toMatch(/every sequence/i)
    expect(mediaAssetRemovalDisabledReason(project, 'unused')).toBeNull()
  })
})
