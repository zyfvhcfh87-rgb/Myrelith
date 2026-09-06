import { expect, test } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import { sequenceProjectFromTimeline } from './projectSequences'
import { createProjectFileSnapshot, serializeProjectFile, parseProjectFile, validateProjectFile } from './projectFile'
import { createColorAdjustEffect, createMaskEffect } from './effectStack'

function fixture() {
  const doc = structuredClone(createTimelineDoc('Video buses', DEFAULT_PROJECT_SETTINGS, 'root'))
  doc.masterVideoEffects = [createColorAdjustEffect('master'), { id: 'future-bus', type: 'future.effect', version: 19, enabled: true, params: { intent: 'retain' } }]
  doc.tracks[0].videoEffects = [createColorAdjustEffect('track'), createMaskEffect('preserved-source-only', 'rectangle')]
  return createProjectFileSnapshot(sequenceProjectFromTimeline(doc), [])
}
test('video buses roundtrip unknown/wrong-stage intent, and schema 20 migrates to explicit empty stacks', () => {
  const project = fixture(), roundtrip = parseProjectFile(serializeProjectFile(project))
  expect(roundtrip).toEqual(project)
  expect(roundtrip.formatVersion).toBe(7)
  const old = structuredClone(project)
  for (const sequence of old.sequences) {
    sequence.schemaVersion = 20
    delete sequence.masterVideoEffects
    for (const track of sequence.tracks) delete track.videoEffects
  }
  const migrated = parseProjectFile(JSON.stringify(old))
  expect(migrated.sequences[0].schemaVersion).toBe(21)
  expect(migrated.sequences[0].masterVideoEffects).toEqual([])
  expect(migrated.sequences[0].tracks.every((track) => track.videoEffects?.length === 0)).toBe(true)
})
test('current schema requires explicit bus arrays and rejects global collisions including dormant sequences', () => {
  const project = fixture(), missing = structuredClone(project)
  delete missing.sequences[0].masterVideoEffects
  expect(() => validateProjectFile(missing)).toThrow(/masterVideoEffects/)
  const collision = structuredClone(project)
  collision.sequences[0].tracks[0].videoEffects![0].id = 'master'
  expect(() => validateProjectFile(collision)).toThrow(/duplicate.*effect/i)
  const dormantCollision = structuredClone(project)
  const dormant = structuredClone(createTimelineDoc('Dormant', DEFAULT_PROJECT_SETTINGS, 'dormant'))
  dormant.tracks.forEach((track) => { track.id = `dormant-${track.id}` })
  dormant.masterVideoEffects = [createColorAdjustEffect('master')]
  dormantCollision.sequences.push(dormant)
  expect(() => validateProjectFile(dormantCollision)).toThrow(/duplicate.*effect/i)
  const audio = project.sequences[0].tracks.find((track) => track.kind === 'audio')!
  audio.videoEffects = [createColorAdjustEffect('audio-bus-forbidden')]
  expect(() => validateProjectFile(project)).toThrow(/requires a video track/)
})
