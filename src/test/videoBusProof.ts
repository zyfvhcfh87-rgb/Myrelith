/** Test-only semantic prototype. No portable fields or application entry import it. */
import { applyOrderedPixelEffectsToRgba } from '../domain/effectPixels'
import { resolvePostCompositeEffectStack } from '../domain/effectStack'
import type { EffectDescriptor } from '../domain/schema'
import type { BlendModeName } from '../domain/blendModes'
import { resolveBlendMode, resolveTransitionGroupBlendMode } from '../domain/blendModes'
import { probeCanvasBlendMode } from '../pipeline/blendModeCapabilities'

type Surface = { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }
type Media = { color: string; opacity: number; blend: BlendModeName; effects: EffectDescriptor[]; plugin?: boolean }
type Content = { kind: 'media'; legs: Media[] } | { kind: 'child'; sequence: Sequence; instance: string } | { kind: 'adjustment'; effects: EffectDescriptor[]; opacity: number } | { kind: 'gap' } | { kind: 'multicam-gap' }
interface Track { id: string; effects: EffectDescriptor[]; content: Content }
interface Sequence { id: string; frame: number; tracks: Track[]; caption: boolean; effects: EffectDescriptor[] }
const effect = (type: string, params: EffectDescriptor['params']): EffectDescriptor => ({ id: type, type: `builtin.${type}`, version: 1, enabled: true, params })
const vignette = effect('vignette', { strength: 0.8, radius: 0.1, softness: 0.9 })
const blur = effect('box-blur', { radius: 3 })
const sharpen = effect('sharpen', { amount: 1.3 })
const media = (color: string, blend: BlendModeName, opacity = 0.7, plugin = false): Media => ({ color, opacity, blend, effects: [blur], plugin })

export async function proveVideoBusSchedule(width: number, height: number, depth: number, mode: 'explicit' | 'sequential', fail = false) {
  const owned = new Set<Surface>(), trace: string[] = []
  let peakSurfaces = 0, liveArrays = 0, peakArrays = 0, scratchPeak = 0
  const allocate = (): Surface => {
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const surface = { canvas, ctx }; owned.add(surface); peakSurfaces = Math.max(peakSurfaces, owned.size); return surface
  }
  const release = (surface: Surface) => { surface.canvas.width = surface.canvas.height = 0; owned.delete(surface) }
  const destination = allocate(), leg = allocate(), group = allocate()
  const pixels = (surface: Surface, effects: EffectDescriptor[]) => {
    if (!effects.length) return
    const resolution = resolvePostCompositeEffectStack(effects, true)
    const data = surface.ctx.getImageData(0, 0, width, height)
    liveArrays += data.data.byteLength; peakArrays = Math.max(peakArrays, liveArrays)
    const work = { maskScanlineEdgeTests: 0, maskDistanceSamples: 0, spatialScratchBytesPeak: 0, spatialPixelVisits: 0 }
    try {
      applyOrderedPixelEffectsToRgba(data.data, resolution.pixelEffects, { surfaceWidth: width, surfaceHeight: height, projectWidth: width, projectHeight: height }, work)
      scratchPeak = Math.max(scratchPeak, work.spatialScratchBytesPeak)
      surface.ctx.putImageData(data, 0, 0)
    } finally { liveArrays -= data.data.byteLength }
  }
  const clear = (surface: Surface) => { surface.ctx.clearRect(0, 0, width, height) }
  const drawMedia = async (target: Surface, source: Media, weight: number) => {
    clear(leg)
    leg.ctx.fillStyle = source.color; leg.ctx.fillRect(width / 8, height / 8, width * 0.75, height * 0.75)
    // A source-local alpha edge survives the spatial and await stages.
    leg.ctx.clearRect(0, 0, width / 4, height / 3)
    pixels(leg, source.effects)
    if (source.plugin) {
      const before = leg.ctx.getImageData(0, 0, width, height)
      liveArrays += before.data.byteLength; peakArrays = Math.max(peakArrays, liveArrays)
      try {
        trace.push('plugin:begin')
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        if (fail) throw new Error('injected plugin failure/cancellation')
        const after = leg.ctx.getImageData(0, 0, width, height)
        liveArrays += after.data.byteLength; peakArrays = Math.max(peakArrays, liveArrays)
        liveArrays -= after.data.byteLength
        if (after.data.some((value, index) => value !== before.data[index])) throw new Error('borrowed leg changed during await')
        trace.push('plugin:end')
      } finally { liveArrays -= before.data.byteLength }
    }
    target.ctx.save()
    try { target.ctx.globalCompositeOperation = 'lighter'; target.ctx.globalAlpha = weight * source.opacity; target.ctx.drawImage(leg.canvas, 0, 0) }
    finally { target.ctx.restore(); clear(leg) }
  }
  const render = async (sequence: Sequence, target: Surface, path: string[]) => {
    const key = `${sequence.id}@${sequence.frame}:${path.join('/')}`
    trace.push(`begin:${key}`)
    target.ctx.fillStyle = '#000'; target.ctx.fillRect(0, 0, width, height)
    for (const track of sequence.tracks) {
      const content = track.content
      if (content.kind === 'gap') { trace.push(`gap:${key}:${track.id}`); continue }
      if (content.kind === 'multicam-gap') {
        target.ctx.fillStyle = '#000'; target.ctx.fillRect(0, 0, width, height)
        pixels(target, track.effects); trace.push(`multicam-gap:${key}:${track.id}`); continue
      }
      if (content.kind === 'adjustment') {
        clear(leg); leg.ctx.drawImage(target.canvas, 0, 0); pixels(leg, content.effects)
        target.ctx.save()
        try { target.ctx.globalAlpha = content.opacity; target.ctx.drawImage(leg.canvas, 0, 0) } finally { target.ctx.restore(); clear(leg) }
        trace.push(`adjustment:${key}:${track.id}`)
        continue
      }
      if (content.kind === 'child') {
        const childTarget = mode === 'explicit' ? allocate() : target
        try {
          await render(content.sequence, childTarget, [...path, content.instance])
          pixels(childTarget, track.effects)
          trace.push(`track:${key}:${track.id}`)
          if (childTarget !== target) target.ctx.drawImage(childTarget.canvas, 0, 0)
        } finally { if (childTarget !== target) release(childTarget) }
        continue
      }
      const isolated = mode === 'explicit' ? allocate() : group
      try {
        clear(isolated)
        for (const source of content.legs) await drawMedia(isolated, source, 1 / content.legs.length)
        pixels(isolated, track.effects)
        trace.push(`track:${key}:${track.id}`)
        const outer = content.legs.length === 1 ? resolveBlendMode(content.legs[0].blend)
          : resolveTransitionGroupBlendMode({ blendMode: content.legs[0].blend }, { blendMode: content.legs[1].blend })
        target.ctx.save()
        try { target.ctx.globalCompositeOperation = probeCanvasBlendMode(target.ctx, outer.effective).operation; target.ctx.drawImage(isolated.canvas, 0, 0) } finally { target.ctx.restore() }
      } finally { if (isolated !== group) release(isolated); else clear(group) }
    }
    if (sequence.caption) { target.ctx.fillStyle = '#ffffff'; target.ctx.fillRect(width / 3, height * 0.75, width / 3, Math.max(1, height / 12)); trace.push(`caption:${key}`) }
    pixels(target, sequence.effects); trace.push(`master:${key}`); trace.push(`end:${key}`)
  }
  const leaf: Sequence = { id: 'shared-child', frame: 17, effects: [vignette, blur], caption: true, tracks: [
    { id: 'multicam-gap', effects: [vignette], content: { kind: 'multicam-gap' } },
    { id: 'lower', effects: [sharpen], content: { kind: 'media', legs: [media('#8040c0', 'normal', 1)] } },
    { id: 'below-adjustment', effects: [vignette], content: { kind: 'adjustment', effects: [sharpen], opacity: 0.4 } },
    { id: 'same-mode', effects: [vignette, sharpen], content: { kind: 'media', legs: [media('#c06020', 'multiply'), media('#2050c0', 'multiply', 0.4, true)] } },
    { id: 'mixed-mode', effects: [blur], content: { kind: 'media', legs: [media('#c08060', 'difference', 0.3), media('#20c050', 'exclusion', 0.6)] } },
    { id: 'above-adjustment', effects: [vignette], content: { kind: 'adjustment', effects: [blur, sharpen], opacity: 0.3 } },
    { id: 'empty-track', effects: [vignette], content: { kind: 'gap' } },
  ] }
  let root = leaf
  for (let level = 1; level <= depth; level++) root = { id: `parent-${level}`, frame: level * 3, effects: [sharpen, vignette], caption: true, tracks: [
    { id: 'parent-lower', effects: [blur], content: { kind: 'media', legs: [media('#40a0e0', 'normal')] } },
    { id: 'nested-track', effects: [blur, vignette], content: { kind: 'child', sequence: root, instance: `instance-${level}` } },
  ] }
  if (depth > 0) root.tracks.push({ id: 'repeat', effects: [sharpen], content: { kind: 'child', sequence: leaf, instance: 'repeat-child' } })
  let result: number[] = [], error: string | null = null
  try {
    await render(root, destination, [])
    const output = destination.ctx.getImageData(0, 0, width, height)
    peakArrays = Math.max(peakArrays, output.data.byteLength)
    result = width <= 64 ? Array.from(output.data) : Array.from(output.data.subarray(0, 16))
  }
  catch (cause) { error = String(cause) }
  finally { [...owned].forEach(release) }
  return { result, trace, error, peakSurfaces, peakArrays, scratchPeak, liveSurfaces: owned.size, liveArrays,
    rgbaSurfaceBytes: width * height * 4 * peakSurfaces }
}
