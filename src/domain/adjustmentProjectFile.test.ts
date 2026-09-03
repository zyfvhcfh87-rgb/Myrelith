import { describe, expect, test } from 'vitest'
import { createAdjustmentItem, insertAdjustment } from './adjustmentItems'
import { createColorAdjustEffect, createMaskEffect } from './effectStack'
import {
  createProjectFileSnapshot,
  parseProjectFile,
  serializeProjectFile,
} from './projectFile'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'

describe('adjustment project-file schema 15', () => {
  test('migrates schema 14 through current with empty adjustments and unchanged content', () => {
    const document = structuredClone(createTimelineDoc(
      'Legacy adjustment migration',
      DEFAULT_PROJECT_SETTINGS,
      'legacy-adjustment-document',
    ))
    const current = createProjectFileSnapshot(document, [])
    const legacy = structuredClone(current) as unknown as {
      sequences: Array<{
        schemaVersion: number
        tracks: Array<Record<string, unknown>>
      }>
    }
    legacy.sequences[0]!.schemaVersion = 14
    for (const track of legacy.sequences[0]!.tracks) delete track.adjustments

    const parsed = parseProjectFile(JSON.stringify(legacy))
    expect(parsed.sequences[0].schemaVersion).toBe(18)
    expect(parsed.sequences[0].tracks.every((track) => track.adjustments?.length === 0))
      .toBe(true)
    expect(parsed.sequences[0].name).toBe(document.name)
    expect(parsed.sequences[0].tracks.map((track) => track.clips)).toEqual(
      document.tracks.map((track) => track.clips),
    )
  })

  test('round-trips animation and preserved unsupported source/future effects exactly', () => {
    let document = structuredClone(createTimelineDoc(
      'Portable adjustments',
      DEFAULT_PROJECT_SETTINGS,
      'portable-adjustment-document',
    ))
    const item = createAdjustmentItem(12, 24, 'Look pass')
    item.opacity = 0.75
    item.animation = {
      tracks: [{
        property: 'opacity',
        keyframes: [
          { frame: 0, value: 0.25, easing: { type: 'linear' } },
          { frame: 12, value: 1, easing: { type: 'hold' } },
        ],
      }],
      effectTracks: [],
    }
    item.effects = [
      createColorAdjustEffect('fx-color'),
      createMaskEffect('fx-preserved-source-mask', 'ellipse'),
      {
        id: 'fx-future',
        type: 'future.look',
        version: 9,
        enabled: true,
        params: { mode: 'new' },
      },
    ]
    document = insertAdjustment(document, 'V1', item)
    const project = createProjectFileSnapshot(document, [])
    const parsed = parseProjectFile(serializeProjectFile(project))

    expect(parsed.sequences[0].tracks[0]!.adjustments).toEqual([item])
    expect(serializeProjectFile(parsed)).toBe(serializeProjectFile(project))
  })

  test('rejects adjustment media/source fields and audio-track placement', () => {
    const document = structuredClone(createTimelineDoc(
      'Invalid adjustments',
      DEFAULT_PROJECT_SETTINGS,
      'invalid-adjustment-document',
    ))
    const item = createAdjustmentItem(0, 10)
    document.tracks[4]!.adjustments = [{
      ...item,
      assetId: 'fake-media',
    } as never]
    const project = {
      ...createProjectFileSnapshot(
        { ...document, tracks: document.tracks.map((track, index) => (
          index === 4 ? { ...track, adjustments: [] } : track
        )) },
        [],
      ),
      sequences: [document],
    }

    expect(() => serializeProjectFile(project)).toThrow(/assetId: unknown field|video track/i)
  })
})
