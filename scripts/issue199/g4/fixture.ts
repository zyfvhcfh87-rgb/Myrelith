/** Pure mixed fixture. No encoder or browser work occurs here. */
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../../../src/domain/projectSettings'
import { sequenceProjectFromTimeline } from '../../../src/domain/projectSequences'
import { clipFromAssetRange, createTextClip } from '../../../src/domain/operations'
import { createColorAdjustEffect, createMaskEffect } from '../../../src/domain/effectStack'
import { proceduralTextAssetId } from '../../../src/domain/textOverlay'
import { upgradeLegacyTextTitle } from '../../../src/domain/titleUpgrade'
import { defaultTitleElement, planTitleEdit } from '../../../src/domain/titleEditing'
import type { ClipAnimationKeyframe, MediaAsset } from '../../../src/domain/schema'
const key = (frame: number, value: number, hold = false): ClipAnimationKeyframe => ({ frame, sourceTimeTicks: frame * 1_000_000, value, easing: { type: hold ? 'hold' : 'linear' } })
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
export function buildFixtureProject(video: MediaAsset, sound: MediaAsset) {
  const doc = structuredClone(createTimelineDoc('Animation mixed encoded G4', { ...DEFAULT_PROJECT_SETTINGS, width: 1280, height: 720 }, 'g4'))
  const clip = clipFromAssetRange(video, 0, 0, 60); clip.id = 'g4-video'
  const mask = createMaskEffect('g4-mask', 'bezier'), color = createColorAdjustEffect('g4-color')
  clip.effects = [mask, color, { id: 'g4-future', type: 'plugin:missing/future', version: 99, enabled: false, params: { literal: 'preserve me' } }]
  clip.animation = { tracks: [
    { property: 'position-x', keyframes: [key(0, -20), key(59, 20)] },
    { property: 'crop-left', keyframes: [key(0, 0), key(59, 0.1)] },
  ], effectTracks: [{ effectId: color.id, parameter: 'exposure', keyframes: [key(0, 0), key(30, 0.4), key(59, 0.8)] }],
  effectPathTracks: [{ effectId: mask.id, parameter: 'path', valueType: 'mask-bezier-path', valueVersion: 1, keyframes: [
    { frame: 0, sourceTimeTicks: 0, value: 'M 0 0 C 0.3 0 0.7 0 1 0 C 1 0.3 1 0.7 1 1 C 0.7 1 0.3 1 0 1 C 0 0.7 0 0.3 0 0 Z', easing: { type: 'hold' } },
    { frame: 30, sourceTimeTicks: 30_000_000, value: 'M 0.1 0 C 0.4 0 0.7 0 1 0 C 1 0.3 1 0.7 1 1 C 0.7 1 0.4 1 0.1 1 C 0.1 0.7 0.1 0.3 0.1 0 Z', easing: { type: 'hold' } },
  ] }] }
  doc.tracks.find((t) => t.kind === 'video')!.clips = [clip]
  const audio = clipFromAssetRange(sound, 0, 0, 30); audio.id = 'g4-audio'
  audio.animation = { tracks: [{ property: 'volume', keyframes: [key(0, 0.25, true), key(15, 0.75, true)] }, { property: 'balance', keyframes: [key(0, -1, true), key(15, 1, true)] }] }
  doc.tracks.find((t) => t.kind === 'audio')!.clips = [audio]
  const text = createTextClip(doc, 0, 30, 'MOVE'); text.id = 'g4-title'; text.assetId = proceduralTextAssetId(text.id)
  doc.tracks.unshift({ ...doc.tracks.find((t) => t.kind === 'video')!, id: 'g4-title-track', name: 'Title', clips: [text] })
  const upgraded = upgradeLegacyTextTitle(sequenceProjectFromTimeline(doc), 'g4', 'g4-title', () => 'g4-words'); check(upgraded.ok, 'Title upgrade failed')
  let project = planTitleEdit(upgraded.project, { sequenceId: 'g4', clipId: 'g4-title' }, { kind: 'patch', ids: ['g4-words'], patch: { font: { family: 'G4 Missing Named Font', fallbackFamily: 'serif' }, text: { content: 'MOVE', fontSizePx: 72, color: '#ffffff' } } }, () => 'g4-unused')
  const rectangle = defaultTitleElement('rectangle', 'g4-shape', doc)
  const root = project.sequences[0], title = root.tracks[0].clips[0]
  check(title.title?.version === 1 && 'elements' in title.title, 'Expanded title missing')
  const shape = { ...rectangle, transform: { ...rectangle.transform, x: -300, y: -160 }, ...(rectangle.kind === 'rectangle' ? { shape: { ...rectangle.shape, boxWidthPx: 90, boxHeightPx: 40, fillColor: '#00b080' } } : {}) }
  project = { ...project, sequences: [{ ...root, tracks: root.tracks.map((t, i) => i ? t : { ...t, clips: [{ ...title, title: { version: 1, elements: [...title.title!.elements as object[], shape] }, animation: { ...title.animation!, titleTracks: [{ elementId: 'g4-shape', property: 'position-y', propertyVersion: 1, keyframes: [key(0, -160), key(29, -100)] }] } }] }) }] }
  project = planTitleEdit(project, { sequenceId: 'g4', clipId: 'g4-title' }, { kind: 'motion', ids: ['g4-words'], direction: 'left', start: 0, end: 29, replace: false }, () => 'g4-unused')
  return project
}
