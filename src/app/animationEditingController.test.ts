import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAnimationEditingController } from './animationEditingController'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useMediaStore } from '../state/mediaStore'
import { animationCatalog, ATTRIBUTE_ASSET_DESCRIPTOR, foundationProject, scalarKey, pathTrack } from '../test/animationFoundationFixtures'
import { animationLaneAddress } from '../domain/animationOwners'
import { projectPathAnimationSnapshot, animationRetentionError } from '../domain/animationProjectBudget'
import { maskPathAnimationSnapshotBudget, MASK_PATH_ANIMATION_LIMITS } from '../domain/maskPathAnimation'
import { TITLE_BUDGET_LIMITS } from '../domain/titleBudgets'
import { colorGradingRegistrations } from '../domain/colorGradingEffects'
import { createMaskEffect } from '../domain/effectStack'
import { commitPortableProjectEdit } from './portableProjectEdit'
import type { AnimationKeyAddress, AnimationLaneAddress } from '../domain/animationAddresses'

const lane: AnimationLaneAddress = { owner: { kind: 'clip', id: 'clip' }, kind: 'scalar', property: 'opacity', propertyVersion: 1 }
const key = (frame: number): AnimationKeyAddress => ({ lane, frame })
let controller: ReturnType<typeof createAnimationEditingController>, release: () => void
let pending: Map<number, () => void>, nextFrame: number, messages: string[], contextChanged: () => void
let plugins: ReturnType<typeof animationCatalog>
beforeEach(() => {
  const project = foundationProject()
  project.sequences[0].tracks[0].clips[0].animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, 0.2), scalarKey(10, 0.8)] }], effectTracks: [] }
  useDocumentStore.getState().setProject(project)
  useTransportStore.getState().resetTransport()
  useTransportStore.getState().setAnimationSelection([key(0), key(10)])
  useMediaStore.setState({ descriptors: new Map([['asset', ATTRIBUTE_ASSET_DESCRIPTOR]]), collections: [] })
  pending = new Map(); nextFrame = 0; messages = []; plugins = animationCatalog(); contextChanged = () => {}
  controller = createAnimationEditingController({
    readContext: () => ({ plugins }), subscribeContext: (callback) => { contextChanged = callback; return () => { contextChanged = () => {} } },
    requestFrame: (callback) => { pending.set(++nextFrame, callback); return nextFrame }, cancelFrame: (id) => { pending.delete(id) }, report: (message) => messages.push(message),
  })
  release = controller.init()
})
afterEach(() => { release(); useTransportStore.getState().resetTransport() })
function flush() { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach((callback) => callback()) }

describe('animation gesture ownership', () => {
  test('coalesces previews, recomputes the final command, and commits exactly one undoable project', () => {
    const before = useDocumentStore.getState(), gesture = controller.begin()
    for (let delta = 1; delta <= 20; delta++) gesture.preview({ kind: 'move', deltaFrames: delta })
    expect(pending.size).toBe(1)
    expect(useDocumentStore.getState()).toBe(before)
    flush()
    const preview = useTransportStore.getState().animationPreview!
    expect(preview.document.tracks[0].clips[0].animation!.tracks[0].keyframes[0].frame).toBe(20)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    expect(gesture.commit({ kind: 'move', deltaFrames: 30 })).toBeNull()
    const after = useDocumentStore.getState()
    expect(after.doc.tracks[0].clips[0].animation!.tracks[0].keyframes[0].frame).toBe(30)
    expect(after.past).toEqual([before.project])
    expect(useTransportStore.getState().animationSelection).toEqual([key(30), key(40)])
    expect(useTransportStore.getState().animationPreview).toBeNull()
    after.undo()
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(useTransportStore.getState().animationSelection).toEqual([])
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().project).toBe(after.project)
    expect(useTransportStore.getState().animationSelection).toEqual([])
  })

  test.each(['project', 'generation', 'sequence', 'selection', 'playhead', 'source', 'catalog', 'reset', 'playback', 'workspace', 'focused lane'] as const)('cancels stale %s and a late queued callback without history', (change) => {
    const gesture = controller.begin()
    gesture.preview({ kind: 'move', deltaFrames: 3 })
    const lateCallback = [...pending.values()][0]
    const initial = useDocumentStore.getState()
    if (change === 'project') useDocumentStore.getState().setClipVolume('clip', 0.5)
    if (change === 'generation') useDocumentStore.setState({ projectGeneration: initial.projectGeneration + 1 })
    if (change === 'sequence') useDocumentStore.setState({ activeSequenceId: 'other' })
    if (change === 'selection') useTransportStore.getState().setAnimationSelection([key(10)])
    if (change === 'playhead') useTransportStore.getState().setPlayheadFrame(5)
    if (change === 'source') useMediaStore.setState({ descriptors: new Map(useMediaStore.getState().descriptors) })
    if (change === 'catalog') { plugins = animationCatalog(2); contextChanged() }
    if (change === 'reset') useTransportStore.getState().resetTransport()
    if (change === 'workspace') useTransportStore.getState().setAnimationWorkspaceOpen(true)
    if (change === 'focused lane') useTransportStore.getState().setAnimationFocusedLane({ ...key(0).lane, kind: 'scalar', property: 'volume', propertyVersion: 1 })
    if (change === 'playback') useTransportStore.setState({ isPlaying: true })
    const expected = useDocumentStore.getState()
    lateCallback()
    expect(gesture.commit({ kind: 'move', deltaFrames: 5 })).toMatch(/changed/)
    expect(useDocumentStore.getState()).toBe(expected)
    expect(useTransportStore.getState().animationPreview).toBeNull()
    expect(pending.size).toBe(0)
  })

  test('cancel restores another named preview instead of clearing its ownership', () => {
    const doc = useDocumentStore.getState().doc
    useTransportStore.getState().setMaskPreview({ sequenceId: doc.id, effectId: 'mask', params: {}, document: doc })
    const gesture = controller.begin()
    gesture.preview({ kind: 'move', deltaFrames: 3 }); flush()
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('animation-gesture')
    gesture.cancel()
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('mask-gesture')
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  test('Escape cancels queued work without writing history', () => {
    const before = useDocumentStore.getState(), gesture = controller.begin()
    gesture.preview({ kind: 'move', deltaFrames: 4 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    flush()
    expect(useDocumentStore.getState()).toBe(before)
    expect(useTransportStore.getState().animationPreview).toBeNull()
    expect(pending.size).toBe(0)
  })

  test('reentrant cleanup cannot sneak a stale commit past the pinned context', () => {
    const gesture = controller.begin(() => useTransportStore.getState().setPlayheadFrame(7))
    expect(gesture.commit({ kind: 'move', deltaFrames: 5 })).toMatch(/changed/)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    expect(useTransportStore.getState().animationPreview).toBeNull()
  })

  test('reentrant disposal during commit does not reinstall a cut clipboard or selection', () => {
    const original = useDocumentStore.getState().project
    const unsubscribe = useDocumentStore.subscribe((state) => { if (state.project !== original) release() })
    try {
      expect(controller.cut()).toMatch(/changed/)
      expect(useDocumentStore.getState().past).toEqual([original])
      expect(controller.getClipboard()).toBeNull()
      expect(useTransportStore.getState().animationSelection).toEqual([])
      expect(useDocumentStore.getState().retainedTitleClipboardKeys).toEqual([])
    } finally { unsubscribe() }
  })

  test('reentrant undo during commit reconciles current keys without resurrecting moved selection', () => {
    const original = useDocumentStore.getState().project
    let handled = false
    const unsubscribe = useDocumentStore.subscribe((state) => {
      if (!handled && state.project !== original) { handled = true; state.undo() }
    })
    try {
      expect(controller.edit({ kind: 'move', deltaFrames: 20 })).toMatch(/changed/)
      expect(useDocumentStore.getState().project).toBe(original)
      expect(useTransportStore.getState().animationSelection).toEqual([key(0), key(10)])
      expect(useDocumentStore.getState().future).toHaveLength(1)
    } finally { unsubscribe() }
  })

  test('synchronous declaration subscription cancellation releases its subscription', () => {
    release()
    let released = 0
    controller = createAnimationEditingController({ subscribeContext: (changed) => {
      useTransportStore.getState().setPlayheadFrame(9)
      changed()
      return () => { released++ }
    } })
    release = controller.init()
    const gesture = controller.begin()
    expect(released).toBe(1)
    expect(gesture.commit({ kind: 'move', deltaFrames: 5 })).toMatch(/changed/)
    expect(useDocumentStore.getState().past).toEqual([])
  })

  test('a gesture started by cleanup keeps its ownership and prevents the earlier commit', () => {
    let replacement: ReturnType<typeof controller.begin> | undefined
    const gesture = controller.begin(() => { replacement = controller.begin() })
    expect(gesture.commit({ kind: 'move', deltaFrames: 5 })).toMatch(/changed/)
    expect(useDocumentStore.getState().past).toEqual([])
    replacement!.preview({ kind: 'move', deltaFrames: 20 }); flush()
    expect(useTransportStore.getState().animationPreview).not.toBeNull()
    replacement!.cancel()
    expect(useTransportStore.getState().animationPreview).toBeNull()
  })

  test('a rejected collision and a no-op preserve redo and exact selection/focus', () => {
    useDocumentStore.getState().setClipVolume('clip', 0.5); useDocumentStore.getState().undo()
    useTransportStore.getState().setAnimationSelection([key(0), key(10)], key(10))
    const before = useDocumentStore.getState(), selection = useTransportStore.getState().animationSelection, focus = useTransportStore.getState().animationFocus
    expect(controller.edit({ kind: 'move', deltaFrames: 0 })).toBeNull()
    expect(useDocumentStore.getState()).toBe(before)
    expect(useTransportStore.getState().animationSelection).toBe(selection)
    expect(useTransportStore.getState().animationFocus).toBe(focus)
    useTransportStore.getState().setAnimationSelection([key(0)])
    expect(controller.edit({ kind: 'move', deltaFrames: 10 })).toMatch(/destination key/)
    expect(useDocumentStore.getState()).toBe(before)
  })

  test('explicit Set replaces one key, preserves the clip fallback, and adds one new lane when supported', () => {
    expect(controller.setKey(lane, 0, 0.6)).toBeNull()
    const after = useDocumentStore.getState()
    expect(after.doc.tracks[0].clips[0].opacity).toBe(1)
    expect(after.doc.tracks[0].clips[0].animation!.tracks[0].keyframes[0].value).toBe(0.6)
    expect(after.past).toHaveLength(1)
    expect(controller.setKey({ ...lane, kind: 'scalar', property: 'position-x', propertyVersion: 1 }, 5, 123)).toBeNull()
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].animation!.tracks).toHaveLength(2)
  })
})

describe('animation clipboard ownership', () => {
  test('cut is one edit; clipboard survives undo but deleted selection is never resurrected', () => {
    const original = useDocumentStore.getState().project
    expect(controller.cut()).toBeNull()
    expect(useDocumentStore.getState().past).toEqual([original])
    expect(controller.getClipboard()?.lanes[0].track.keyframes).toHaveLength(2)
    const clipboard = controller.getClipboard()
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(original)
    expect(useTransportStore.getState().animationSelection).toEqual([])
    expect(controller.getClipboard()).toBe(clipboard)
    useTransportStore.getState().setPlayheadFrame(20)
    expect(controller.paste()).toBeNull()
    expect(useTransportStore.getState().animationSelection).toEqual([key(20), key(30)])
    expect(useDocumentStore.getState().future).toEqual([])
  })

  test.each(['effect', 'path'] as const)('refusing same-ID %s owner type drift preserves clipboard, selection and both history branches', (kind) => {
    const source = foundationProject(), clip = source.sequences[0].tracks[0].clips[0]
    const curves = colorGradingRegistrations().find((effect) => effect.type === 'builtin.rgb-curves')!
    const wheels = colorGradingRegistrations().find((effect) => effect.type === 'builtin.lift-gamma-gain')!
    let address: AnimationLaneAddress
    if (kind === 'effect') {
      const track = { effectId: 'same-id', parameter: 'strength', keyframes: [scalarKey(0, 0.4)] }
      clip.effects = [{ id: 'same-id', type: curves.type, version: 1, enabled: true, params: { ...curves.defaultParams } }]
      clip.animation = { tracks: [], effectTracks: [track] }
      address = animationLaneAddress({ kind: 'clip', id: clip.id }, track)
    } else {
      const track = { ...pathTrack('same-id'), valueVersion: 9 }
      clip.effects = [createMaskEffect('same-id', 'bezier')]
      clip.animation = { tracks: [], effectTracks: [], effectPathTracks: [track] }
      address = animationLaneAddress({ kind: 'clip', id: clip.id }, track)
    }
    useDocumentStore.getState().setProject(source)
    useTransportStore.getState().setAnimationSelection([{ lane: address, frame: 0 }])
    expect(controller.copy()).toBeNull()
    const clipboard = controller.getClipboard(), original = useDocumentStore.getState()
    const changed = structuredClone(original.project)
    changed.sequences[0].tracks[0].clips[0].effects = [{ id: 'same-id', type: wheels.type, version: 1, enabled: true, params: { ...wheels.defaultParams } }]
    expect(commitPortableProjectEdit(original.project, original.projectGeneration, changed)).toBeNull()
    useDocumentStore.getState().setClipVolume('clip', 0.5); useDocumentStore.getState().undo()
    useTransportStore.getState().setPlayheadFrame(20)
    const before = useDocumentStore.getState(), selection = useTransportStore.getState().animationSelection
    expect(before.past.length).toBeGreaterThan(0)
    expect(before.future).toHaveLength(1)
    expect(controller.paste()).toMatch(/effect type/)
    expect(controller.getClipboard()).toBe(clipboard)
    expect(useDocumentStore.getState()).toBe(before)
    expect(useTransportStore.getState().animationSelection).toBe(selection)
    expect(useTransportStore.getState().animationPreview).toBeNull()
    // Restoring the original type also restores compatibility with the same clipboard.
    before.undo()
    expect(controller.paste()).toBeNull()
    expect(controller.getClipboard()).toBe(clipboard)
  })

  test('same-id project reload and unmount clear copied data and pending gesture ownership', () => {
    expect(controller.copy()).toBeNull()
    const project = useDocumentStore.getState().project
    useDocumentStore.getState().setProject(project)
    expect(controller.getClipboard()).toBeNull()
    useTransportStore.getState().setAnimationSelection([key(0)])
    expect(controller.copy()).toBeNull()
    const gesture = controller.begin(); gesture.preview({ kind: 'move', deltaFrames: 4 })
    release()
    expect(pending.size).toBe(0)
    expect(controller.getClipboard()).toBeNull()
    expect(useDocumentStore.getState().retainedKeyPathTracks).toEqual([])
    expect(controller.edit({ kind: 'move', deltaFrames: 1 })).toMatch(/not mounted/)
  })

  test('title clipboard admission counts complete addresses and timing metadata before replacing old data', () => {
    const source = foundationProject(), clip = source.sequences[0].tracks[0].clips[0]
    const track = { elementId: 'e'.repeat(256), property: 'p'.repeat(256), propertyVersion: 7, keyframes: [scalarKey(0, 123)] }
    clip.animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, 0.2)] }], effectTracks: [], titleTracks: [track] }
    useDocumentStore.getState().setProject(source)
    useTransportStore.getState().setAnimationSelection([key(0)])
    expect(controller.copy()).toBeNull()
    const previousClipboard = controller.getClipboard()
    useDocumentStore.getState().setClipVolume('clip', 0.5); useDocumentStore.getState().undo()
    const tracksBytes = JSON.stringify([track]).length
    // Leave enough for another bare track array, but not its full clipboard envelope.
    let remaining = TITLE_BUDGET_LIMITS.retainedBytes / 2 - tracksBytes * 2 - 10
    const owners = []
    while (remaining > 0) {
      const bytes = Math.min(1024 * 1024, remaining), count = Math.ceil(bytes / 20_000)
      const payload: string[] = []
      let characters = bytes - JSON.stringify({ version: 2, payload }).length - (3 * count - 1)
      for (let index = 0; index < count; index++) {
        const size = Math.min(20_000, characters); payload.push('a'.repeat(size)); characters -= size
      }
      const title = { version: 2, payload }
      expect(JSON.stringify(title).length).toBe(bytes)
      owners.push({ title }); remaining -= bytes
    }
    useDocumentStore.setState({ retainedTitleClipboardOwners: owners })
    useTransportStore.getState().setAnimationSelection([{ lane: animationLaneAddress({ kind: 'clip', id: clip.id }, track), frame: 0 }])
    const before = useDocumentStore.getState()
    expect(before.future).toHaveLength(1)
    expect(animationRetentionError(before, before.project)).toBeNull()
    expect(animationRetentionError({ ...before, retainedTitleClipboardKeys: [[structuredClone(track)]] }, before.project)).toBeNull()
    expect(controller.copy()).toMatch(/64 MiB/)
    expect(controller.cut()).toMatch(/64 MiB/)
    expect(controller.getClipboard()).toBe(previousClipboard)
    expect(useDocumentStore.getState()).toBe(before)
    useDocumentStore.setState({ retainedTitleClipboardOwners: [] })
    expect(controller.copy()).toBeNull()
    const clipboard = controller.getClipboard()!
    expect(useDocumentStore.getState().retainedTitleClipboardKeys).toEqual([{ version: 1, frameRate: clipboard.frameRate, anchorGlobalFrame: 0, lanes: clipboard.lanes }])
  })

  test('copy and cut reject path retention growth before replacing an old clipboard or clearing redo', () => {
    const make = () => {
      const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
      clip.animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, 0.2)] }], effectTracks: [], effectPathTracks: [0, 1].map((index) => ({
        effectId: `orphan-${index}`, parameter: 'future', valueType: 'future-path', valueVersion: 9,
        keyframes: Array.from({ length: 256 }, (_, frame) => ({ frame, sourceTimeTicks: frame * 1_000_000, value: 'x'.repeat(2048), easing: { type: 'hold' as const } })),
      })) }
      return project
    }
    const source = make(), budget = maskPathAnimationSnapshotBudget(projectPathAnimationSnapshot(source))
    expect(budget.ok).toBe(true); if (!budget.ok) return
    useDocumentStore.getState().setProject(source)
    useTransportStore.getState().setAnimationSelection([key(0)])
    expect(controller.copy()).toBeNull()
    const clipboard = controller.getClipboard()
    const future = Array.from({ length: Math.floor(MASK_PATH_ANIMATION_LIMITS.retainedBytes / budget.usage.retainedBytes) - 1 }, make)
    useDocumentStore.setState({ future })
    const tracks = source.sequences[0].tracks[0].clips[0].animation!.effectPathTracks!
    useTransportStore.getState().setAnimationSelection(tracks.flatMap((track) => track.keyframes.map((key) => ({ frame: key.frame, lane: animationLaneAddress({ kind: 'clip', id: 'clip' }, track) }))))
    const before = useDocumentStore.getState()
    expect(animationRetentionError(before, before.project)).toBeNull()
    expect(controller.copy()).toMatch(/32 MiB/)
    expect(controller.cut()).toMatch(/32 MiB/)
    expect(controller.getClipboard()).toBe(clipboard)
    expect(useDocumentStore.getState()).toBe(before)
  })
})
