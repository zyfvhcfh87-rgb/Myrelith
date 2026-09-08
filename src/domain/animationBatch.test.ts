import { describe, expect, test } from 'vitest'
import { foundationProject, scalarKey, pathTrack, animationCatalog, PLUGIN_ANIMATION_EFFECT_TYPE } from '../test/animationFoundationFixtures'
import { attributeClip } from '../test/clipAttributeFixtures'
import { animationOwnerIndex, animationLaneAddress, type AnimationEditContext } from './animationOwners'
import { animationOwnerKey, animationSelectionError, type AnimationKeyAddress, type AnimationLaneAddress } from './animationAddresses'
import { planAnimationBatch, planAnimationInsertions, planSetAnimationKey } from './animationBatch'
import { copyAnimationKeys, planAnimationPaste } from './animationClipboard'
import { createAdjustmentItem } from './adjustmentItems'
import { resolveClipAnimationAtFrame } from './clipAnimation'
import { defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { defaultTextProps } from './textOverlay'
import { createMaskEffect } from './effectStack'
import { colorGradingRegistrations } from './colorGradingEffects'
import type { TitleTextElementV1 } from './titleElements'

function project() {
  const result = foundationProject()
  result.sequences[0].tracks[0].clips[0].animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, 0.2), scalarKey(10, 0.8)] }], effectTracks: [] }
  return result
}
const scalar = (id = 'clip', property = 'opacity', propertyVersion = 1): AnimationLaneAddress => ({ owner: { kind: 'clip', id }, kind: 'scalar', property, propertyVersion })
const key = (frame: number, lane = scalar()): AnimationKeyAddress => ({ lane, frame })
function copied(source = project(), selection = [key(0), key(10)], context: AnimationEditContext = {}) {
  const result = copyAnimationKeys(source.sequences[0], selection, context)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  return result.clipboard
}

describe('atomic animation commands', () => {
  test('removes selected source keys before collision checks, preserving selection order and exact source intent', () => {
    const source = project(), before = JSON.stringify(source)
    const result = planAnimationBatch(source, source.rootSequenceId, [key(10), key(0)], { kind: 'move', deltaFrames: 10 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selection).toEqual([key(20), key(10)])
    expect(result.focus).toEqual(key(20))
    expect(result.project.sequences[0].tracks[0].clips[0].animation!.tracks[0].keyframes).toEqual([scalarKey(10, 0.2), scalarKey(20, 0.8)])
    expect(JSON.stringify(source)).toBe(before)
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0)], { kind: 'move', deltaFrames: 10 })).toMatchObject({ ok: false, code: 'collision', project: source })
  })

  test('moving a compact old lane preserves absent collections and maps the actual focused key', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    delete clip.animation!.effectTracks
    const result = planAnimationBatch(source, source.rootSequenceId, [key(0), key(10)], { kind: 'move', deltaFrames: 20 }, {}, key(10))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.focus).toEqual(key(30))
    expect(result.project.sequences[0].tracks[0].clips[0].animation).toEqual({ tracks: [{ property: 'opacity', keyframes: [scalarKey(20, 0.2), scalarKey(30, 0.8)] }] })
  })

  test('duplicate never overwrites; zero move and identical value/easing edits are no-ops', () => {
    const source = project()
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0)], { kind: 'duplicate', deltaFrames: 0 })).toMatchObject({ ok: false, code: 'collision' })
    for (const command of [{ kind: 'move', deltaFrames: 0 }, { kind: 'set-value', value: 0.2 }, { kind: 'set-easing', easing: { type: 'linear' } }] as const) {
      expect(planAnimationBatch(source, source.rootSequenceId, [key(0)], command)).toMatchObject({ ok: true, changed: false, project: source })
    }
    const duplicate = planAnimationBatch(source, source.rootSequenceId, [key(0), key(10)], { kind: 'duplicate', deltaFrames: 20 })
    expect(duplicate.ok).toBe(true)
    if (duplicate.ok) expect(duplicate.project.sequences[0].tracks[0].clips[0].animation!.tracks[0].keyframes.map((key) => key.frame)).toEqual([0, 10, 20, 30])
  })

  test('deleting a final lane reveals the original fallback and focuses a surviving logical lane', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    clip.animation!.tracks.push({ property: 'position-x', keyframes: [scalarKey(4, 50)] })
    const result = planAnimationBatch(source, source.rootSequenceId, [key(0), key(10)], { kind: 'delete' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selection).toEqual([])
    expect(result.focus).toEqual(key(4, scalar('clip', 'position-x')))
    expect(resolveClipAnimationAtFrame(result.project.sequences[0].tracks[0].clips[0], 5).opacity).toBe(1)
  })

  test('one locked owner rejects mixed clip/adjustment changes; unlocked adjustment keys never acquire source ticks', () => {
    const source = project(), doc = source.sequences[0], item = createAdjustmentItem(100, 30)
    item.animation.tracks = [{ property: 'opacity', keyframes: [{ frame: 0, value: 0.5, easing: { type: 'linear' } }] }]
    doc.tracks[1].adjustments = [item]
    const adjustment: AnimationLaneAddress = { owner: { kind: 'adjustment', id: item.id }, kind: 'scalar', property: 'opacity', propertyVersion: 1 }
    doc.tracks[1].locked = true
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0), key(0, adjustment)], { kind: 'move', deltaFrames: 3 })).toMatchObject({ ok: false, code: 'locked', project: source })
    doc.tracks[1].locked = false
    const result = planAnimationBatch(source, source.rootSequenceId, [key(0), key(0, adjustment)], { kind: 'move', deltaFrames: 3 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.project.sequences[0].tracks[1].adjustments![0].animation.tracks[0].keyframes[0]).toEqual({ frame: 3, value: 0.5, easing: { type: 'linear' } })
  })

  test('unavailable title/path intent can move intact but cannot receive numeric values or easing', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    clip.animation!.titleTracks = [{ elementId: 'missing', property: 'future', propertyVersion: 8, keyframes: [scalarKey(0, 8)] }]
    clip.animation!.effectPathTracks = [{ ...pathTrack(), valueVersion: 8 }]
    const owner = animationOwnerIndex(source.sequences[0]).get(animationOwnerKey({ kind: 'clip', id: 'clip' }))!
    const title = animationLaneAddress(owner.address, clip.animation!.titleTracks[0]), path = animationLaneAddress(owner.address, clip.animation!.effectPathTracks[0])
    const selected = [key(0, title), key(0, path)]
    const result = planAnimationBatch(source, source.rootSequenceId, selected, { kind: 'move', deltaFrames: -5 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const animation = result.project.sequences[0].tracks[0].clips[0].animation!
      expect(animation.titleTracks![0]).toMatchObject({ propertyVersion: 8, keyframes: [{ frame: -5, value: 8, sourceTimeTicks: -5_000_000 }] })
      expect(animation.effectPathTracks![0].valueVersion).toBe(8)
      expect(animation.effectPathTracks![0].keyframes[0].value).toBe(clip.animation!.effectPathTracks[0].keyframes[0].value)
    }
    expect(planAnimationBatch(source, source.rootSequenceId, selected, { kind: 'set-value', value: 0.2 })).toMatchObject({ ok: false, code: 'unavailable' })
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0, path)], { kind: 'set-easing', easing: { type: 'linear' } })).toMatchObject({ ok: false, code: 'unavailable' })
  })

  test('the title owner adapter supplies static padding, exact element identity and fixed local ticks', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    const { fontFamily, ...text } = defaultTextProps(1920, 1080, 'Title')
    const element: TitleTextElementV1 = { id: 'element', version: 1, kind: 'text', name: 'Text', enabled: false,
      transform: defaultClipTransform(), visual: defaultClipVisualSettings(), opacity: 1,
      text: { ...text, paddingPx: 20 }, font: { family: fontFamily, fallbackFamily: null } }
    const context: AnimationEditContext = { titles: { isTitleClip: (owner) => owner.id === clip.id, readElement: (_owner, id) => id === element.id ? element : undefined } }
    const title: AnimationLaneAddress = { owner: { kind: 'clip', id: clip.id }, kind: 'title', elementId: element.id, property: 'box-width', propertyVersion: 1 }
    expect(planSetAnimationKey(source, source.rootSequenceId, title, 3, 40, undefined, context)).toMatchObject({ ok: false, code: 'bounds' })
    const result = planSetAnimationKey(source, source.rootSequenceId, title, 3, 40.5, undefined, context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.sequences[0].tracks[0].clips[0].animation!.titleTracks![0].keyframes[0]).toEqual(scalarKey(3, 40.5))
    expect(planSetAnimationKey(source, source.rootSequenceId, { ...title, elementId: 'missing' }, 3, 50, undefined, context)).toMatchObject({ ok: false, code: 'unavailable' })
    expect(planSetAnimationKey(source, source.rootSequenceId, scalar('clip', 'position-x'), 3, 2, undefined, context)).toMatchObject({ ok: false, code: 'unavailable' })
    expect(planSetAnimationKey(source, source.rootSequenceId, scalar(), 3, 0.4, undefined, context)).toMatchObject({ ok: true })
    // A bounded unsupported title owner still uses local intent for preserved lanes.
    clip.sourceTimeMap = { sourceStartTicks: 500_000_000, sourceDurationTicks: 0, rate: { numerator: 0, denominator: 1 } }
    const moved = planAnimationBatch(source, source.rootSequenceId, [key(0)], { kind: 'move', deltaFrames: 3 }, context)
    expect(moved.ok).toBe(true)
    if (moved.ok) expect(moved.project.sequences[0].tracks[0].clips[0].animation!.tracks[0].keyframes[0].sourceTimeTicks).toBe(3_000_000)
  })

  test('destination global time cannot overflow even when the local frame is in bounds', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    clip.timelineRange.startFrame = Number.MAX_SAFE_INTEGER - 100
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0)], { kind: 'move', deltaFrames: 101 })).toMatchObject({ ok: false, code: 'bounds', reason: expect.stringContaining('global') })
  })

  test('the final lane key cap rejects duplicate and paste atomically', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    clip.animation!.tracks[0].keyframes = Array.from({ length: 1024 }, (_, frame) => scalarKey(frame, 0.5))
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0)], { kind: 'duplicate', deltaFrames: 1024 })).toMatchObject({ ok: false, code: 'bounds', project: source })
    expect(planAnimationPaste(source, source.rootSequenceId, copied(source, [key(0)]), 1024)).toMatchObject({ ok: false, project: source })
  })

  test('rejects overflow, invalid values, duplicate selection, and changes that break coupled crop admission', () => {
    const source = project()
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0)], { kind: 'move', deltaFrames: 1e9 + 1 })).toMatchObject({ ok: false, code: 'bounds' })
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0)], { kind: 'set-value', value: 2 })).toMatchObject({ ok: false, code: 'bounds' })
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0), key(0)], { kind: 'delete' })).toMatchObject({ ok: false, code: 'invalid-selection' })
    const clip = source.sequences[0].tracks[0].clips[0]
    clip.animation!.tracks = [{ property: 'crop-left', keyframes: [scalarKey(0, 0.4)] }, { property: 'crop-right', keyframes: [scalarKey(0, 0.4)] }]
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0, scalar('clip', 'crop-left'))], { kind: 'set-value', value: 0.8 })).toMatchObject({ ok: false, code: 'budget', project: source })
  })

  test('preflights key and lane counts before copying', () => {
    expect(animationSelectionError(Array.from({ length: 4097 }, () => key(0)))).toMatch(/4,096/)
    expect(animationSelectionError(Array.from({ length: 129 }, (_, i) => key(0, scalar('clip', `future-${i}`))))).toMatch(/128/)
  })

  test('replacement semantics are restricted to one explicit key and validate current value bounds', () => {
    const source = project(), insertion = { lane: scalar(), track: { property: 'opacity', keyframes: [scalarKey(0, 0.3)] } }
    expect(planAnimationInsertions(source, source.rootSequenceId, [insertion])).toMatchObject({ ok: false, code: 'collision' })
    expect(planAnimationInsertions(source, source.rootSequenceId, [insertion], {}, true)).toMatchObject({ ok: true, changed: true })
    expect(planAnimationInsertions(source, source.rootSequenceId, [{ ...insertion, track: { property: 'opacity', keyframes: [scalarKey(0, 2)] } }], {}, true)).toMatchObject({ ok: false, code: 'bounds' })
    expect(planAnimationInsertions(source, source.rootSequenceId, [{ ...insertion, track: { property: 'opacity', keyframes: [scalarKey(0, 0.2), scalarKey(10, 0.3)] } }], {}, true)).toMatchObject({ ok: false, code: 'bounds' })
  })
})

describe('global-time internal key clipboard', () => {
  test('owns frozen copies and recomputes destination source intent without changing relative global spacing', () => {
    const source = project(), doc = source.sequences[0], first = doc.tracks[0].clips[0], second = attributeClip('second', 100)
    second.animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(5, 0.4)] }], effectTracks: [] }
    doc.tracks[0].clips.push(second)
    const clipboard = copied(source, [key(0), key(10), key(5, scalar('second'))])
    first.animation!.tracks[0].keyframes[0].value = 0.9
    expect(clipboard.lanes[0].track.keyframes[0].value).toBe(0.2)
    expect(Object.isFrozen(clipboard.lanes[0].track.keyframes[0].easing)).toBe(true)
    const result = planAnimationPaste(source, source.rootSequenceId, clipboard, 200)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selection).toEqual([key(200), key(210), key(205, scalar('second'))])
    const pasted = result.project.sequences[0].tracks[0].clips[1].animation!.tracks[0].keyframes.at(-1)!
    expect(pasted.sourceTimeTicks).toBe(205_000_000)
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 0, {}, undefined, true)).toMatchObject({ ok: false, code: 'collision' })
  })

  test('cross-lane paste needs one complete compatible mapping, and rejects changed frame rate', () => {
    const source = project(), clipboard = copied(source, [key(0)])
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20, {}, [])).toMatchObject({ ok: false })
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20, {}, [{ from: scalar(), to: scalar('clip', 'position-x') }])).toMatchObject({ ok: false })
    source.sequences[0].frameRate = { num: 60, den: 1 }
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20)).toMatchObject({ ok: false, reason: expect.stringContaining('frame rates') })
  })

  test('compatible explicit scalar and path mappings preserve metadata and never create effect targets', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    clip.animation!.tracks = [{ property: 'position-x', propertyVersion: 1, keyframes: [scalarKey(-5, 123)] }]
    const from = scalar('clip', 'position-x'), to = scalar('clip', 'position-y')
    const result = planAnimationPaste(source, source.rootSequenceId, copied(source, [key(-5, from)]), 20, {}, [{ from, to }])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.project.sequences[0].tracks[0].clips[0].animation!.tracks[1]).toEqual({ property: 'position-y', propertyVersion: 1, keyframes: [scalarKey(20, 123)] })
    clip.effects = ['first', 'second'].map((id) => createMaskEffect(id, 'bezier'))
    const track = pathTrack('first'); clip.animation!.effectPathTracks = [track]
    const path = animationLaneAddress({ kind: 'clip', id: clip.id }, track)
    const copiedPath = copied(source, [key(0, path)])
    const mappedPath: AnimationLaneAddress = { owner: path.owner, kind: 'path', effectId: 'second', parameter: 'path', valueType: 'mask-bezier-path', valueVersion: 1 }
    expect(planAnimationPaste(source, source.rootSequenceId, copiedPath, 20, {}, [{ from: path, to: mappedPath }])).toMatchObject({ ok: true })
    clip.effects.pop()
    expect(planAnimationPaste(source, source.rootSequenceId, copiedPath, 20, {}, [{ from: path, to: mappedPath }])).toMatchObject({ ok: false, project: source })
  })

  test('unavailable exact-address copies survive, while contradictory global metadata is rejected', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    clip.animation!.tracks = [{ property: 'future\0x', propertyVersion: 7, keyframes: [scalarKey(-5, 123), scalarKey(10, 234)] }]
    const from = scalar('clip', 'future\0x', 7), clipboard = copied(source, [key(-5, from), key(10, from)])
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20)).toMatchObject({ ok: true })
    expect(planAnimationPaste(source, source.rootSequenceId, { ...clipboard, lanes: [{ ...clipboard.lanes[0], globalFrames: [-5, 11] }] }, 20)).toMatchObject({ ok: false })
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: false })
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20, {}, [{ from, to: scalar('clip', 'future\0y', 7) }])).toMatchObject({ ok: false })
  })

  test('exact-address paste rejects a different built-in effect type with identical scalar bounds', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    const curves = colorGradingRegistrations().find((effect) => effect.type === 'builtin.rgb-curves')!
    const wheels = colorGradingRegistrations().find((effect) => effect.type === 'builtin.lift-gamma-gain')!
    const makeEffect = (registration: typeof curves) => ({ id: 'same-id', type: registration.type, version: 1, enabled: true, params: { ...registration.defaultParams } })
    const track = { effectId: 'same-id', parameter: 'strength', keyframes: [scalarKey(0, 0.4)] }
    clip.effects = [makeEffect(curves)]; clip.animation!.effectTracks = [track]
    const address = animationLaneAddress({ kind: 'clip', id: clip.id }, track)
    const clipboard = copied(source, [key(0, address)])
    clip.effects = [makeEffect(curves)]
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20)).toMatchObject({ ok: true })
    clip.effects = [makeEffect(wheels)]
    const unchanged = JSON.stringify(source)
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20)).toMatchObject({ ok: false, project: source, reason: expect.stringContaining('effect type') })
    expect(JSON.stringify(source)).toBe(unchanged)
  })

  test('exact path paste checks owner type even when both versions are unavailable', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0]
    const track = { ...pathTrack('same-id'), valueVersion: 9 }
    clip.effects = [createMaskEffect('same-id', 'bezier')]; clip.animation!.effectPathTracks = [track]
    const address = animationLaneAddress({ kind: 'clip', id: clip.id }, track)
    const clipboard = copied(source, [key(0, address)])
    expect(clipboard.lanes[0].contract).toBeNull()
    clip.effects = [createMaskEffect('same-id', 'bezier')]
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20)).toMatchObject({ ok: true })
    clip.effects = [{ id: 'same-id', type: 'future.mask-owner', version: 9, enabled: true, params: {} }]
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20)).toMatchObject({ ok: false, project: source, reason: expect.stringContaining('effect type') })
    // Existing unavailable data can still be copied, timed and pasted under its unchanged owner.
    const futureClipboard = copied(source, [key(0, address)])
    expect(planAnimationPaste(source, source.rootSequenceId, futureClipboard, 20)).toMatchObject({ ok: true })
    expect(planAnimationBatch(source, source.rootSequenceId, [key(0, address)], { kind: 'move', deltaFrames: 3 })).toMatchObject({ ok: true })
    clip.effects = []
    expect(planAnimationPaste(source, source.rootSequenceId, futureClipboard, 20)).toMatchObject({ ok: false })
    const orphanClipboard = copied(source, [key(0, address)])
    expect(planAnimationPaste(source, source.rootSequenceId, orphanClipboard, 20)).toMatchObject({ ok: true })
    clip.effects = [createMaskEffect('same-id', 'bezier')]
    expect(planAnimationPaste(source, source.rootSequenceId, orphanClipboard, 20)).toMatchObject({ ok: false })
  })

  test('does not invent plugin binding or apply a copied declaration after package drift', () => {
    const source = project(), clip = source.sequences[0].tracks[0].clips[0], plugins = animationCatalog()
    clip.effects = [{ id: 'plugin', type: PLUGIN_ANIMATION_EFFECT_TYPE, version: 1, enabled: true, params: { amount: 0.2 } }]
    const declaration = plugins.declarations[0]
    const identity = { version: 1, effectType: declaration.effectType, descriptorVersion: declaration.descriptorVersion, contributionId: declaration.contributionId, contributionVersion: declaration.contributionVersion, packageDigest: declaration.packageDigest }
    const track = { effectId: 'plugin', parameter: 'amount', parameterIdentity: identity, keyframes: [scalarKey(0, 0.8)] }
    clip.animation!.effectTracks = [track]
    const lane = animationLaneAddress({ kind: 'clip', id: clip.id }, track), clipboard = copied(source, [key(0, lane)], { plugins })
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20, { plugins: animationCatalog(2, '3') })).toMatchObject({ ok: false })
    expect(planAnimationPaste(source, source.rootSequenceId, clipboard, 20, { plugins })).toMatchObject({ ok: true })
  })
})
