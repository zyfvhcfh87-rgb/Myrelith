import type { Clip } from '../domain/schema'
import { defaultClipAudioSettings, defaultClipTransform, defaultClipVisualSettings } from '../domain/clipInspector'
import { defaultClipAnimation } from '../domain/clipAnimation'
import { createColorAdjustEffect } from '../domain/effectStack'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'
import { defaultSourceTimeMap } from '../domain/sourceTimeMap'

export function attributeClip(id: string, startFrame = 0): Clip {
  return {
    id, name: id, assetId: 'asset', sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 60 },
    sourceTimeMap: defaultSourceTimeMap(0, 60),
    timelineRange: { startFrame, durationFrames: 60 },
    transform: defaultClipTransform(), visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(), opacity: 1, volume: 1,
    blendMode: 'normal', animation: defaultClipAnimation(), effects: [],
  }
}

export function attributeProject() {
  const doc = structuredClone(createTimelineDoc('Attributes', DEFAULT_PROJECT_SETTINGS, 'attributes'))
  const source = attributeClip('source')
  source.effects = [createColorAdjustEffect('color'), {
    id: 'future', type: 'future.effect', version: 17, enabled: false, params: { intent: 'keep' },
  }]
  source.effects[0].params = { exposure: 1, contrast: 0, saturation: 0 }
  source.transform.x = 123
  source.animation = {
    tracks: [{ property: 'position-x', keyframes: [
      { frame: 0, sourceTimeTicks: 0, value: 123, easing: { type: 'linear' } },
      { frame: 75, sourceTimeTicks: 75_000_000, value: 223, easing: { type: 'hold' } },
    ] }],
    effectTracks: ['color', 'future', 'orphan'].map((effectId) => ({
      effectId, parameter: 'exposure', keyframes: [
        { frame: 5, sourceTimeTicks: 5_000_000, value: 1, easing: { type: 'linear' } },
      ],
    })),
  }
  doc.tracks[0].clips = [source, attributeClip('first', 100), attributeClip('second', 200)]
  return sequenceProjectFromTimeline(doc)
}
