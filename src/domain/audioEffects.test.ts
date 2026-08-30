import { describe, expect, test, vi } from 'vitest'
import type { AudioEffectDescriptor, Clip, TimelineDoc, Track } from './schema'
import {
  addAudioEffect,
  applyAudioEffectPreset,
  normalizeMasterLoudness,
  removeAudioEffect,
  reorderAudioEffect,
  resetAudioEffect,
  setAudioEffectEnabled,
  setMasterAudio,
  splitClipAtFrame,
  updateAudioEffectParams,
} from './operations'
import {
  AUDIO_EFFECT_STACK_LIMITS,
} from './audioEffectBounds'
import {
  createCompressorEffect,
  createParametricEqEffect,
  DEFAULT_EQ_PARAMS,
} from './audioEffectStack'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

function makeClip(id: string): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 80 },
    timelineRange: { startFrame: 0, durationFrames: 80 },
    transform: {
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
    audioEffects: [],
  }
}

function makeTrack(id: string, kind: Track['kind'], clips: Clip[], locked = false): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked,
    volume: 1,
    balance: 0,
    audioEffects: [],
  }
}

function makeDoc(): TimelineDoc {
  return deepFreeze({
    schemaVersion: 17,
    id: 'doc-audio-fx',
    name: 'Audio effects',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [
      makeTrack('V1', 'video', [makeClip('clipV')]),
      makeTrack('A1', 'audio', [makeClip('clipA')]),
      makeTrack('AL', 'audio', [makeClip('clipLocked')], true),
    ],
    masterAudio: { volume: 1, balance: 0, muted: false, audioEffects: [] },
  })
}

describe('audio-effect stack operations', () => {
  test('adds, bypasses, patches, reorders, resets, and removes on clip, track, and master', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clipEq = createParametricEqEffect('afx-clip')
    const trackEq = createParametricEqEffect('afx-track')
    const masterComp = createCompressorEffect('afx-master')
    let doc = makeDoc()

    doc = addAudioEffect(doc, { kind: 'clip', clipId: 'clipA' }, clipEq)
    doc = addAudioEffect(doc, { kind: 'track', trackId: 'A1' }, trackEq)
    doc = addAudioEffect(doc, { kind: 'master' }, masterComp)

    expect(doc.tracks[1].clips[0].audioEffects?.map((item) => item.id)).toEqual(['afx-clip'])
    expect(doc.tracks[1].audioEffects?.map((item) => item.id)).toEqual(['afx-track'])
    expect(doc.masterAudio?.audioEffects?.map((item) => item.id)).toEqual(['afx-master'])
    expect(doc.tracks[1].clips[0].audioEffects?.[0]).not.toBe(clipEq)

    doc = setAudioEffectEnabled(doc, { kind: 'clip', clipId: 'clipA' }, 'afx-clip', false)
    expect(doc.tracks[1].clips[0].audioEffects?.[0].enabled).toBe(false)

    doc = updateAudioEffectParams(
      doc,
      { kind: 'track', trackId: 'A1' },
      'afx-track',
      { band2Gain: 3 },
    )
    expect(doc.tracks[1].audioEffects?.[0].params.band2Gain).toBe(3)

    const second = createParametricEqEffect('afx-master-2')
    doc = addAudioEffect(doc, { kind: 'master' }, second)
    doc = reorderAudioEffect(doc, { kind: 'master' }, 'afx-master-2', 0)
    expect(doc.masterAudio?.audioEffects?.map((item) => item.id)).toEqual([
      'afx-master-2',
      'afx-master',
    ])

    doc = resetAudioEffect(doc, { kind: 'track', trackId: 'A1' }, 'afx-track')
    expect(doc.tracks[1].audioEffects?.[0].params).toEqual({ ...DEFAULT_EQ_PARAMS })

    doc = removeAudioEffect(doc, { kind: 'clip', clipId: 'clipA' }, 'afx-clip')
    expect(doc.tracks[1].clips[0].audioEffects).toEqual([])
    warn.mockRestore()
  })

  test('rejects locked tracks, duplicate ids, invalid params, and unknown reset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = makeDoc()
    const effect = createParametricEqEffect('afx-1')
    expect(addAudioEffect(doc, { kind: 'clip', clipId: 'clipLocked' }, effect)).toBe(doc)
    expect(addAudioEffect(doc, { kind: 'track', trackId: 'AL' }, effect)).toBe(doc)

    const withFx = deepFreeze(addAudioEffect(doc, { kind: 'clip', clipId: 'clipA' }, effect))
    expect(addAudioEffect(withFx, { kind: 'master' }, createParametricEqEffect('afx-1'))).toBe(withFx)
    expect(updateAudioEffectParams(
      withFx,
      { kind: 'clip', clipId: 'clipA' },
      'afx-1',
      { band1Gain: 99 },
    )).toBe(withFx)

    const unknown: AudioEffectDescriptor = {
      id: 'afx-opaque',
      type: 'future.widen',
      version: 1,
      enabled: true,
      params: { width: 1 },
    }
    const withUnknown = deepFreeze(addAudioEffect(doc, { kind: 'master' }, unknown))
    expect(resetAudioEffect(withUnknown, { kind: 'master' }, 'afx-opaque')).toBe(withUnknown)
    expect(reorderAudioEffect(withUnknown, { kind: 'master' }, 'afx-opaque', 4)).toBe(withUnknown)
    warn.mockRestore()
  })

  test('rejects an add after the exact per-stack limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let doc = makeDoc()
    for (let index = 0; index < AUDIO_EFFECT_STACK_LIMITS.maxEffectsPerStack; index++) {
      doc = addAudioEffect(
        doc,
        { kind: 'master' },
        createParametricEqEffect(`afx-limit-${index}`),
      )
    }
    const full = deepFreeze(doc)
    expect(full.masterAudio?.audioEffects).toHaveLength(
      AUDIO_EFFECT_STACK_LIMITS.maxEffectsPerStack,
    )
    expect(addAudioEffect(
      full,
      { kind: 'master' },
      createParametricEqEffect('over-limit'),
    )).toBe(full)
    warn.mockRestore()
  })

  test('split remints clip audio-effect ids on the right half', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const withFx = addAudioEffect(
      makeDoc(),
      { kind: 'clip', clipId: 'clipA' },
      createParametricEqEffect('afx-clip'),
    )
    const split = splitClipAtFrame(withFx, 'clipA', 40)
    const [left, right] = split.tracks[1].clips
    expect(left.audioEffects?.[0].id).toBe('afx-clip')
    expect(right.audioEffects?.[0].id).not.toBe('afx-clip')
    expect(right.audioEffects?.[0].params).toEqual(left.audioEffects?.[0].params)
    warn.mockRestore()
  })

  test('Voice preset replaces the stack and remints ids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const uuid = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-0000000000e1')
      .mockReturnValueOnce('00000000-0000-4000-8000-0000000000e2')
      .mockReturnValueOnce('00000000-0000-4000-8000-0000000000e3')
    const seeded = addAudioEffect(
      makeDoc(),
      { kind: 'master' },
      createParametricEqEffect('old'),
    )
    const next = applyAudioEffectPreset(seeded, { kind: 'master' }, 'voice')
    expect(next.masterAudio?.audioEffects?.map((item) => item.type)).toEqual([
      'builtin.eq',
      'builtin.compressor',
      'builtin.limiter',
    ])
    expect(next.masterAudio?.audioEffects?.map((item) => item.id)).toEqual([
      'afx_00000000-0000-4000-8000-0000000000e1',
      'afx_00000000-0000-4000-8000-0000000000e2',
      'afx_00000000-0000-4000-8000-0000000000e3',
    ])
    expect(applyAudioEffectPreset(seeded, { kind: 'master' }, 'missing')).toBe(seeded)
    uuid.mockRestore()
    warn.mockRestore()
  })

  test('normalizeMasterLoudness writes an ordinary master volume', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const withFx = addAudioEffect(
      makeDoc(),
      { kind: 'master' },
      createCompressorEffect('afx-master'),
    )
    const next = normalizeMasterLoudness(withFx, -22, -16)
    expect(next.masterAudio?.volume).toBeCloseTo(10 ** (6 / 20), 5)
    expect(next.masterAudio?.audioEffects?.map((item) => item.id)).toEqual(['afx-master'])
    warn.mockRestore()
  })

  test('mixer edits keep authored audio-effect stacks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const withFx = addAudioEffect(
      makeDoc(),
      { kind: 'master' },
      createCompressorEffect('afx-master'),
    )
    const next = setMasterAudio(withFx, { volume: 0.5 })
    expect(next.masterAudio?.audioEffects?.map((item) => item.id)).toEqual(['afx-master'])
    expect(next.masterAudio?.volume).toBe(0.5)
    warn.mockRestore()
  })
})
