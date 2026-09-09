/** Loaded only after all live checkpoints; same production Offscreen policy. */
import { renderTitleProof, type TitleProofPixels } from '../../../src/test/titleRenderProof'
import { readTitleDefinition, readTitleElement } from '../../../src/domain/titleElements'
import type { FirstPaintCapture } from './first-paint-client'
import { pixelDifference, requireGlyphControl, withFont, type Checkpoint } from './first-paint-model'

function base64(bytes: Uint8Array | Uint8ClampedArray) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384))
  return btoa(binary)
}
function requireContextPolicy(result: TitleProofPixels) {
  if (!result.scratchCleared || result.requests !== 0 || result.liveCanvases !== 0 || result.peakCanvases > 3
    || result.contexts.length !== result.peakCanvases || result.contexts.length < 1) throw new Error('Reference ownership/cleanup failed')
  for (const [i, context] of result.contexts.entries()) {
    if (context.kind !== 'OffscreenCanvas' || context.role !== ['destination', 'leg', 'group'][i]
      || context.width !== result.width || context.height !== result.height
      || context.requested.colorSpace !== 'srgb' || context.requested.willReadFrequently !== (i > 0 ? true : undefined)
      || context.actual?.colorSpace !== 'srgb' || context.actual.willReadFrequently !== (i > 0)) throw new Error('Reference production context mismatch')
  }
}
async function encode(result: TitleProofPixels) {
  const canvas = new OffscreenCanvas(result.width, result.height)
  try {
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
    if (!ctx) throw new Error('Reference PNG context unavailable')
    ctx.putImageData(new ImageData(new Uint8ClampedArray(result.rgba), result.width, result.height), 0, 0)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    const { rgba, ...metadata } = result
    return { metadata, rgbaBase64: base64(rgba), pngBase64: base64(new Uint8Array(await png.arrayBuffer())) }
  } finally { canvas.width = canvas.height = 0 }
}

export async function compareFirstPaint(captures: ReadonlyMap<string, FirstPaintCapture>) {
  const rows = [], references = [], controls = [], failures: string[] = []
  const policy = { offscreen: true, canvasPolicy: 'production' } as const
  const sample = (name: Checkpoint) => {
    const capture = captures.get(name)
    if (!capture) throw new Error(`Missing checkpoint ${name}`)
    return capture
  }
  try { for (const name of ['initial-generic', 'unavailable', 'fallback-before-reopen', 'reopened-at-notice', 'reopened-presented', 'reopened-stable'] as const) {
    const capture = sample(name), { project, profile } = capture.state
    if (name === 'reopened-at-notice' && !capture.profileMatches) {
      rows.push({ name, diagnosticOnly: true, differingBytes: null, maximumDelta: null, changedPixels: null, firstCoordinates: [],
        titleExportError: capture.state.titleExportError, qualification: 'Original-boundary canvas dimensions have not reached the resolved profile' })
      continue
    }
    const definition = readTitleDefinition(project.sequences[0].tracks[0].clips[0].title)
    if (definition.status !== 'supported') throw new Error('Unsupported reference title definition')
    const parsed = readTitleElement(definition.title.elements[0])
    if (parsed.status !== 'supported' || parsed.element.kind !== 'text' || parsed.element.text.backgroundEnabled) throw new Error('Unexpected title reference fixture')
    const initial = name === 'initial-generic'
    const font = initial ? parsed.element.font : { family: 'serif', fallbackFamily: null }
    const controlProject = withFont(project, font)
    const reference = await renderTitleProof(controlProject, 0, profile.resolvedQuality, policy)
    const empty = await renderTitleProof(withFont(controlProject, font, true), 0, profile.resolvedQuality, policy)
    references.push({ name, reference: await encode(reference), empty: await encode(empty) })
    requireContextPolicy(reference); requireContextPolicy(empty)
    if (reference.width !== capture.width || reference.height !== capture.height) throw new Error('Live/reference dimensions differ')
    const glyph = requireGlyphControl(reference.rgba, empty.rgba, capture.width, capture.height)
    if (!reference.lines.some((line) => line.text.includes('Title')) || !reference.lines.some((line) => line.text.includes('Second line'))) throw new Error('Expected text lines are absent from the nonblank reference')
    const expected = name === 'unavailable' ? empty : reference
    const { mask: _mask, ...difference } = pixelDifference(capture.rgba, expected.rgba, capture.width, capture.height)
    const diagnosticOnly = name === 'reopened-at-notice'
    rows.push({ name, diagnosticOnly, ...difference, titleExportError: capture.state.titleExportError })
    if (!diagnosticOnly && difference.differingBytes !== 0) failures.push(`${name}: ${difference.differingBytes} differing RGBA bytes`)
    if (name === 'unavailable' ? !capture.state.titleExportError?.includes('choose an explicit fallback') : capture.state.titleExportError !== null) failures.push(`${name}: strict title eligibility mismatch`)
    controls.push({ name, changedPixels: glyph.changedPixels, firstCoordinates: glyph.firstCoordinates,
      width: capture.width, height: capture.height, glyphMaskBase64: base64(glyph.mask), maskEncoding: 'one uint8 per pixel; row-major; 1 means any RGBA channel differs' })
  } } catch (cause) { failures.push(`Reference/control evaluation failed: ${String(cause)}`) }
  const presented = sample('reopened-presented'), stable = sample('reopened-stable')
  const { mask: _mask, ...stability } = pixelDifference(presented.rgba, stable.rgba, presented.width, presented.height)
  if (stability.differingBytes) failures.push('The reopened canvas changed after its presentation boundary')
  return { rows, controls, references, stability, failures, exactRequired: { differingBytes: 0, maximumDelta: 0 },
    qualification: 'Same-runtime canvas pixels and recorded reference line facts; no font-byte identity, complete glyph coverage, encoder or historical-cause claim.' }
}
