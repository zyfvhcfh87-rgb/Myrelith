import { describe, expect, test, vi } from 'vitest'
import { EFFECT_STACK_LIMITS } from '../domain/effectBounds'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import {
  createPluginVideoEffectContributionSnapshot,
  type PluginVideoEffectContributionDeclarationInput,
} from '../domain/pluginVideoEffectStagePlan'
import type { Clip, EffectDescriptor, TimelineDoc } from '../domain/schema'
import type { DocumentState } from '../state/documentStore'
import {
  createPluginDocumentGenerationController,
  type PluginDocumentGenerationController,
  type PluginDocumentStoreAdapter,
} from './pluginDocumentGeneration'
import {
  createPluginEditorController,
  type PluginAppEditorActionView,
  type PluginEditorInstalledPackageProjection,
  type PluginEditorPluginProjection,
} from './pluginEditorController'

const PLUGIN_ID = 'com.example.editor'
const EFFECT_TYPE = `plugin:${PLUGIN_ID}/sparkle`
const PACKAGE_DIGEST = `sha256:${'1'.repeat(64)}`
const SIGNER_FINGERPRINT = `sha256:${'2'.repeat(64)}`

const AVAILABLE_ACTION: PluginAppEditorActionView = Object.freeze({
  available: true,
  disabledReason: null,
  pending: false,
  error: null,
})

function declaration(
  availability: PluginVideoEffectContributionDeclarationInput['availability'] = 'ready',
  mode: {
    readonly default: string
    readonly options: readonly string[]
  } = { default: 'soft', options: ['soft', 'hard'] },
): PluginVideoEffectContributionDeclarationInput {
  return Object.freeze({
    signerFingerprint: SIGNER_FINGERPRINT,
    packageDigest: PACKAGE_DIGEST,
    pluginId: PLUGIN_ID,
    pluginVersion: '2.0.0',
    kind: 'video-effect',
    contributionVersion: 1,
    contributionId: 'sparkle',
    contributionName: 'Sparkle',
    descriptorVersion: 2,
    entrypoint: 'render_sparkle',
    parameters: Object.freeze([
      Object.freeze({
        key: 'strength',
        name: 'Strength',
        kind: 'number' as const,
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
        animatable: true,
      }),
      Object.freeze({
        key: 'enabled',
        name: 'Enabled',
        kind: 'boolean' as const,
        default: true,
      }),
      Object.freeze({
        key: 'mode',
        name: 'Mode',
        kind: 'enum' as const,
        default: mode.default,
        options: Object.freeze(mode.options.map((value) => Object.freeze({
          value,
          name: value,
        }))),
      }),
    ]),
    availability,
    detail: availability === 'ready' ? 'Ready.' : 'Unavailable locally.',
  })
}

function pluginEffect(options: {
  id?: string
  version?: number
  enabled?: boolean
  params?: EffectDescriptor['params']
} = {}): EffectDescriptor {
  return {
    id: options.id ?? 'effect-plugin',
    type: EFFECT_TYPE,
    version: options.version ?? 2,
    enabled: options.enabled ?? true,
    params: options.params ?? { strength: 0.5, enabled: true, mode: 'soft' },
  }
}

function clip(
  effects: EffectDescriptor[] = [pluginEffect()],
  animatedParameter?: string,
): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Clip 1',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 30 },
    timelineRange: { startFrame: 0, durationFrames: 30 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    animation: {
      tracks: [],
      effectTracks: animatedParameter ? [{
        effectId: effects[0]?.id ?? 'effect-plugin',
        parameter: animatedParameter,
        keyframes: [{ frame: 0, value: 0.5, easing: { type: 'linear' as const } }],
      }] : [],
    },
    effects,
  }
}

function documentWith(clips: Clip[] = [clip()], locked = false): TimelineDoc {
  const empty = createTimelineDoc('Plugin editor', DEFAULT_PROJECT_SETTINGS, 'doc-editor')
  return {
    ...empty,
    tracks: empty.tracks.map((track, index) => (
      index === 0 ? { ...track, locked, clips } : track
    )),
  }
}

function packageProjection(): PluginEditorInstalledPackageProjection {
  return Object.freeze({
    id: PLUGIN_ID,
    name: 'Editor Plugin',
    version: '2.0.0',
    packageDigest: PACKAGE_DIGEST,
    actions: Object.freeze({
      retry: AVAILABLE_ACTION,
      disable: AVAILABLE_ACTION,
    }),
  })
}

function storeHarness(initial = documentWith()) {
  let document = initial
  const listeners = new Set<(state: DocumentState, previous: DocumentState) => void>()
  const past: TimelineDoc[] = []
  const future: TimelineDoc[] = []
  const commits: TimelineDoc[] = []

  const notify = (next: TimelineDoc): void => {
    const previous = { doc: document, setDocWithHistory } as DocumentState
    document = next
    const state = { doc: document, setDocWithHistory } as DocumentState
    for (const listener of listeners) listener(state, previous)
  }
  const setDocWithHistory = (next: TimelineDoc): void => {
    past.push(document)
    future.length = 0
    commits.push(next)
    notify(next)
  }
  const store: PluginDocumentStoreAdapter = {
    getState: () => ({ doc: document, setDocWithHistory }),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    store,
    commits,
    listeners,
    document: () => document,
    replace(next: TimelineDoc) { notify(next) },
    notifySameReference() { notify(document) },
    undo() {
      const previous = past.pop()
      if (!previous) return
      future.push(document)
      notify(previous)
    },
    redo() {
      const next = future.pop()
      if (!next) return
      past.push(document)
      notify(next)
    },
  }
}

function setup(options: {
  readonly document?: TimelineDoc
  readonly contribution?: ReturnType<typeof createPluginVideoEffectContributionSnapshot>
  readonly startupMode?: PluginEditorPluginProjection['startupMode']
  readonly packages?: readonly PluginEditorInstalledPackageProjection[]
  readonly createEffectId?: () => string
} = {}) {
  const store = storeHarness(options.document)
  const documentController = createPluginDocumentGenerationController(store.store)
  let revision = 1
  let startupMode = options.startupMode ?? 'normal'
  let contribution = options.contribution
    ?? createPluginVideoEffectContributionSnapshot(7, [declaration()])
  let packages = options.packages ?? Object.freeze([packageProjection()])
  const readPlugins = vi.fn((): PluginEditorPluginProjection => Object.freeze({
    revision,
    startupMode,
    catalogGeneration: contribution.catalogGeneration,
    contributionSnapshot: contribution,
    installedPackages: packages,
  }))
  const controller = createPluginEditorController({
    readPlugins,
    documentController,
    documentStore: store.store,
    createEffectId: options.createEffectId,
  })
  return {
    controller,
    store,
    readPlugins,
    setPlugins(next: {
      readonly contribution?: ReturnType<typeof createPluginVideoEffectContributionSnapshot>
      readonly startupMode?: PluginEditorPluginProjection['startupMode']
      readonly packages?: readonly PluginEditorInstalledPackageProjection[]
    }) {
      revision++
      contribution = next.contribution ?? contribution
      startupMode = next.startupMode ?? startupMode
      packages = next.packages ?? packages
      controller.refresh()
    },
  }
}

function requestGenerations(controller: ReturnType<typeof setup>['controller']) {
  const snapshot = controller.getSnapshot()
  if (snapshot.catalogGeneration === null) throw new Error('catalog is unavailable')
  return {
    documentGeneration: snapshot.documentGeneration,
    catalogGeneration: snapshot.catalogGeneration,
  }
}

function expectDeepFrozenData(value: unknown, seen = new Set<object>()): void {
  expect(typeof value).not.toBe('function')
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  expect(value).not.toBeInstanceOf(Map)
  expect(value).not.toBeInstanceOf(Set)
  expect(value).not.toBeInstanceOf(Uint8Array)
  for (const nested of Object.values(value)) expectDeepFrozenData(nested, seen)
}

describe('plugin editor controller', () => {
  test('projects deeply frozen ready fields and host actions without private facts', () => {
    const harness = setup()
    const snapshot = harness.controller.getSnapshot()

    expect(snapshot).toMatchObject({
      coherent: true,
      documentGeneration: 0,
      catalogGeneration: 7,
      effects: [{
        clipId: 'clip-1',
        effectInstanceId: 'effect-plugin',
        effectLabel: 'Sparkle',
        pluginId: PLUGIN_ID,
        pluginName: 'Editor Plugin',
        pluginVersion: '2.0.0',
        packageDigest: PACKAGE_DIGEST,
        status: 'ready',
        blocksExport: false,
        parameters: [
          { key: 'strength', kind: 'number', value: 0.5, state: 'editable' },
          { key: 'enabled', kind: 'boolean', value: true, state: 'editable' },
          { key: 'mode', kind: 'enum', value: 'soft', state: 'editable' },
        ],
      }],
      previewIssues: [],
    })
    expectDeepFrozenData(snapshot)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(SIGNER_FINGERPRINT)
    expect(serialized).not.toContain('runtimeController')
    expect(serialized).not.toContain('trustPolicy')
    expect(serialized).not.toContain('archiveBytes')
  })

  test('uses planner truth for every unavailable status and nullable missing identity', () => {
    const unavailable = [
      'disabled',
      'incompatible',
      'failed',
      'revoked',
      'untrusted',
      'safe-mode',
      'quarantined',
    ] as const
    for (const availability of unavailable) {
      const harness = setup({
        contribution: createPluginVideoEffectContributionSnapshot(7, [declaration(availability)]),
      })
      expect(harness.controller.getSnapshot()).toMatchObject({
        effects: [{ status: availability, blocksExport: true }],
        previewIssues: [{ status: availability, blocksExport: true }],
      })
      harness.controller.dispose()
    }

    const safeMode = setup({ startupMode: 'safe-mode' })
    expect(safeMode.controller.getSnapshot()).toMatchObject({
      effects: [{ status: 'safe-mode', blocksExport: true }],
      previewIssues: [{ status: 'safe-mode' }],
    })

    const missing = setup({
      contribution: createPluginVideoEffectContributionSnapshot(7, []),
      packages: Object.freeze([]),
    })
    expect(missing.controller.getSnapshot()).toMatchObject({
      effects: [{
        status: 'missing',
        pluginId: PLUGIN_ID,
        pluginName: PLUGIN_ID,
        pluginVersion: null,
        packageDigest: null,
        actions: {
          retry: { available: false },
          disable: { available: false },
          manage: { available: true },
        },
      }],
      previewIssues: [{ pluginId: PLUGIN_ID, pluginName: PLUGIN_ID, status: 'missing' }],
    })
    safeMode.controller.dispose()
    missing.controller.dispose()
  })

  test('projects descriptor compatibility statuses and excludes authored bypass from preview issues', () => {
    const mismatch = setup({ document: documentWith([clip([pluginEffect({ version: 1 })])]) })
    expect(mismatch.controller.getSnapshot()).toMatchObject({
      effects: [{ status: 'version-mismatch', blocksExport: true }],
      previewIssues: [{ status: 'version-mismatch' }],
    })

    const invalid = setup({
      document: documentWith([clip([pluginEffect({ params: {
        strength: 'bad', enabled: true, mode: 'soft',
      } })])]),
    })
    expect(invalid.controller.getSnapshot()).toMatchObject({
      effects: [{ status: 'invalid', blocksExport: true }],
    })

    const unsupported = setup({
      document: documentWith([clip([pluginEffect({ params: {
        strength: 0.5, enabled: true, mode: 'soft', future: true,
      } })])]),
    })
    expect(unsupported.controller.getSnapshot()).toMatchObject({
      effects: [{ status: 'unsupported', blocksExport: true }],
    })

    const authoredDisabled = setup({
      document: documentWith([clip([pluginEffect({ enabled: false })])]),
    })
    expect(authoredDisabled.controller.getSnapshot()).toMatchObject({
      effects: [{ status: 'disabled', blocksExport: false }],
      previewIssues: [],
    })
    mismatch.controller.dispose()
    invalid.controller.dispose()
    unsupported.controller.dispose()
    authoredDisabled.controller.dispose()
  })

  test('adds exact defaults with an app-owned id and one undoable CAS commit', () => {
    const harness = setup({
      document: documentWith([clip([])]),
      createEffectId: () => 'fx_app_owned',
    })
    const result = harness.controller.addPluginEffect({
      ...requestGenerations(harness.controller),
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    })

    expect(result).toMatchObject({ status: 'applied', code: 'applied', documentGeneration: 1 })
    expect(harness.store.commits).toHaveLength(1)
    expect(harness.store.document().tracks[0]?.clips[0]?.effects).toEqual([{
      id: 'fx_app_owned',
      type: EFFECT_TYPE,
      version: 2,
      enabled: true,
      params: { strength: 0.5, enabled: true, mode: 'soft' },
    }])
    const serialized = JSON.stringify(harness.store.document())
    expect(serialized).not.toContain(SIGNER_FINGERPRINT)
    expect(serialized).not.toContain(PACKAGE_DIGEST)
    expect(serialized).not.toContain('trust')

    harness.store.undo()
    expect(harness.store.document().tracks[0]?.clips[0]?.effects).toEqual([])
    harness.store.redo()
    expect(harness.store.document().tracks[0]?.clips[0]?.effects[0]?.id).toBe('fx_app_owned')
  })

  test('edits exact primitive schemas with one commit and rejects invalid or animated values', () => {
    const harness = setup()
    const first = harness.controller.setPluginEffectParameter({
      ...requestGenerations(harness.controller),
      clipId: 'clip-1',
      effectInstanceId: 'effect-plugin',
      key: 'strength',
      value: 0.75,
    })
    expect(first.status).toBe('applied')
    expect(harness.store.document().tracks[0]?.clips[0]?.effects[0]?.params.strength).toBe(0.75)

    const invalid = harness.controller.setPluginEffectParameter({
      ...requestGenerations(harness.controller),
      clipId: 'clip-1',
      effectInstanceId: 'effect-plugin',
      key: 'mode',
      value: 'unknown',
    })
    expect(invalid.code).toBe('invalid-parameter')
    expect(harness.store.commits).toHaveLength(1)

    const noChange = harness.controller.setPluginEffectParameter({
      ...requestGenerations(harness.controller),
      clipId: 'clip-1',
      effectInstanceId: 'effect-plugin',
      key: 'strength',
      value: 0.75,
    })
    expect(noChange.code).toBe('no-change')
    expect(harness.store.commits).toHaveLength(1)

    const animated = setup({ document: documentWith([clip([pluginEffect()], 'strength')]) })
    expect(animated.controller.getSnapshot().effects[0]?.parameters.find(
      (field) => field.key === 'strength',
    )).toMatchObject({
      key: 'strength',
      state: 'locked',
      stateReason: 'This parameter is animated and cannot be changed by the static editor.',
    })
    expect(animated.controller.setPluginEffectParameter({
      ...requestGenerations(animated.controller),
      clipId: 'clip-1',
      effectInstanceId: 'effect-plugin',
      key: 'strength',
      value: 0.8,
    }).code).toBe('animated-parameter')
    expect(animated.store.commits).toHaveLength(0)
    animated.controller.dispose()
  })

  test('refuses to mutate a malformed video effect attached to an audio track', () => {
    const document = documentWith()
    const audioDocument: TimelineDoc = {
      ...document,
      tracks: document.tracks.map((track, index) => (
        index === 0 ? { ...track, kind: 'audio' as const } : track
      )),
    }
    const harness = setup({ document: audioDocument })

    expect(harness.controller.setPluginEffectParameter({
      ...requestGenerations(harness.controller),
      clipId: 'clip-1',
      effectInstanceId: 'effect-plugin',
      key: 'strength',
      value: 0.75,
    })).toMatchObject({ status: 'rejected', code: 'invalid-target' })
    expect(harness.store.commits).toHaveLength(0)
    harness.controller.dispose()
  })

  test('distinguishes an exact-capacity string replacement from a genuine no-change', () => {
    const currentMode = 'a'
    const fullString = 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters)
    const fullCount = Math.floor(
      (EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters - currentMode.length)
        / fullString.length,
    )
    const remainingCharacters = EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters
      - currentMode.length
      - (fullCount * fullString.length)
    const fillerEffects: EffectDescriptor[] = Array.from(
      { length: fullCount },
      (_, index) => ({
        id: `filler-${index}`,
        type: 'builtin:filler',
        version: 0,
        enabled: true,
        params: { padding: fullString },
      }),
    )
    if (remainingCharacters > 0) {
      fillerEffects.push({
        id: 'filler-remainder',
        type: 'builtin:filler',
        version: 0,
        enabled: true,
        params: { padding: 'x'.repeat(remainingCharacters) },
      })
    }
    const target = pluginEffect({
      params: { strength: 0.5, enabled: true, mode: currentMode },
    })
    const harness = setup({
      document: documentWith([clip([target, ...fillerEffects])]),
      contribution: createPluginVideoEffectContributionSnapshot(7, [
        declaration('ready', { default: currentMode, options: [currentMode, 'bb'] }),
      ]),
    })
    const original = harness.store.document()

    expect(harness.controller.setPluginEffectParameter({
      ...requestGenerations(harness.controller),
      clipId: 'clip-1',
      effectInstanceId: 'effect-plugin',
      key: 'mode',
      value: 'bb',
    })).toMatchObject({ status: 'rejected', code: 'budget-exceeded' })
    expect(harness.store.document()).toBe(original)
    expect(harness.store.commits).toHaveLength(0)

    expect(harness.controller.setPluginEffectParameter({
      ...requestGenerations(harness.controller),
      clipId: 'clip-1',
      effectInstanceId: 'effect-plugin',
      key: 'mode',
      value: currentMode,
    })).toMatchObject({ status: 'rejected', code: 'no-change' })
    expect(harness.store.document()).toBe(original)
    expect(harness.store.commits).toHaveLength(0)
    harness.controller.dispose()
  })

  test('rejects locked targets, id exhaustion, and exact effect budget without history', () => {
    const locked = setup({
      document: documentWith([clip([])], true),
      createEffectId: () => 'fx_locked',
    })
    expect(locked.controller.addPluginEffect({
      ...requestGenerations(locked.controller),
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('locked')

    const collision = setup({ createEffectId: () => 'effect-plugin' })
    expect(collision.controller.addPluginEffect({
      ...requestGenerations(collision.controller),
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('id-unavailable')

    const saturatedEffects = Array.from(
      { length: EFFECT_STACK_LIMITS.maxEffectsPerClip },
      (_, index) => pluginEffect({ id: `effect-${index}` }),
    )
    const saturated = setup({
      document: documentWith([clip(saturatedEffects)]),
      createEffectId: () => 'fx_over_budget',
    })
    expect(saturated.controller.addPluginEffect({
      ...requestGenerations(saturated.controller),
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('budget-exceeded')

    expect(locked.store.commits).toHaveLength(0)
    expect(collision.store.commits).toHaveLength(0)
    expect(saturated.store.commits).toHaveLength(0)
    locked.controller.dispose()
    collision.controller.dispose()
    saturated.controller.dispose()
  })

  test('fails stale document, catalog, ABA, same-reference, and mid-call drift closed', () => {
    const staleDocument = setup({ document: documentWith([clip([])]) })
    const staleRequest = requestGenerations(staleDocument.controller)
    staleDocument.store.replace({ ...staleDocument.store.document(), name: 'changed' })
    expect(staleDocument.controller.addPluginEffect({
      ...staleRequest,
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('stale-document')

    const original = staleDocument.store.document()
    const abaRequest = requestGenerations(staleDocument.controller)
    staleDocument.store.replace({ ...original, name: 'away' })
    staleDocument.store.replace(original)
    expect(staleDocument.controller.addPluginEffect({
      ...abaRequest,
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('stale-document')

    const sameReference = requestGenerations(staleDocument.controller)
    staleDocument.store.notifySameReference()
    expect(staleDocument.controller.addPluginEffect({
      ...sameReference,
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('stale-document')

    const staleCatalog = setup({ document: documentWith([clip([])]) })
    const catalogRequest = requestGenerations(staleCatalog.controller)
    staleCatalog.setPlugins({
      contribution: createPluginVideoEffectContributionSnapshot(8, [declaration()]),
    })
    expect(staleCatalog.controller.addPluginEffect({
      ...catalogRequest,
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('stale-catalog')

    let drift!: () => void
    const midCall = setup({
      document: documentWith([clip([])]),
      createEffectId: () => {
        drift()
        return 'fx_mid_call'
      },
    })
    drift = () => { midCall.setPlugins({}) }
    expect(midCall.controller.addPluginEffect({
      ...requestGenerations(midCall.controller),
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('stale-catalog')
    expect(midCall.store.commits).toHaveLength(0)

    let loseCas!: () => void
    const casLoss = setup({
      document: documentWith([clip([])]),
      createEffectId: () => {
        loseCas()
        return 'fx_cas_loss'
      },
    })
    loseCas = () => {
      casLoss.store.replace({ ...casLoss.store.document(), name: 'CAS winner' })
    }
    expect(casLoss.controller.addPluginEffect({
      ...requestGenerations(casLoss.controller),
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('stale-document')
    expect(casLoss.store.commits).toHaveLength(0)

    staleDocument.controller.dispose()
    staleCatalog.controller.dispose()
    midCall.controller.dispose()
    casLoss.controller.dispose()
  })

  test('returns a bounded fail-closed snapshot when coherent reads cannot settle', () => {
    const store = storeHarness()
    const documentController = createPluginDocumentGenerationController(store.store)
    let revision = 0
    const contribution = createPluginVideoEffectContributionSnapshot(7, [declaration()])
    const controller = createPluginEditorController({
      documentController,
      documentStore: store.store,
      readPlugins: () => Object.freeze({
        revision: ++revision,
        startupMode: 'normal' as const,
        catalogGeneration: 7,
        contributionSnapshot: contribution,
        installedPackages: Object.freeze([packageProjection()]),
      }),
    })

    expect(controller.getSnapshot()).toEqual(expect.objectContaining({
      coherent: false,
      effects: [],
      previewIssues: [],
    }))
    expectDeepFrozenData(controller.getSnapshot())
    controller.dispose()
  })

  test('publishes document and plugin changes, then disposes subscriptions and fails closed', () => {
    const harness = setup()
    const listener = vi.fn()
    harness.controller.subscribe(listener)
    harness.store.replace({ ...harness.store.document(), name: 'replacement' })
    harness.setPlugins({ startupMode: 'safe-mode' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(harness.controller.getSnapshot()).toMatchObject({
      documentGeneration: 1,
      effects: [{ status: 'safe-mode' }],
    })

    harness.controller.dispose()
    harness.controller.dispose()
    expect(harness.store.listeners.size).toBe(0)
    expect(harness.controller.addPluginEffect({
      documentGeneration: 1,
      catalogGeneration: 7,
      clipId: 'clip-1',
      effectType: EFFECT_TYPE,
    }).code).toBe('closed')
    expect(() => harness.controller.subscribe(vi.fn())).toThrow('closed')
  })

  test('attempts every terminal document cleanup once and preserves cleanup errors', () => {
    const document = documentWith()
    const contribution = createPluginVideoEffectContributionSnapshot(7, [declaration()])
    const readPlugins = (): PluginEditorPluginProjection => Object.freeze({
      revision: 1,
      startupMode: 'normal',
      catalogGeneration: 7,
      contributionSnapshot: contribution,
      installedPackages: Object.freeze([packageProjection()]),
    })
    const createController = (
      unsubscribeError: Error,
      documentDisposeError?: Error,
    ) => {
      const unsubscribeDocument = vi.fn(() => { throw unsubscribeError })
      const disposeDocument = vi.fn(() => {
        if (documentDisposeError) throw documentDisposeError
      })
      const documentStore: PluginDocumentStoreAdapter = {
        getState: () => ({ doc: document, setDocWithHistory: vi.fn() }),
        subscribe: vi.fn(() => unsubscribeDocument),
      }
      const documentController: PluginDocumentGenerationController = Object.freeze({
        getDocumentSnapshot: () => Object.freeze({ generation: 0, document }),
        commitDocument: vi.fn(() => false),
        dispose: disposeDocument,
      })
      return {
        controller: createPluginEditorController({
          readPlugins,
          documentController,
          documentStore,
        }),
        unsubscribeDocument,
        disposeDocument,
      }
    }

    const unsubscribeError = new Error('document unsubscribe failed')
    const single = createController(unsubscribeError)
    let singleFailure: unknown
    try {
      single.controller.dispose()
    } catch (error) {
      singleFailure = error
    }
    expect(singleFailure).toBe(unsubscribeError)
    expect(single.unsubscribeDocument).toHaveBeenCalledOnce()
    expect(single.disposeDocument).toHaveBeenCalledOnce()
    expect(() => single.controller.dispose()).not.toThrow()
    expect(single.unsubscribeDocument).toHaveBeenCalledOnce()
    expect(single.disposeDocument).toHaveBeenCalledOnce()

    const disposeError = new Error('document controller dispose failed')
    const multiple = createController(unsubscribeError, disposeError)
    let multipleFailure: unknown
    try {
      multiple.controller.dispose()
    } catch (error) {
      multipleFailure = error
    }
    expect(multipleFailure).toBeInstanceOf(AggregateError)
    expect((multipleFailure as AggregateError).errors).toEqual([
      unsubscribeError,
      disposeError,
    ])
    expect(multiple.unsubscribeDocument).toHaveBeenCalledOnce()
    expect(multiple.disposeDocument).toHaveBeenCalledOnce()
    expect(() => multiple.controller.dispose()).not.toThrow()
  })
})
