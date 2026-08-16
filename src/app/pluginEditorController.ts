/** App-owned plugin editor projection and atomic document mutation seam. */

import { effectAnimationTrack } from '../domain/clipAnimation'
import { effectAppendBudgetError, effectDescriptorBoundsError } from '../domain/effectBounds'
import { addEffect, updateEffectParams } from '../domain/operations'
import {
  createPluginVideoEffectContributionSnapshot,
  createVideoEffectStagePlanner,
  type PluginVideoEffectContributionDeclaration,
  type PluginVideoEffectContributionSnapshot,
  type PluginVideoEffectStage,
  type PluginVideoEffectStageStatus,
} from '../domain/pluginVideoEffectStagePlan'
import type {
  Clip,
  EffectDescriptor,
  EffectParamValue,
  TimelineDoc,
} from '../domain/schema'
import {
  createPluginDocumentGenerationController,
  type PluginDocumentGenerationController,
  type PluginDocumentStoreAdapter,
} from './pluginDocumentGeneration'
import { useDocumentStore } from '../state/documentStore'

const MAX_PUBLIC_DETAIL_CHARACTERS = 512
const COHERENT_READ_ATTEMPTS = 3
const EFFECT_ID_ATTEMPTS = 4

export interface PluginAppEditorActionView {
  readonly available: boolean
  readonly disabledReason: string | null
  readonly pending: boolean
  readonly error: string | null
}

export type PluginAppParameterFieldState = 'editable' | 'disabled' | 'locked'

interface PluginAppParameterFieldBaseView {
  readonly key: string
  readonly name: string
  readonly state: PluginAppParameterFieldState
  readonly stateReason: string | null
}

export interface PluginAppNumberParameterFieldView
  extends PluginAppParameterFieldBaseView {
  readonly kind: 'number'
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly animatable: boolean
}

export interface PluginAppBooleanParameterFieldView
  extends PluginAppParameterFieldBaseView {
  readonly kind: 'boolean'
  readonly value: boolean
}

export interface PluginAppEnumParameterFieldView
  extends PluginAppParameterFieldBaseView {
  readonly kind: 'enum'
  readonly value: string
  readonly options: readonly {
    readonly value: string
    readonly name: string
  }[]
}

export type PluginAppParameterFieldView =
  | PluginAppNumberParameterFieldView
  | PluginAppBooleanParameterFieldView
  | PluginAppEnumParameterFieldView

export interface PluginAppEffectIdentityView {
  readonly pluginId: string | null
  readonly pluginName: string | null
  readonly pluginVersion: string | null
  readonly packageDigest: string | null
}

export interface PluginAppEffectActionsView {
  readonly retry: PluginAppEditorActionView
  readonly disable: PluginAppEditorActionView
  readonly manage: PluginAppEditorActionView
}

export interface PluginAppEffectView extends PluginAppEffectIdentityView {
  readonly clipId: string
  readonly effectInstanceId: string
  readonly effectType: string
  readonly effectLabel: string
  readonly status: PluginVideoEffectStageStatus
  readonly reason: string
  readonly blocksExport: boolean
  readonly parameters: readonly PluginAppParameterFieldView[]
  readonly actions: PluginAppEffectActionsView
}

export interface PluginAppPreviewIssueView extends PluginAppEffectIdentityView {
  readonly effectInstanceId: string
  readonly effectLabel: string
  readonly status: PluginVideoEffectStageStatus
  readonly reason: string
  readonly blocksExport: true
  readonly actions: {
    readonly retry: PluginAppEditorActionView
    readonly disable: PluginAppEditorActionView
  }
}

export interface PluginAppEditorSnapshot {
  readonly coherent: boolean
  readonly detail: string
  readonly documentGeneration: number
  readonly catalogGeneration: number | null
  readonly effects: readonly PluginAppEffectView[]
  readonly previewIssues: readonly PluginAppPreviewIssueView[]
  readonly manageAction: PluginAppEditorActionView
}

export interface PluginAppAddEffectRequest {
  readonly documentGeneration: number
  readonly catalogGeneration: number
  readonly clipId: string
  readonly effectType: string
}

export interface PluginAppSetParameterRequest {
  readonly documentGeneration: number
  readonly catalogGeneration: number
  readonly clipId: string
  readonly effectInstanceId: string
  readonly key: string
  readonly value: EffectParamValue
}

export type PluginAppEditorMutationCode =
  | 'applied'
  | 'closed'
  | 'stale-document'
  | 'stale-catalog'
  | 'invalid-target'
  | 'unavailable'
  | 'locked'
  | 'budget-exceeded'
  | 'invalid-parameter'
  | 'animated-parameter'
  | 'id-unavailable'
  | 'no-change'

export interface PluginAppEditorMutationResult {
  readonly status: 'applied' | 'rejected'
  readonly code: PluginAppEditorMutationCode
  readonly detail: string
  readonly documentGeneration: number
}

export interface PluginEditorInstalledPackageProjection {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly packageDigest: string
  readonly actions: {
    readonly retry: PluginAppEditorActionView
    readonly disable: PluginAppEditorActionView
  }
}

export interface PluginEditorPluginProjection {
  readonly revision: number
  readonly catalogGeneration: number | null
  readonly startupMode: 'normal' | 'review-required' | 'safe-mode'
  readonly contributionSnapshot: PluginVideoEffectContributionSnapshot | undefined
  readonly installedPackages: readonly PluginEditorInstalledPackageProjection[]
}

export interface PluginEditorController {
  getSnapshot(): PluginAppEditorSnapshot
  subscribe(listener: (snapshot: PluginAppEditorSnapshot) => void): () => void
  addPluginEffect(request: PluginAppAddEffectRequest): PluginAppEditorMutationResult
  setPluginEffectParameter(
    request: PluginAppSetParameterRequest,
  ): PluginAppEditorMutationResult
  refresh(): void
  dispose(): void
}

export interface PluginEditorControllerDependencies {
  readonly readPlugins: () => PluginEditorPluginProjection
  readonly documentController?: PluginDocumentGenerationController
  readonly documentStore?: PluginDocumentStoreAdapter
  readonly createEffectId?: () => string
}

export type PluginEditorControllerFactory = (
  readPlugins: () => PluginEditorPluginProjection,
) => PluginEditorController

function boundedDetail(value: string): string {
  return value.length <= MAX_PUBLIC_DETAIL_CHARACTERS
    ? value
    : `${value.slice(0, MAX_PUBLIC_DETAIL_CHARACTERS - 1)}\u2026`
}

function freezeAction(source: PluginAppEditorActionView): PluginAppEditorActionView {
  return Object.freeze({
    available: source.available,
    disabledReason: source.disabledReason === null
      ? null
      : boundedDetail(source.disabledReason),
    pending: source.pending,
    error: source.error === null ? null : boundedDetail(source.error),
  })
}

const MANAGE_ACTION = Object.freeze({
  available: true,
  disabledReason: null,
  pending: false,
  error: null,
})

const MISSING_ACTION = Object.freeze({
  available: false,
  disabledReason: 'The installed plugin identity is unavailable.',
  pending: false,
  error: null,
})

function defaultEffectId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('Secure effect ids are unavailable')
  }
  return `fx_${globalThis.crypto.randomUUID()}`
}

function rejected(
  code: Exclude<PluginAppEditorMutationCode, 'applied'>,
  detail: string,
  generation: number,
): PluginAppEditorMutationResult {
  return Object.freeze({
    status: 'rejected',
    code,
    detail: boundedDetail(detail),
    documentGeneration: generation,
  })
}

function applied(generation: number): PluginAppEditorMutationResult {
  return Object.freeze({
    status: 'applied',
    code: 'applied',
    detail: '',
    documentGeneration: generation,
  })
}

function locateClip(document: TimelineDoc, clipId: string): {
  readonly clip: Clip
  readonly locked: boolean
  readonly trackKind: 'video' | 'audio'
} | null {
  for (const track of document.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId)
    if (clip) return Object.freeze({ clip, locked: track.locked, trackKind: track.kind })
  }
  return null
}

function effectIdExists(document: TimelineDoc, effectId: string): boolean {
  return document.tracks.some((track) => track.clips.some((clip) => (
    clip.effects.some((effect) => effect.id === effectId)
  )))
}

function declarationMap(
  snapshot: PluginVideoEffectContributionSnapshot | undefined,
): ReadonlyMap<string, PluginVideoEffectContributionDeclaration> {
  return new Map(snapshot?.declarations.map((declaration) => [
    declaration.effectType,
    declaration,
  ]) ?? [])
}

function effectiveContributionSnapshot(
  plugin: PluginEditorPluginProjection,
): PluginVideoEffectContributionSnapshot | undefined {
  const source = plugin.contributionSnapshot
  if (!source || plugin.startupMode !== 'safe-mode') return source
  return createPluginVideoEffectContributionSnapshot(
    source.catalogGeneration,
    source.declarations.map((declaration) => Object.freeze({
      ...declaration,
      availability: 'safe-mode' as const,
      detail: 'Plugin execution is disabled for this editor session.',
    })),
  )
}

function validParameterValue(
  declaration: PluginVideoEffectContributionDeclaration['parameters'][number],
  value: unknown,
): value is EffectParamValue {
  if (declaration.kind === 'number') {
    return typeof value === 'number'
      && Number.isFinite(value)
      && value >= declaration.min
      && value <= declaration.max
  }
  if (declaration.kind === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string'
    && declaration.options.some((option) => option.value === value)
}

function fieldState(
  clip: Clip,
  effect: EffectDescriptor,
  declaration: PluginVideoEffectContributionDeclaration,
  parameter: PluginVideoEffectContributionDeclaration['parameters'][number],
  locked: boolean,
): { readonly state: PluginAppParameterFieldState; readonly reason: string | null } {
  if (locked) return Object.freeze({ state: 'locked', reason: 'The owning track is locked.' })
  if (effect.version !== declaration.descriptorVersion) {
    return Object.freeze({
      state: 'locked',
      reason: 'Update the effect descriptor before editing its parameters.',
    })
  }
  if (effectAnimationTrack(clip.animation ?? { tracks: [] }, effect.id, parameter.key)) {
    return Object.freeze({
      state: 'locked',
      reason: 'This parameter is animated and cannot be changed by the static editor.',
    })
  }
  if (!effect.enabled) {
    return Object.freeze({ state: 'disabled', reason: 'Enable the effect to edit this parameter.' })
  }
  return Object.freeze({ state: 'editable', reason: null })
}

function parameterFields(
  clip: Clip,
  effect: EffectDescriptor,
  declaration: PluginVideoEffectContributionDeclaration | undefined,
  locked: boolean,
): readonly PluginAppParameterFieldView[] {
  if (!declaration) return Object.freeze([])
  return Object.freeze(declaration.parameters.map((parameter) => {
    const state = fieldState(clip, effect, declaration, parameter, locked)
    const storedValue = effect.params[parameter.key]
    const value = validParameterValue(parameter, storedValue)
      ? storedValue
      : parameter.default
    const invalidReason = storedValue === undefined || validParameterValue(parameter, storedValue)
      ? state.reason
      : 'The stored value is invalid; choosing a valid value will replace it.'
    if (parameter.kind === 'number') {
      return Object.freeze({
        key: parameter.key,
        name: parameter.name,
        kind: 'number' as const,
        value: value as number,
        min: parameter.min,
        max: parameter.max,
        step: parameter.step,
        animatable: parameter.animatable,
        state: state.state,
        stateReason: invalidReason,
      })
    }
    if (parameter.kind === 'boolean') {
      return Object.freeze({
        key: parameter.key,
        name: parameter.name,
        kind: 'boolean' as const,
        value: value as boolean,
        state: state.state,
        stateReason: invalidReason,
      })
    }
    return Object.freeze({
      key: parameter.key,
      name: parameter.name,
      kind: 'enum' as const,
      value: value as string,
      options: Object.freeze(parameter.options.map((option) => Object.freeze({
        value: option.value,
        name: option.name,
      }))),
      state: state.state,
      stateReason: invalidReason,
    })
  }))
}

function packageActions(
  plugin: PluginEditorPluginProjection,
  declaration: PluginVideoEffectContributionDeclaration | undefined,
): PluginAppEffectActionsView {
  const installed = declaration
    ? plugin.installedPackages.find((candidate) => (
        candidate.id === declaration.pluginId
        && candidate.version === declaration.pluginVersion
        && candidate.packageDigest === declaration.packageDigest
      ))
    : undefined
  return Object.freeze({
    retry: installed ? freezeAction(installed.actions.retry) : MISSING_ACTION,
    disable: installed ? freezeAction(installed.actions.disable) : MISSING_ACTION,
    manage: MANAGE_ACTION,
  })
}

function effectView(
  plugin: PluginEditorPluginProjection,
  clip: Clip,
  effect: EffectDescriptor,
  stage: PluginVideoEffectStage,
  declaration: PluginVideoEffectContributionDeclaration | undefined,
  locked: boolean,
): PluginAppEffectView {
  const installed = declaration
    ? plugin.installedPackages.find((candidate) => (
        candidate.id === declaration.pluginId
        && candidate.version === declaration.pluginVersion
        && candidate.packageDigest === declaration.packageDigest
      ))
    : undefined
  const actions = packageActions(plugin, declaration)
  return Object.freeze({
    clipId: clip.id,
    effectInstanceId: effect.id,
    effectType: effect.type,
    effectLabel: stage.label,
    pluginId: declaration?.pluginId ?? null,
    pluginName: installed?.name ?? null,
    pluginVersion: declaration?.pluginVersion ?? null,
    packageDigest: declaration?.packageDigest ?? null,
    status: stage.status,
    reason: boundedDetail(stage.detail),
    blocksExport: effect.enabled && stage.status !== 'ready',
    parameters: parameterFields(clip, effect, declaration, locked),
    actions,
  })
}

function buildSnapshot(
  documentGeneration: number,
  document: TimelineDoc,
  plugin: PluginEditorPluginProjection,
): PluginAppEditorSnapshot {
  const contributionSnapshot = effectiveContributionSnapshot(plugin)
  const declarations = declarationMap(plugin.contributionSnapshot)
  const planner = createVideoEffectStagePlanner(contributionSnapshot)
  const effects: PluginAppEffectView[] = []
  const previewIssues: PluginAppPreviewIssueView[] = []
  for (const track of document.tracks) {
    for (const clip of track.clips) {
      const plan = planner.planClip(clip, clip.timelineRange.startFrame)
      if (!plan) continue
      for (let index = 0; index < clip.effects.length; index++) {
        const effect = clip.effects[index]
        if (!effect.type.startsWith('plugin:')) continue
        const stage = plan.stages[index]
        if (!stage || stage.kind !== 'plugin') continue
        const view = effectView(
          plugin,
          clip,
          effect,
          stage,
          declarations.get(effect.type),
          track.locked,
        )
        effects.push(view)
        if (view.blocksExport) {
          previewIssues.push(Object.freeze({
            effectInstanceId: view.effectInstanceId,
            effectLabel: view.effectLabel,
            pluginId: view.pluginId,
            pluginName: view.pluginName,
            pluginVersion: view.pluginVersion,
            packageDigest: view.packageDigest,
            status: view.status,
            reason: view.reason,
            blocksExport: true as const,
            actions: Object.freeze({
              retry: view.actions.retry,
              disable: view.actions.disable,
            }),
          }))
        }
      }
    }
  }
  return Object.freeze({
    coherent: true,
    detail: '',
    documentGeneration,
    catalogGeneration: plugin.catalogGeneration,
    effects: Object.freeze(effects),
    previewIssues: Object.freeze(previewIssues),
    manageAction: MANAGE_ACTION,
  })
}

function incoherentSnapshot(
  documentGeneration: number,
  catalogGeneration: number | null,
): PluginAppEditorSnapshot {
  return Object.freeze({
    coherent: false,
    detail: 'Plugin editor state changed while it was being read; try again.',
    documentGeneration,
    catalogGeneration,
    effects: Object.freeze([]),
    previewIssues: Object.freeze([]),
    manageAction: MANAGE_ACTION,
  })
}

export function createPluginEditorController(
  dependencies: PluginEditorControllerDependencies,
): PluginEditorController {
  const documentStore = dependencies.documentStore ?? useDocumentStore
  const documentController = dependencies.documentController
    ?? createPluginDocumentGenerationController(documentStore)
  const createEffectId = dependencies.createEffectId ?? defaultEffectId
  const listeners = new Set<(snapshot: PluginAppEditorSnapshot) => void>()
  let closed = false
  let snapshot: PluginAppEditorSnapshot

  const readCoherentSnapshot = (): PluginAppEditorSnapshot => {
    let latestDocument = documentController.getDocumentSnapshot()
    let latestPlugin = dependencies.readPlugins()
    for (let attempt = 0; attempt < COHERENT_READ_ATTEMPTS; attempt++) {
      const candidate = buildSnapshot(
        latestDocument.generation,
        latestDocument.document,
        latestPlugin,
      )
      const nextDocument = documentController.getDocumentSnapshot()
      const nextPlugin = dependencies.readPlugins()
      if (
        nextDocument.generation === latestDocument.generation
        && nextDocument.document === latestDocument.document
        && nextPlugin.revision === latestPlugin.revision
        && nextPlugin.catalogGeneration === latestPlugin.catalogGeneration
        && nextPlugin.startupMode === latestPlugin.startupMode
        && nextPlugin.contributionSnapshot === latestPlugin.contributionSnapshot
      ) return candidate
      latestDocument = nextDocument
      latestPlugin = nextPlugin
    }
    return incoherentSnapshot(latestDocument.generation, latestPlugin.catalogGeneration)
  }

  const publish = (): void => {
    if (closed) return
    snapshot = readCoherentSnapshot()
    for (const listener of listeners) listener(snapshot)
  }

  snapshot = readCoherentSnapshot()
  const unsubscribeDocument = documentStore.subscribe(() => { publish() })

  const currentGeneration = (): number => documentController.getDocumentSnapshot().generation

  const validateGenerations = (
    documentGeneration: number,
    catalogGeneration: number,
  ): {
    readonly document: ReturnType<PluginDocumentGenerationController['getDocumentSnapshot']>
    readonly plugin: PluginEditorPluginProjection
  } | PluginAppEditorMutationResult => {
    const document = documentController.getDocumentSnapshot()
    if (document.generation !== documentGeneration) {
      return rejected(
        'stale-document',
        'The project changed; use the current editor view and try again.',
        document.generation,
      )
    }
    const plugin = dependencies.readPlugins()
    if (
      plugin.catalogGeneration !== catalogGeneration
      || plugin.contributionSnapshot?.catalogGeneration !== catalogGeneration
    ) {
      return rejected(
        'stale-catalog',
        'Installed plugin declarations changed; use the current editor view and try again.',
        document.generation,
      )
    }
    return Object.freeze({ document, plugin })
  }

  const commit = (
    current: ReturnType<PluginDocumentGenerationController['getDocumentSnapshot']>,
    plugin: PluginEditorPluginProjection,
    nextDocument: TimelineDoc,
  ): PluginAppEditorMutationResult => {
    if (nextDocument === current.document) {
      return rejected('no-change', 'The requested edit made no project change.', current.generation)
    }
    const latestPlugin = dependencies.readPlugins()
    if (
      latestPlugin.revision !== plugin.revision
      || latestPlugin.catalogGeneration !== plugin.catalogGeneration
      || latestPlugin.contributionSnapshot !== plugin.contributionSnapshot
    ) {
      return rejected(
        'stale-catalog',
        'Installed plugin declarations changed before the edit could commit.',
        currentGeneration(),
      )
    }
    if (!documentController.commitDocument(
      current.generation,
      current.document,
      nextDocument,
    )) {
      return rejected(
        'stale-document',
        'The project changed before the edit could commit.',
        currentGeneration(),
      )
    }
    return applied(currentGeneration())
  }

  const controller: PluginEditorController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (closed) throw new Error('Plugin editor controller is closed')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    addPluginEffect(request) {
      if (closed) return rejected('closed', 'Plugin editor is closed.', currentGeneration())
      const validated = validateGenerations(
        request.documentGeneration,
        request.catalogGeneration,
      )
      if ('status' in validated) return validated
      const { document, plugin } = validated
      const located = locateClip(document.document, request.clipId)
      if (!located) {
        return rejected('invalid-target', 'The target clip is unavailable.', document.generation)
      }
      if (located.locked) {
        return rejected('locked', 'The owning track is locked.', document.generation)
      }
      if (located.trackKind !== 'video') {
        return rejected(
          'invalid-target',
          'Video plugin effects can be added only to video clips.',
          document.generation,
        )
      }
      const declaration = effectiveContributionSnapshot(plugin)?.declarations.find(
        (candidate) => candidate.effectType === request.effectType,
      )
      if (!declaration || declaration.availability !== 'ready') {
        return rejected(
          'unavailable',
          'The selected plugin contribution is not ready.',
          document.generation,
        )
      }
      let descriptor: EffectDescriptor | null = null
      for (let attempt = 0; attempt < EFFECT_ID_ATTEMPTS; attempt++) {
        let id: string
        try {
          id = createEffectId()
        } catch {
          return rejected(
            'id-unavailable',
            'A secure effect identity could not be created.',
            document.generation,
          )
        }
        const candidate: EffectDescriptor = {
          id,
          type: declaration.effectType,
          version: declaration.descriptorVersion,
          enabled: true,
          params: Object.fromEntries(declaration.parameters.map((parameter) => [
            parameter.key,
            parameter.default,
          ])),
        }
        if (effectDescriptorBoundsError(candidate) || effectIdExists(document.document, id)) {
          continue
        }
        descriptor = candidate
        break
      }
      if (!descriptor) {
        return rejected(
          'id-unavailable',
          'A unique effect identity could not be created.',
          document.generation,
        )
      }
      if (effectAppendBudgetError(document.document, located.clip, descriptor)) {
        return rejected(
          'budget-exceeded',
          'The project effect budget cannot accept this contribution.',
          document.generation,
        )
      }
      return commit(
        document,
        plugin,
        addEffect(document.document, located.clip.id, descriptor),
      )
    },
    setPluginEffectParameter(request) {
      if (closed) return rejected('closed', 'Plugin editor is closed.', currentGeneration())
      const validated = validateGenerations(
        request.documentGeneration,
        request.catalogGeneration,
      )
      if ('status' in validated) return validated
      const { document, plugin } = validated
      const located = locateClip(document.document, request.clipId)
      if (!located) {
        return rejected('invalid-target', 'The target clip is unavailable.', document.generation)
      }
      if (located.locked) {
        return rejected('locked', 'The owning track is locked.', document.generation)
      }
      const effect = located.clip.effects.find(
        (candidate) => candidate.id === request.effectInstanceId,
      )
      if (!effect || !effect.type.startsWith('plugin:')) {
        return rejected('invalid-target', 'The plugin effect is unavailable.', document.generation)
      }
      const declaration = plugin.contributionSnapshot?.declarations.find(
        (candidate) => candidate.effectType === effect.type,
      )
      if (!declaration || effect.version !== declaration.descriptorVersion) {
        return rejected(
          'unavailable',
          'The installed declaration does not match this effect descriptor.',
          document.generation,
        )
      }
      const parameter = declaration.parameters.find((candidate) => candidate.key === request.key)
      if (!parameter || !validParameterValue(parameter, request.value)) {
        return rejected(
          'invalid-parameter',
          'The parameter value does not match the installed declaration.',
          document.generation,
        )
      }
      if (effectAnimationTrack(
        located.clip.animation ?? { tracks: [] },
        effect.id,
        parameter.key,
      )) {
        return rejected(
          'animated-parameter',
          'Animated plugin parameters cannot be changed by the static editor.',
          document.generation,
        )
      }
      return commit(
        document,
        plugin,
        updateEffectParams(document.document, located.clip.id, effect.id, {
          [parameter.key]: request.value,
        }),
      )
    },
    refresh: publish,
    dispose() {
      if (closed) return
      closed = true
      listeners.clear()
      unsubscribeDocument()
      documentController.dispose()
    },
  }
  return Object.freeze(controller)
}
