/** Browser-only G2 proof harness. Never imported by a production entry. */
import { compositeFrame, clearTextLayoutCaches, type TransitionSurfaceProvider } from '../pipeline/render'
import { createProjectVideoCompositionPlanner } from '../domain/projectVideoCompositionPlan'
import { createVideoCompositionPlanner, type VideoCompositionPlan } from '../domain/videoCompositionPlan'
import { legacyTitleProject } from './titleOwnerFixtures'
import { upgradeLegacyTextTitle } from '../domain/titleUpgrade'
import { defaultSourceTimeMap } from '../domain/sourceTimeMap'
import { resolvePresentationProfile, type PresentationResolvedQuality } from '../domain/presentationProfile'
import { TEXT_FONT_FAMILIES } from '../domain/textOverlay'
import { createColorAdjustEffect, createMaskEffect } from '../domain/effectStack'
import { createBufferedExportResult, exportTimeline } from '../pipeline/export'
import { DEFAULT_EXPORT_PROFILE } from '../domain/exportProfile'
import { clipVisualSettings } from '../domain/clipInspector'
import { createCaptionTrack } from '../domain/captions'
import { readTitleDefinition, type TitleAnimationProperty } from '../domain/titleElements'
import { scalarKey } from './animationFoundationFixtures'
import { createAdjustmentItem } from '../domain/adjustmentItems'
import type { SequenceProject } from '../domain/projectSequences'
import type { Clip, ClipVisualSettings, TextFontFamily, TextProps, TimelineDoc, Transform } from '../domain/schema'

export { TEXT_FONT_FAMILIES }
export interface TitleProofCase {
  name: string
  text?: Partial<TextProps>
  transform?: Partial<Transform>
  visual?: Partial<ClipVisualSettings>
  opacity?: number
  blendMode?: Clip['blendMode']
  effects?: Clip['effects']
  caption?: boolean
}
const color = createColorAdjustEffect('color'); color.params.temperature = 0.2
const mask = createMaskEffect('mask', 'ellipse'); mask.params.width = 0.8
export const TITLE_PROOF_CASES: readonly TitleProofCase[] = [
  { name: 'plain' },
  { name: 'empty', text: { content: '' } },
  { name: 'whitespace', text: { content: '  first\t second\r\n\nlast  ' } },
  { name: 'long-word', text: { content: 'supercalifragilisticexpialidocious'.repeat(4) } },
  { name: 'scripts', text: { content: '日本語 中文 한글\nहिन्दी ภาษาไทย' } },
  { name: 'combining-emoji', text: { content: 'a\u0301 e\u0308 Z\u0351\u0357\u031d\n👩🏽‍💻 🏳️‍🌈 🧑‍🚀' } },
  { name: 'bidi', text: { content: 'Hello שלום 123\nمرحبا بالعالم ABC' } },
  { name: 'bold', text: { bold: true } },
  { name: 'italic', text: { italic: true } },
  { name: 'bold-italic', text: { bold: true, italic: true } },
  { name: 'left', text: { align: 'left' } },
  { name: 'right', text: { align: 'right' } },
  { name: 'fractional', text: { fontSizePx: 23.25, boxWidthPx: 231.5, boxHeightPx: 133.75, paddingPx: 5.125 }, transform: { x: 11.25, y: -7.5, scaleX: 0.875, scaleY: 1.125 } },
  { name: 'anchor-zero', transform: { anchorX: 0, anchorY: 0, rotation: 17 } },
  { name: 'anchor-one', transform: { anchorX: 1, anchorY: 1, rotation: -17 } },
  { name: 'zero-scale', transform: { scaleX: 0 } },
  { name: 'crop-flip', transform: { rotation: 21 }, visual: { flipHorizontal: true, flipVertical: true, crop: { left: 0.125, right: 0.05, top: 0.15, bottom: 0.075 } } },
  { name: 'background', text: { backgroundEnabled: true, backgroundColor: '#334455' } },
  { name: 'outline-shadow', text: { outlineEnabled: true, outlineWidthPx: 2.25, outlineColor: '#00ffcc', shadowEnabled: true, shadowBlurPx: 2.5, shadowOffsetXPx: 3.25, shadowOffsetYPx: -1.5, shadowColor: '#8844ff' } },
  { name: 'opacity-blend', opacity: 0.625, blendMode: 'screen' },
  { name: 'ordered-effects', effects: [mask, color], opacity: 0.75 },
  { name: 'caption-canary', caption: true },
]

export function titleProofProject(family: TextFontFamily, proof: TitleProofCase): SequenceProject {
  const project = legacyTitleProject(), doc = project.sequences[0], clip = doc.tracks[0].clips[0]
  project.sequences = [doc]
  doc.width = 320; doc.height = 180; doc.tracks = [doc.tracks[0]]
  clip.name = proof.name
  clip.sourceRange = { startFrame: 0, durationFrames: 1 }
  clip.sourceTimeMap = defaultSourceTimeMap(0, 1)
  clip.timelineRange = { startFrame: 0, durationFrames: 1 }
  clip.text = { ...clip.text!, content: 'Title 世界\nSecond line', fontFamily: family, fontSizePx: 24, boxWidthPx: 260, boxHeightPx: 150, paddingPx: 8, ...proof.text }
  clip.transform = { ...clip.transform, ...proof.transform }
  clip.visual = { ...clipVisualSettings(clip), ...proof.visual }
  clip.opacity = proof.opacity ?? 1
  if (proof.blendMode) clip.blendMode = proof.blendMode
  clip.effects = structuredClone(proof.effects ?? [])
  if (proof.caption) doc.captionTracks = [{ ...createCaptionTrack('caption', 'Caption canary'), items: [
    { id: 'cue', range: { startFrame: 0, durationFrames: 1 }, text: 'Caption שלום 👩🏽‍💻\nSecond caption line' },
  ] }]
  return project
}

export function animatedTitleProofProject(easing: 'linear' | 'hold' | 'cubic-bezier', nested = false): SequenceProject {
  const project = upgradeProofProject(titleProofProject('sans-serif', { name: `animation-${easing}`, text: { outlineEnabled: true, shadowEnabled: true, shadowColor: '#446688' } }))
  const doc = project.sequences[0], clip = doc.tracks[0].clips[0]
  clip.sourceRange = { startFrame: 0, durationFrames: 13 }; clip.sourceTimeMap = defaultSourceTimeMap(0, 13)
  clip.timelineRange = { startFrame: 0, durationFrames: 13 }
  const parsed = readTitleDefinition(clip.title)
  if (parsed.status !== 'supported') throw new Error('Expected proof title')
  const text = parsed.title.elements[0]
  clip.title = { version: 1, elements: [
    { id: 'card', name: 'Card', kind: 'rectangle', version: 1, enabled: true, opacity: 0.625, transform: clip.transform, visual: clip.visual!,
      shape: { boxWidthPx: 300, boxHeightPx: 160, fillColor: '#552244', outlineEnabled: true, outlineColor: '#99aabb', outlineWidthPx: 3 } },
    { ...text, opacity: 0.75 },
    { id: 'dot', name: 'Dot', kind: 'ellipse', version: 1, enabled: true, opacity: 0.5, transform: { ...clip.transform, x: 105, y: 40 }, visual: clip.visual!,
      shape: { boxWidthPx: 48, boxHeightPx: 32, fillColor: '#22ee88', outlineEnabled: false, outlineColor: '#ffffff', outlineWidthPx: 0 } },
  ] }
  const values: [TitleAnimationProperty, number, number][] = [
    ['position-x', -30, 25], ['position-y', -15, 20], ['scale-x', 0.75, 1.1], ['scale-y', 0.8, 1.05], ['rotation', -8, 11], ['opacity', 0.4, 0.8],
    ['box-width', 210, 280], ['box-height', 120, 155], ['font-size', 18, 27], ['outline-width', 0.5, 2.5], ['shadow-blur', 0, 3], ['shadow-offset-x', -2, 3], ['shadow-offset-y', -1, 2],
  ]
  const curve = easing === 'cubic-bezier' ? { type: easing, x1: 0.25, y1: 0.1, x2: 0.75, y2: 0.9 } as const : { type: easing }
  clip.animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, 0.7), scalarKey(12, 1)] }],
    titleTracks: values.map(([property, start, end]) => ({ elementId: text.id, propertyVersion: 1, property,
      keyframes: [{ ...scalarKey(0, start), easing: curve }, scalarKey(12, end)] })),
    effectTracks: [{ effectId: 'color', parameter: 'exposure', keyframes: [scalarKey(0, -0.2), scalarKey(12, 0.2)] }],
  }
  clip.effects = [{ id: 'blur', type: 'builtin.box-blur', version: 1, enabled: true, params: { radius: 1 } }, structuredClone(color)]
  const bus = createColorAdjustEffect('track-color'); bus.params.exposure = -0.2
  doc.tracks[0].videoEffects = [bus]
  const master = createColorAdjustEffect('master-color'); master.params.exposure = 0.1
  doc.masterVideoEffects = [master]
  const adjustment = createAdjustmentItem(0, 13, 'Title adjustment')
  const adjustmentColor = createColorAdjustEffect('adjustment-color'); adjustmentColor.params.saturation = 0.9
  adjustment.effects = [adjustmentColor]; adjustment.opacity = 0.6
  doc.tracks.push({ ...doc.tracks[0], id: 'adjustment-track', clips: [], videoEffects: [], adjustments: [adjustment] })
  if (nested) {
    const parent: TimelineDoc = { ...doc, id: 'parent', captionTracks: [], masterVideoEffects: [], tracks: [0, 1].map((index) => ({ ...doc.tracks[0], id: `parent-track-${index}`, clips: [], videoEffects: [],
      sequenceInstances: [{ kind: 'sequence', id: `nested-${index}`, sequenceId: doc.id, name: 'Title instance', sourceStartFrame: 0, timelineRange: { startFrame: 0, durationFrames: 13 } }],
    })) }
    project.rootSequenceId = parent.id; project.sequences = [parent, doc]
  }
  return project
}
export function upgradeProofProject(project: SequenceProject): SequenceProject {
  const result = upgradeLegacyTextTitle(project, project.rootSequenceId, project.sequences[0].tracks[0].clips[0].id, () => 'proof-element')
  if (!result.ok) throw new Error(result.reason)
  return result.project
}
type Canvas = HTMLCanvasElement | OffscreenCanvas
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
export interface TitleProofPixels {
  rgba: Uint8ClampedArray
  lines: { text: string; font: string; x: number; y: number; stroke: boolean }[]
  width: number
  height: number
  scratchCleared: boolean
  requests: number
  peakCanvases: number
  liveCanvases: number
}

function surfaces(width: number, height: number, offscreen: boolean) {
  const owned: Canvas[] = [], contexts: Context[] = []
  const lines: TitleProofPixels['lines'] = []
  const create = () => {
    const canvas = offscreen ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height })
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true }) as Context | null
    if (!ctx) throw new Error('Canvas2D unavailable in title proof')
    for (const stroke of [false, true]) {
      const name = stroke ? 'strokeText' : 'fillText', original = ctx[name].bind(ctx)
      ctx[name] = (text, x, y, maxWidth) => {
        lines.push({ text, font: ctx.font, x, y, stroke })
        if (maxWidth === undefined) original(text, x, y)
        else original(text, x, y, maxWidth)
      }
    }
    owned.push(canvas); contexts.push(ctx)
    return { canvas, ctx }
  }
  const destination = create()
  let borrowed: ReturnType<TransitionSurfaceProvider['get']> | undefined
  const provider: TransitionSurfaceProvider = { get: () => {
    if (!borrowed) { const leg = create(), group = create(); borrowed = { leg, group } }
    return borrowed
  } }
  return {
    destination, provider, lines,
    capture(requests: number): TitleProofPixels {
      const scratchCleared = contexts.slice(1).every((ctx) => ctx.getImageData(0, 0, width, height).data.every((value) => value === 0))
      return { rgba: destination.ctx.getImageData(0, 0, width, height).data, lines: [...lines], width, height, scratchCleared,
        requests, peakCanvases: owned.length, liveCanvases: owned.length }
    },
    close() {
      clearTextLayoutCaches(contexts)
      for (const canvas of owned) canvas.width = canvas.height = 0
      owned.length = 0; contexts.length = 0
    },
  }
}

export async function renderTitleProof(
  project: SequenceProject, frame: number, quality: PresentationResolvedQuality,
  options: { offscreen?: boolean; compositor?: typeof compositeFrame; plan?: VideoCompositionPlan } = {},
): Promise<TitleProofPixels> {
  const doc = project.sequences.find((sequence) => sequence.id === project.rootSequenceId)!
  const profile = resolvePresentationProfile(doc, { qualityMode: quality, reason: 'paused', viewport: null })
  const owner = surfaces(profile.outputWidth, profile.outputHeight, options.offscreen ?? typeof document === 'undefined')
  let requests = 0
  try {
    const plan = options.plan ?? createProjectVideoCompositionPlanner(project, doc.id, new Map()).planFrame(frame)
    await (options.compositor ?? compositeFrame)(doc, plan, owner.destination.ctx, { getFrame: async () => { requests++; throw new Error('Procedural title requested media') } }, owner.provider, profile)
    const result = owner.capture(requests)
    owner.close()
    return { ...result, liveCanvases: 0 }
  } finally { owner.close() }
}

/** Actual finite export controller, with raw pre-encoder frames captured by an
 * injected sink. It makes no codec/encoded-file equivalence claim.
 */
export async function exportTitleProof(project: SequenceProject): Promise<{ frames: TitleProofPixels[]; leases: number; closed: number; finalized: boolean }> {
  const doc = project.sequences.find((sequence) => sequence.id === project.rootSequenceId)!
  const planner = createProjectVideoCompositionPlanner(project, doc.id, new Map()), owner = surfaces(doc.width, doc.height, true)
  const frames: TitleProofPixels[] = []
  let leases = 0, closed = 0, finalized = false
  try {
    const run = exportTimeline(doc, DEFAULT_EXPORT_PROFILE, {
      openFrame: async (frame) => { leases++; return { plan: planner.planFrame(frame), getFrame: async () => { throw new Error('Export title requested media') }, close: () => { closed++ } } },
      close: () => {},
    }, {
      composite: compositeFrame,
      createVideoSink: async () => ({ ctx: owner.destination.ctx, transitionSurfaceProvider: owner.provider,
        addFrame: async () => { frames.push(owner.capture(0)); owner.lines.length = 0 },
        finalize: async () => { finalized = true; return createBufferedExportResult(new ArrayBuffer(0), DEFAULT_EXPORT_PROFILE) },
        cancel: async () => {},
      }),
    })
    for (;;) { const step = await run.next(); if (step.done) break }
    owner.close()
    return { frames: frames.map((frame) => ({ ...frame, liveCanvases: 0 })), leases, closed, finalized }
  } finally { owner.close() }
}

export function compareTitleProof(left: TitleProofPixels, right: TitleProofPixels) {
  let differingBytes = 0, maximumDelta = 0
  if (left.rgba.length !== right.rgba.length) throw new Error('Compared title dimensions differ')
  for (let index = 0; index < left.rgba.length; index++) {
    const delta = Math.abs(left.rgba[index] - right.rgba[index])
    if (delta) differingBytes++
    maximumDelta = Math.max(maximumDelta, delta)
  }
  return { differingBytes, maximumDelta, sameLines: JSON.stringify(left.lines) === JSON.stringify(right.lines) }
}

export function localLegacyPlan(doc: TimelineDoc, frame: number): VideoCompositionPlan {
  return createVideoCompositionPlanner(doc, new Map()).planFrame(frame)
}
