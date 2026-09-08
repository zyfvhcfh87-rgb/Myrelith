import { expect, test } from 'vitest'
import { buildFixtureProject } from '../../scripts/issue199/g4/fixture'
import { ATTRIBUTE_ASSET_DESCRIPTOR } from './clipAttributeFixtures'
import type { MediaAsset } from '../domain/schema'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from '../domain/projectFile'
import { retimeClip, splitClipAtFrame } from '../domain/operations'
import { resolveTitleElementAnimation } from '../domain/animationPropertyCatalog'
import { readTitleClipElement } from '../domain/titleOwnership'
import { titleElementBounds } from '../domain/titleEditing'
import { createVideoCompositionPlanner } from '../domain/videoCompositionPlan'
import { createSourceBoundsCatalog } from '../domain/crossfadePlan'

const video: MediaAsset = { ...ATTRIBUTE_ASSET_DESCRIPTOR, width: 1280, height: 720, durationMicroseconds: 2_000_000, objectUrl: 'blob:g4-unit', durationFrames: 60, frameRate: { num: 30, den: 1 }, decoderConfigB64: null }
const audio: MediaAsset = { ...video, id: 'audio', kind: 'audio', fileName: 'g4-oracle.wav', mimeType: 'audio/wav', durationFrames: 30, durationMicroseconds: 1_000_000, width: null, height: null, hasAudio: true, audioChannels: 2, audioSampleRate: 48000, frameRate: null, sourceBounds: { video: null, audio: { status: 'unknown' } } }

test('the pure G4 fixture admits through the portable boundary and preserves retimed split source keys', () => {
  const project = buildFixtureProject(video, audio)
  const retimed = retimeClip(project.sequences[0], 'g4-video', { numerator: 2, denominator: 1 })
  expect(retimed).not.toBe(project.sequences[0])
  const split = splitClipAtFrame(retimed, 'g4-video', 15)
  expect(split).not.toBe(retimed)
  const clips = split.tracks.flatMap((t) => t.clips).filter((c) => c.assetId === video.id)
  expect(clips.map((c) => c.timelineRange)).toEqual([{ startFrame: 0, durationFrames: 15 }, { startFrame: 15, durationFrames: 15 }])
  const snapshot = createProjectFileSnapshot({ ...project, sequences: [split] }, [ATTRIBUTE_ASSET_DESCRIPTOR, { ...ATTRIBUTE_ASSET_DESCRIPTOR, id: 'audio', fileName: audio.fileName, kind: 'audio', mimeType: audio.mimeType, hasAudio: true, audioChannels: 2, audioSampleRate: 48000, sourceBounds: audio.sourceBounds, width: null, height: null, nativeFrameRate: null }])
  const reopened = parseProjectFile(serializeProjectFile(snapshot))
  expect(reopened.sequences[0].tracks.flatMap((t) => t.clips).filter((c) => c.assetId === video.id).map((c) => c.animation)).toEqual(clips.map((c) => c.animation))
  expect(clips.every((c) => c.effects.some((e) => e.params.literal === 'preserve me'))).toBe(true)
})

test('generated crawl is outside both boundary frames and moves left at interior samples with literal fallback intent', () => {
  const project = buildFixtureProject(video, audio), doc = project.sequences[0]
  const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === 'g4-title')!, text = readTitleClipElement(clip, 'g4-words')!
  expect(text.kind).toBe('text'); if (text.kind !== 'text') return
  expect(text.font).toEqual({ family: 'G4 Missing Named Font', fallbackFamily: 'serif' })
  const bounds = (frame: number) => titleElementBounds(resolveTitleElementAnimation(text, clip.animation!.titleTracks!, frame).element, doc)
  expect(bounds(0).left).toBeGreaterThan(1280)
  expect(bounds(29).right).toBeLessThan(0)
  expect(bounds(7).left - bounds(22).left).toBeGreaterThan(100)
  for (const frame of [14, 15]) {
    expect(bounds(frame).left).toBeGreaterThan(0); expect(bounds(frame).right).toBeLessThan(1280)
    expect(bounds(frame).top).toBeGreaterThan(0); expect(bounds(frame).bottom).toBeLessThan(720)
  }
  expect(clip.animation!.titleTracks!.find((t) => t.elementId === 'g4-shape')?.property).toBe('position-y')
})

test('the actual composition plan paints the title after opaque media at every G4 frame', () => {
  const project = buildFixtureProject(video, audio)
  const doc = splitClipAtFrame(retimeClip(project.sequences[0], 'g4-video', { numerator: 2, denominator: 1 }), 'g4-video', 15)
  const planner = createVideoCompositionPlanner(doc, createSourceBoundsCatalog([]))
  for (const frame of [0, 7, 14, 15, 22, 29]) {
    const items = planner.planFrame(frame).items
    const titleIndex = items.findIndex((item) => item.kind === 'title' && item.clip.id === 'g4-title')
    const mediaIndex = items.findIndex((item) => item.kind === 'clip' && item.request.clip.assetId === video.id)
    expect(mediaIndex).toBeGreaterThanOrEqual(0)
    expect(titleIndex).toBeGreaterThan(mediaIndex)
  }
})

import { PcmCoverage } from '../../scripts/issue199/g4/pcmCoverage'
test('PCM coverage detects an interior gap even when the last buffer reaches sample 48000', () => {
  const coverage = new PcmCoverage(), plane = (size: number) => [new Float32Array(size), new Float32Array(size)]
  coverage.add(0, 48000, plane(10000)); coverage.add(11000 / 48000, 48000, plane(37000))
  expect(coverage.snapshot().coveredSamples).toBe(47000)
  expect(() => coverage.finish()).toThrow(/gaps/)
})
test('PCM coverage accepts contiguous finite buffers and bounds overlaps, padding and nonfinite samples', () => {
  const plane = (size: number) => [new Float32Array(size), new Float32Array(size)], complete = new PcmCoverage()
  complete.add(0, 48000, plane(24000)); complete.add(0.5, 48000, plane(24000)); expect(complete.finish().coveredSamples).toBe(48000)
  expect(() => complete.add(0.5, 48000, plane(24000))).toThrow(/overlaps/)
  expect(() => new PcmCoverage().add(-1, 48000, plane(24000))).toThrow(/padding/)
  expect(() => new PcmCoverage().add(0, 48000, [new Float32Array([NaN]), new Float32Array(1)])).toThrow(/Nonfinite/)
})
