import { describe, expect, test } from 'vitest'
import type { TimelineDoc } from '../domain/schema'
import { createParametricEqEffect } from '../domain/audioEffectStack'
import {
  exportAudioEffectCapabilities,
  playbackAudioEffectCapabilities,
  projectAudioEffectStatuses,
} from './audioEffectStatus'

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 20,
    id: 'doc-audio-status',
    name: 'Audio status',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'A1',
      kind: 'audio',
      name: 'A1',
      clips: [{
        id: 'clipA',
        assetId: 'asset-1',
        name: 'clipA',
        sourceMode: 'timed',
        sourceRange: { startFrame: 0, durationFrames: 10 },
        timelineRange: { startFrame: 0, durationFrames: 10 },
        transform: {
          x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5,
        },
        opacity: 1,
        volume: 1,
        effects: [],
        audioEffects: [createParametricEqEffect('afx-clip')],
      }],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
      audioEffects: [{
        id: 'afx-unknown',
        type: 'future.exciter',
        version: 1,
        enabled: true,
        params: { sparkle: 1 },
      }],
    }],
    masterAudio: {
      volume: 1,
      balance: 0,
      muted: false,
      audioEffects: [createParametricEqEffect('afx-master')],
    },
  }
}

describe('audio-effect status projection', () => {
  test('advertises live DSP only when the AudioContext host can provide it', () => {
    const supported = playbackAudioEffectCapabilities({
      createScriptProcessor() {},
    })
    expect([...supported]).toEqual([...exportAudioEffectCapabilities()])
    expect(playbackAudioEffectCapabilities(undefined).has('js-stereo-block')).toBe(false)
  })

  test('projects clip, track, and master statuses without evaluating in the Inspector', () => {
    const statuses = projectAudioEffectStatuses(
      makeDoc(),
      exportAudioEffectCapabilities(),
    )
    expect(statuses.get('afx-clip')?.playback.status).toBe('ready')
    expect(statuses.get('afx-clip')?.export.status).toBe('ready')
    expect(statuses.get('afx-master')?.playback.status).toBe('ready')
    expect(statuses.get('afx-master')?.export.status).toBe('ready')
    expect(statuses.get('afx-unknown')?.playback.status).toBe('unsupported')
    expect(statuses.get('afx-unknown')?.export.status).toBe('unsupported')
    expect(statuses.get('afx-unknown')?.export.detail).toContain('preserved')
  })

  test('keeps offline clip DSP ready when live bus DSP is unavailable', () => {
    const statuses = projectAudioEffectStatuses(makeDoc(), new Set())
    expect(statuses.get('afx-clip')?.playback.status).toBe('ready')
    expect(statuses.get('afx-clip')?.export.status).toBe('ready')
    expect(statuses.get('afx-master')?.playback.status).toBe('unsupported')
    expect(statuses.get('afx-master')?.export.status).toBe('ready')
  })
})
