import { describe, expect, test, vi } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import {
  canonicalPluginVideoEffectParameterJson,
  createPluginVideoEffectContributionSnapshot,
  type PluginVideoEffectContributionDeclarationInput,
} from '../domain/pluginVideoEffectStagePlan'
import type { PluginParameter } from '../domain/pluginManifest'
import type { Clip, EffectDescriptor, TimelineDoc } from '../domain/schema'
import type {
  PluginDescriptorMigrationChainRequest,
} from './pluginRuntimeController'
import { PluginRuntimeError } from './pluginRuntimeController'
import {
  createPluginDescriptorMigrationController,
  type PluginDescriptorMigrationRuntime,
} from './pluginDescriptorMigrationController'

const SIGNER = `sha256:${'1'.repeat(64)}`
const PACKAGE = `sha256:${'2'.repeat(64)}`
const STRENGTH_PARAMETER = Object.freeze({
  key: 'strength',
  name: 'Strength',
  kind: 'number' as const,
  default: 0.5,
  min: 0,
  max: 1,
  step: 0.05,
  animatable: true,
})

function declaration(
  contributionId: string,
  availability: PluginVideoEffectContributionDeclarationInput['availability'] = 'ready',
  parameters: readonly PluginParameter[] = [STRENGTH_PARAMETER],
): PluginVideoEffectContributionDeclarationInput {
  return {
    signerFingerprint: SIGNER,
    packageDigest: PACKAGE,
    pluginId: 'com.example.migrate',
    pluginVersion: '2.0.0',
    kind: 'video-effect',
    contributionVersion: 1,
    contributionId,
    contributionName: contributionId === 'sparkle' ? 'Sparkle' : 'Glow',
    descriptorVersion: 2,
    entrypoint: `myrelith_effect_${contributionId}`,
    parameters,
    availability,
    detail: availability === 'ready' ? 'Ready.' : 'Unavailable.',
  }
}

function effect(
  id: string,
  contributionId: string,
  params: EffectDescriptor['params'] = { strength: 0.5 },
): EffectDescriptor {
  return {
    id,
    type: `plugin:com.example.migrate/${contributionId}`,
    version: 1,
    enabled: contributionId === 'sparkle',
    params,
  }
}

function clip(
  id: string,
  effects: EffectDescriptor[],
  animatedEffectId?: string,
): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
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
      effectTracks: animatedEffectId ? [{
        effectId: animatedEffectId,
        parameter: 'strength',
        keyframes: [{ frame: 0, value: 0.5, easing: { type: 'linear' as const } }],
      }] : [],
    },
    effects,
  }
}

function documentWith(clips: Clip[]): TimelineDoc {
  const empty = createTimelineDoc('Plugin migration', DEFAULT_PROJECT_SETTINGS, 'doc-migrate')
  return {
    ...empty,
    tracks: empty.tracks.map((track, index) => (
      index === 0 ? { ...track, clips } : track
    )),
  }
}

interface RuntimeHarness {
  readonly runtime: PluginDescriptorMigrationRuntime
  readonly preflights: PluginDescriptorMigrationChainRequest[][]
  readonly opens: PluginDescriptorMigrationChainRequest[]
  readonly applies: string[]
  readonly actionCloses: string[]
}

function runtimeHarness(options: {
  failContribution?: string
  preflightFailureContribution?: string
  preflightBusy?: boolean
  onApply?: (contributionId: string) => void
  actionCloseFailure?: boolean
  invalidCanonical?: boolean
  resultFor?: (
    request: PluginDescriptorMigrationChainRequest,
  ) => Readonly<Record<string, boolean | number | string>>
} = {}): RuntimeHarness {
  const preflights: PluginDescriptorMigrationChainRequest[][] = []
  const opens: PluginDescriptorMigrationChainRequest[] = []
  const applies: string[] = []
  const actionCloses: string[] = []
  return {
    preflights,
    opens,
    applies,
    actionCloses,
    runtime: {
      async preflightDescriptorMigrationAction({ targets }) {
        preflights.push([...targets])
        if (options.preflightBusy) {
          throw new PluginRuntimeError({
            code: 'busy',
            message: 'No migration slot is available.',
            terminal: false,
          })
        }
        if (targets.some((request) => (
          request.contributionId === options.preflightFailureContribution
        ))) throw new Error('later chain failed preflight')
        return {
          async applyTarget({ targetIndex }) {
            const request = targets[targetIndex]
            if (!request) throw new Error('invalid preflight index')
            opens.push(request)
            applies.push(request.contributionId)
            options.onApply?.(request.contributionId)
            if (options.failContribution === request.contributionId) {
              return {
                status: 'failed',
                failure: {
                  code: 'plugin-failure',
                  message: 'host-authored failure',
                  terminal: true,
                }
              }
            }
            const parameters = options.resultFor?.(request) ?? {
              strength: request.contributionId === 'sparkle' ? 0.75 : 0.25,
            }
            const canonicalParameterJson = canonicalPluginVideoEffectParameterJson(parameters)
            return {
              status: 'migrated',
              descriptorVersion: 2,
              canonicalParameterJson: options.invalidCanonical
                ? '{"strength":0.5}'
                : canonicalParameterJson,
              parameters,
            }
          },
          async close(reason) {
            actionCloses.push(reason)
            if (options.actionCloseFailure) throw new Error('action close failed')
          },
        }
      },
    },
  }
}

function setup(options: {
  doc?: TimelineDoc
  runtime?: RuntimeHarness
  documentGeneration?: number
  catalogGeneration?: number
  declarations?: readonly PluginVideoEffectContributionDeclarationInput[]
  unavailable?: string
  rejectCommit?: boolean
} = {}) {
  let currentDocument = options.doc ?? documentWith([
    clip('first', [effect('effect-sparkle', 'sparkle')]),
    clip('second', [effect('effect-glow', 'glow')]),
  ])
  let documentGeneration = options.documentGeneration ?? 3
  let catalogGeneration = options.catalogGeneration ?? 7
  const runtime = options.runtime ?? runtimeHarness()
  const commit = vi.fn((
    expectedGeneration: number,
    expectedDocument: TimelineDoc,
    next: TimelineDoc,
  ) => {
    if (
      options.rejectCommit
      || expectedGeneration !== documentGeneration
      || expectedDocument !== currentDocument
    ) return false
    currentDocument = next
    documentGeneration += 1
    return true
  })
  const getSnapshot = () => createPluginVideoEffectContributionSnapshot(
    catalogGeneration,
    options.declarations ?? [
      declaration('sparkle', options.unavailable === 'sparkle' ? 'revoked' : 'ready'),
      declaration('glow', options.unavailable === 'glow' ? 'revoked' : 'ready'),
    ],
  )
  const controller = createPluginDescriptorMigrationController({
    getDocumentSnapshot: () => ({ generation: documentGeneration, document: currentDocument }),
    getContributionSnapshot: getSnapshot,
    runtime: runtime.runtime,
    commitDocument: commit,
  })
  return {
    controller,
    runtime,
    commit,
    document: () => currentDocument,
    documentGeneration: () => documentGeneration,
    replaceDocument: (doc: TimelineDoc) => {
      currentDocument = doc
      documentGeneration += 1
    },
    mutateDocumentWithoutGeneration: (mutate: (doc: TimelineDoc) => void) => {
      mutate(currentDocument)
    },
    advanceCatalogGeneration: () => { catalogGeneration += 1 },
  }
}

describe('plugin descriptor migration controller', () => {
  test('preflights every exact chain, runs fresh chains in document order, and CAS-commits once', async () => {
    const harness = setup()
    const original = harness.document()
    const animations = original.tracks[0].clips.map((item) => item.animation)

    await expect(harness.controller.migrate({
      effectIds: ['effect-glow', 'effect-sparkle'],
    })).resolves.toEqual({
      status: 'migrated',
      effectIds: ['effect-sparkle', 'effect-glow'],
    })

    expect(harness.runtime.preflights).toHaveLength(1)
    expect(harness.runtime.preflights[0]).toEqual([
      {
        descriptorId: 'effect-sparkle',
        catalogGeneration: 7,
        pluginId: 'com.example.migrate',
        pluginVersion: '2.0.0',
        packageDigest: PACKAGE,
        signerFingerprint: SIGNER,
        kind: 'video-effect',
        contributionId: 'sparkle',
        contributionVersion: 1,
        descriptorVersion: 2,
        entrypoint: 'myrelith_effect_sparkle',
        fromDescriptorVersion: 1,
        canonicalParameterJson: '{"strength":0.5}',
        hasAnimatedParameters: false,
      },
      {
        descriptorId: 'effect-glow',
        catalogGeneration: 7,
        pluginId: 'com.example.migrate',
        pluginVersion: '2.0.0',
        packageDigest: PACKAGE,
        signerFingerprint: SIGNER,
        kind: 'video-effect',
        contributionId: 'glow',
        contributionVersion: 1,
        descriptorVersion: 2,
        entrypoint: 'myrelith_effect_glow',
        fromDescriptorVersion: 1,
        canonicalParameterJson: '{"strength":0.5}',
        hasAnimatedParameters: false,
      },
    ])
    expect(harness.runtime.opens.map((request) => request.contributionId))
      .toEqual(['sparkle', 'glow'])
    expect(harness.runtime.actionCloses).toEqual(['migration-complete'])
    expect(harness.commit).toHaveBeenCalledOnce()
    expect(harness.commit).toHaveBeenCalledWith(3, original, harness.document())
    expect(harness.documentGeneration()).toBe(4)
    expect(original.tracks[0].clips[0].effects[0]).toMatchObject({
      version: 1,
      params: { strength: 0.5 },
    })
    expect(harness.document().tracks[0].clips[0].effects[0]).toMatchObject({
      version: 2,
      params: { strength: 0.75 },
    })
    expect(harness.document().tracks[0].clips[1].effects[0]).toMatchObject({
      version: 2,
      enabled: false,
      params: { strength: 0.25 },
    })
    expect(harness.document().tracks[0].clips.map((item) => item.animation))
      .toEqual(animations)
  })

  test('rejects animation and a later invalid chain before any plugin code', async () => {
    const animated = setup({
      doc: documentWith([
        clip('animated', [effect('effect-sparkle', 'sparkle')], 'effect-sparkle'),
      ]),
    })
    await expect(animated.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'animated-target' })
    expect(animated.runtime.preflights).toHaveLength(0)

    const runtime = runtimeHarness({ preflightFailureContribution: 'glow' })
    const invalidLater = setup({ runtime })
    await expect(invalidLater.controller.migrate({
      effectIds: ['effect-sparkle', 'effect-glow'],
    })).rejects.toMatchObject({ code: 'runtime-failed' })
    expect(runtime.preflights[0].map((request) => request.contributionId))
      .toEqual(['sparkle', 'glow'])
    expect(runtime.opens).toHaveLength(0)
    expect(runtime.applies).toHaveLength(0)
    expect(invalidLater.commit).not.toHaveBeenCalled()
  })

  test('maps action-slot contention to busy without opening a chain', async () => {
    const runtime = runtimeHarness({ preflightBusy: true })
    const harness = setup({ runtime })
    await expect(harness.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'busy' })
    expect(runtime.opens).toHaveLength(0)
    expect(runtime.applies).toHaveLength(0)
    expect(harness.commit).not.toHaveBeenCalled()
  })

  test('discards every staged result when a later chain fails', async () => {
    const runtime = runtimeHarness({ failContribution: 'glow' })
    const harness = setup({ runtime })
    const startingDocument = harness.document()
    await expect(harness.controller.migrate({
      effectIds: ['effect-sparkle', 'effect-glow'],
    })).rejects.toMatchObject({ code: 'runtime-failed' })
    expect(runtime.actionCloses).toEqual(['migration-failed'])
    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.document()).toBe(startingDocument)
  })

  test('rejects generation ABA, catalog changes, in-place target mutation, and CAS rejection', async () => {
    let aba: ReturnType<typeof setup>
    const abaRuntime = runtimeHarness({
      onApply: () => {
        const original = aba.document()
        aba.replaceDocument(documentWith([]))
        aba.replaceDocument(original)
      },
    })
    aba = setup({ runtime: abaRuntime })
    await expect(aba.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'stale' })
    expect(aba.commit).not.toHaveBeenCalled()

    let catalog: ReturnType<typeof setup>
    catalog = setup({ runtime: runtimeHarness({
      onApply: () => catalog.advanceCatalogGeneration(),
    }) })
    await expect(catalog.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'stale' })
    expect(catalog.commit).not.toHaveBeenCalled()

    let mutated: ReturnType<typeof setup>
    mutated = setup({ runtime: runtimeHarness({
      onApply: () => mutated.mutateDocumentWithoutGeneration((doc) => {
        doc.tracks[0].clips[0].effects[0].params.strength = 0.9
      }),
    }) })
    await expect(mutated.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'stale' })
    expect(mutated.commit).not.toHaveBeenCalled()

    const rejected = setup({ rejectCommit: true })
    await expect(rejected.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'stale' })
    expect(rejected.commit).toHaveBeenCalledOnce()
    expect(rejected.document().tracks[0].clips[0].effects[0].version).toBe(1)
  })

  test('validates aggregate budgets only on the completed staged document', async () => {
    const manyParameters = Array.from({ length: 64 }, (_, index) => ({
      key: `p${index}`,
      name: `P ${index}`,
      kind: 'boolean' as const,
      default: false,
    }))
    const singleParameter = [manyParameters[0]]
    const fullRecord = Object.fromEntries(manyParameters.map(({ key }) => [key, false]))
    const filler = Array.from({ length: 780 }, (_, index) => ({
      id: `filler-${index}`,
      type: 'plugin:com.example.filler/fill',
      version: 1,
      enabled: false,
      params: { ...fullRecord },
    } satisfies EffectDescriptor))
    const doc = documentWith([
      clip('budget-a', filler.slice(0, 256)),
      clip('budget-b', filler.slice(256, 512)),
      clip('budget-c', filler.slice(512, 768)),
      clip('budget-d', [
        ...filler.slice(768),
        effect('effect-grow', 'grow', { p0: false }),
        effect('effect-shrink', 'shrink', { ...fullRecord }),
      ]),
    ])
    const runtime = runtimeHarness({
      resultFor: (request) => request.contributionId === 'grow'
        ? fullRecord
        : { p0: false },
    })
    const harness = setup({
      doc,
      runtime,
      declarations: [
        declaration('grow', 'ready', manyParameters),
        declaration('shrink', 'ready', singleParameter),
      ],
    })
    await expect(harness.controller.migrate({
      effectIds: ['effect-grow', 'effect-shrink'],
    })).resolves.toMatchObject({ status: 'migrated' })
    expect(harness.commit).toHaveBeenCalledOnce()
  })

  test('fails closed on unavailable targets, invalid output, and duplicate ids', async () => {
    const unavailable = setup({ unavailable: 'sparkle' })
    await expect(unavailable.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(unavailable.runtime.preflights).toHaveLength(0)

    const invalid = setup({ runtime: runtimeHarness({ invalidCanonical: true }) })
    await expect(invalid.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'invalid-result' })
    expect(invalid.commit).not.toHaveBeenCalled()

    const duplicate = setup()
    await expect(duplicate.controller.migrate({
      effectIds: ['effect-sparkle', 'effect-sparkle'],
    })).rejects.toMatchObject({ code: 'invalid-target' })
    expect(duplicate.runtime.preflights).toHaveLength(0)
  })

  test('preserves primary failures while making success-only cleanup failure terminal', async () => {
    const cleanup = setup({ runtime: runtimeHarness({ actionCloseFailure: true }) })
    await expect(cleanup.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'cleanup-failed' })
    expect(cleanup.commit).not.toHaveBeenCalled()

    const combined = setup({ runtime: runtimeHarness({
      failContribution: 'sparkle',
      actionCloseFailure: true,
    }) })
    await expect(combined.controller.migrate({ effectIds: ['effect-sparkle'] }))
      .rejects.toMatchObject({ code: 'runtime-failed' })
    expect(combined.commit).not.toHaveBeenCalled()
  })

  test('cancellation, concurrent actions, and retry use fresh action reservations', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const runtime = runtimeHarness()
    runtime.runtime.preflightDescriptorMigrationAction = async ({ targets }) => {
      runtime.preflights.push([...targets])
      return {
        async applyTarget({ targetIndex }) {
          const request = targets[targetIndex]
          runtime.opens.push(request)
          runtime.applies.push(request.contributionId)
          await gate
          return {
            status: 'migrated',
            descriptorVersion: 2,
            canonicalParameterJson: '{"strength":0.75}',
            parameters: { strength: 0.75 },
          }
        },
        async close(reason) { runtime.actionCloses.push(reason) },
      }
    }
    const harness = setup({ runtime })
    const abort = new AbortController()
    const active = harness.controller.migrate({
      effectIds: ['effect-sparkle'],
      signal: abort.signal,
    })
    await vi.waitFor(() => expect(runtime.applies).toEqual(['sparkle']))
    await expect(harness.controller.migrate({ effectIds: ['effect-glow'] }))
      .rejects.toMatchObject({ code: 'busy' })
    abort.abort()
    release?.()
    await expect(active).rejects.toMatchObject({ code: 'aborted' })
    expect(harness.commit).not.toHaveBeenCalled()

    const retry = await harness.controller.migrate({ effectIds: ['effect-sparkle'] })
    expect(retry.status).toBe('migrated')
    expect(runtime.preflights).toHaveLength(2)
    expect(runtime.actionCloses).toEqual(['migration-failed', 'migration-complete'])
  })
})
