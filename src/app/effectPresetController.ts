import { captureEffectPreset, presetAttributeTemplate, type EffectPreset, type PresetLibraryMutation } from '../domain/effectPresets'
import { effectRegistration, registeredEffects, resolveEffectStack, type EffectCapability } from '../domain/effectStack'
import type { EffectDescriptor } from '../domain/schema'
import type { PreviewRendererCapabilities } from '../state/previewStatusStore'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useEffectPresetStore } from '../state/effectPresetStore'
import { applyAttributeEdit, type AttributeEditSession } from './clipAttributeController'
import { localEffectPresetStorage, type EffectPresetRepository } from './localEffectPresetStorage'

export interface PresetSaveSession { readonly generation: number; readonly preset: EffectPreset; readonly sourceName: string; readonly frame: number }
export function openPresetSave(clipId: string): PresetSaveSession {
  const state = useDocumentStore.getState()
  const track = state.doc.tracks.find((track) => track.clips.some((clip) => clip.id === clipId))
  const clip = track?.clips.find((clip) => clip.id === clipId)
  if (!clip || track?.kind !== 'video') throw new Error('Select a video clip to save its effects.')
  const frame = useTransportStore.getState().playheadFrame
  return { generation: state.projectGeneration, sourceName: clip.name, frame,
    preset: captureEffectPreset(clip, frame, crypto.randomUUID(), 'Untitled preset') }
}

export function createEffectPresetController(repository: EffectPresetRepository) {
  async function operation(work: () => ReturnType<EffectPresetRepository['load']>, message: string): Promise<boolean> {
    if (useEffectPresetStore.getState().busy) return false
    useEffectPresetStore.setState({ busy: true, error: null, message: '' })
    try {
      const view = await work()
      useEffectPresetStore.setState({ ...view, loaded: true, message })
      return true
    } catch (error) {
      useEffectPresetStore.setState({ error: error instanceof Error ? error.message : 'Local preset storage failed.' })
      return false
    } finally { useEffectPresetStore.setState({ busy: false }) }
  }
  return {
    load: () => operation(() => repository.load(), ''),
    save: (session: PresetSaveSession, name: string) => operation(() => repository.mutate(
      { kind: 'save', preset: { ...session.preset, name: name.trim() } },
      () => useDocumentStore.getState().projectGeneration === session.generation,
    ), 'Preset saved in this browser.'),
    edit: (mutation: Exclude<PresetLibraryMutation, { kind: 'save' }>) => operation(() => repository.mutate(mutation), mutation.kind === 'delete' ? 'Preset deleted. Applied copies are unchanged.' : 'Preset renamed.'),
  }
}
export const effectPresetController = createEffectPresetController(localEffectPresetStorage)

export function applyEffectTemplate(session: AttributeEditSession, effects: readonly EffectDescriptor[], mode: 'append' | 'replace'): string | null {
  return applyAttributeEdit({ ...session, groups: ['effects'], template: presetAttributeTemplate(effects) }, 'paste',
    { groups: ['effects'], includeAnimation: false, effectsMode: mode })
}
const descriptions: Record<string, string> = {
  'builtin.box-blur': 'Soften the picture with an alpha-aware box blur in project pixels.',
  'builtin.sharpen': 'Emphasize local detail while preserving source transparency.',
  'builtin.vignette': 'Darken the edges with a soft elliptical falloff.',
  'builtin.drop-shadow': 'Place a colored, blurred silhouette behind the picture.',
  'builtin.outline': 'Add a colored outer silhouette using a square neighborhood.',
  'builtin.color-adjust': 'Adjust exposure, contrast, saturation, temperature and tint.',
  'builtin.mask': 'Keep or hide a rectangle, ellipse or Bezier region with optional feathering.',
  'builtin.chroma-key': 'Remove a chosen color with soft edges and spill suppression.',
}
export function builtInEffectChoices() {
  return registeredEffects().map((registration) => ({
    label: registration.label, description: descriptions[registration.type] ?? registration.label,
    surfaces: registration.surfaces,
    effect: { id: 'template', type: registration.type, version: registration.version, enabled: true, params: { ...registration.defaultParams } },
  }))
}
export function presetEffectAvailability(preset: EffectPreset): string[] {
  return [...new Set(preset.effects.flatMap((effect) => {
    if (effect.type.startsWith('plugin:')) return [`${effect.type}: requires its installed, trusted plugin; current plugin status is listed below.`]
    const registration = effectRegistration(effect.type)
    if (!registration || registration.version !== effect.version) return [`${effect.type} v${effect.version}: unavailable; preserved and bypassed.`]
    const error = registration.validateParams(effect.params)
    return error ? [`${registration.label}: ${error}; preserved and bypassed.`] : []
  }))]
}

export function effectTemplatePreview(effects: readonly EffectDescriptor[], capabilities: PreviewRendererCapabilities | null): string[] {
  if (!capabilities) return ['Preview capabilities are still being checked. Export checks its own rendering context.']
  const available = new Set<EffectCapability>()
  if (capabilities.canvasFilter) available.add('canvas2d-filter')
  if (capabilities.canvasPixelAccess) available.add('canvas2d-pixel-access')
  return resolveEffectStack(effects.filter((effect) => !effect.type.startsWith('plugin:')), available)
    .map((result) => `${result.label}: ${result.status}. ${result.detail}`)
}

export function resetEffectGeometry(session: AttributeEditSession, group: 'transform' | 'crop-and-flip'): string | null {
  return applyAttributeEdit(session, 'reset', { groups: [group], includeAnimation: false, effectsMode: 'append' })
}
