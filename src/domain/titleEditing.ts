/** Pure expanded-title authoring. Every command produces one fully checked project. */
import type { Clip, TitleAnimationTrack, TimelineDoc } from './schema'
import type { SequenceProject } from './projectSequences'
import { replaceProjectSequence, sequenceById } from './projectSequences'
import { defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { defaultTextProps, isProceduralTitleClip } from './textOverlay'
import { readTitleDefinition, readTitleElement, applyTitleAnimationValues, resolveTitleFont, type TitleElement, type TitleElementIntent, type TitleAnimationProperty } from './titleElements'
import { createTitleElementIdAllocator, projectTitleOwnershipError, readTitleClipElement } from './titleOwnership'
import { projectTitleAnimationError } from './animationProjectBudget'
import { resolveTitleElementAnimation } from './animationPropertyCatalog'
import { planAnimationInsertions, planSetAnimationKey } from './animationBatch'
import { SOURCE_TIME_TICKS_PER_FRAME } from './sourceTimeMap'

export interface TitleEditTarget { readonly sequenceId: string; readonly clipId: string }
export type TitleElementPatch = {
  readonly name?: string; readonly enabled?: boolean; readonly opacity?: number
  readonly transform?: Partial<TitleElement['transform']>
  readonly visual?: Partial<Omit<TitleElement['visual'], 'crop'>> & { readonly crop?: Partial<TitleElement['visual']['crop']> }
  readonly text?: Partial<Extract<TitleElement, { kind: 'text' }>['text']>
  readonly font?: Extract<TitleElement, { kind: 'text' }>['font']
  readonly shape?: Partial<Extract<TitleElement, { kind: 'rectangle' | 'ellipse' }>['shape']>
}
export type TitleEditCommand =
  | { readonly kind: 'gesture'; readonly ids: readonly string[]; readonly mode: 'move' | 'resize'; readonly dx: number; readonly dy: number; readonly frame: number }
  | { readonly kind: 'patch'; readonly ids: readonly string[]; readonly patch: TitleElementPatch }
  | { readonly kind: 'values'; readonly ids: readonly string[]; readonly values: Readonly<Partial<Record<TitleAnimationProperty, number>>> }
  | { readonly kind: 'add'; readonly elementKind: TitleElement['kind'] }
  | { readonly kind: 'duplicate'; readonly ids: readonly string[] }
  | { readonly kind: 'delete'; readonly ids: readonly string[] }
  | { readonly kind: 'reorder'; readonly ids: readonly string[] }
  | { readonly kind: 'motion'; readonly ids: readonly string[]; readonly direction: 'up' | 'down' | 'left' | 'right'; readonly start: number; readonly end: number; readonly replace: boolean }
export const TITLE_ANIMATION_CONTEXT = Object.freeze({ titles: Object.freeze({ isTitleClip: isProceduralTitleClip, readElement: readTitleClipElement }) })
export function titleEditOwner(project: SequenceProject, target: TitleEditTarget) {
  const sequence = sequenceById(project, target.sequenceId)
  const track = sequence?.tracks.find((item) => item.clips.some((clip) => clip.id === target.clipId))
  const clip = track?.clips.find((item) => item.id === target.clipId)
  if (!sequence || !track || !clip || !clip.title || clip.text || track.kind !== 'video') throw new Error('Choose an expanded title on a video track.')
  if (track.locked) throw new Error('Unlock the title track before editing.')
  const parsed = readTitleDefinition(clip.title)
  if (parsed.status !== 'supported') throw new Error(parsed.reason)
  // Keep existing immutable subtrees; the reader validates without becoming another retained copy.
  return { sequence, track, clip, elements: (clip.title as { elements: readonly TitleElementIntent[] }).elements }
}
export function defaultTitleElement(kind: TitleElement['kind'], id: string, canvas: Pick<TimelineDoc, 'width' | 'height'>): TitleElement {
  const base = { id, version: 1 as const, name: kind === 'text' ? 'Text' : kind === 'rectangle' ? 'Rectangle' : 'Ellipse', enabled: true,
    transform: defaultClipTransform(), visual: defaultClipVisualSettings(), opacity: 1 }
  const { fontFamily, ...text } = defaultTextProps(canvas.width, canvas.height)
  return kind === 'text' ? { ...base, kind, text, font: { family: fontFamily, fallbackFamily: null } }
    : { ...base, kind, shape: { boxWidthPx: text.boxWidthPx, boxHeightPx: text.boxHeightPx, fillColor: '#243354', outlineEnabled: false, outlineColor: '#ffffff', outlineWidthPx: 0 } }
}
export function titleElementBounds(element: TitleElement, canvas: Pick<TimelineDoc, 'width' | 'height'>) {
  const box = element.kind === 'text' ? element.text : element.shape, t = element.transform, v = element.visual
  if (t.scaleX === 0 || t.scaleY === 0) throw new Error('Zero-scale elements have no editable movement geometry.')
  const w = box.boxWidthPx, h = box.boxHeightPx, ax = t.anchorX * w, ay = t.anchorY * h
  const theta = t.rotation * Math.PI / 180, c = Math.cos(theta), s = Math.sin(theta)
  const points = [[v.crop.left * w, v.crop.top * h], [(1 - v.crop.right) * w, v.crop.top * h],
    [(1 - v.crop.right) * w, (1 - v.crop.bottom) * h], [v.crop.left * w, (1 - v.crop.bottom) * h]].map(([x, y]) => {
    const dx = (x - ax) * t.scaleX * (v.flipHorizontal ? -1 : 1), dy = (y - ay) * t.scaleY * (v.flipVertical ? -1 : 1)
    return { x: (canvas.width - w) / 2 + ax + t.x + c * dx - s * dy, y: (canvas.height - h) / 2 + ay + t.y + s * dx + c * dy }
  })
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e12 || Math.abs(p.y) > 1e12)) throw new Error('The element geometry is unbounded.')
  return { left: Math.min(...points.map((p) => p.x)), right: Math.max(...points.map((p) => p.x)), top: Math.min(...points.map((p) => p.y)), bottom: Math.max(...points.map((p) => p.y)), points }
}
function supported(element: TitleElementIntent): TitleElement {
  const result = readTitleElement(element)
  if (result.status !== 'supported') throw new Error(result.reason)
  return element as TitleElement
}
function selection(elements: readonly TitleElementIntent[], ids: readonly string[]) {
  if (!ids.length || ids.length > 16 || new Set(ids).size !== ids.length || ids.some((id) => !elements.some((element) => element.id === id))) throw new Error('Select existing title elements once each.')
  return new Set(ids)
}
function patched(element: TitleElement, patch: TitleElementPatch): TitleElement {
  if (patch.text && element.kind !== 'text' || patch.font && element.kind !== 'text' || patch.shape && element.kind === 'text') throw new Error('This property is unavailable for the selected element kind.')
  const transform = { ...element.transform, ...patch.transform }, visual = { ...element.visual, ...patch.visual, crop: { ...element.visual.crop, ...patch.visual?.crop } }
  if (visual.scaleLocked && (patch.visual?.scaleLocked === true || patch.transform?.scaleX !== undefined || patch.transform?.scaleY !== undefined)) {
    const scale = patch.visual?.scaleLocked === true || patch.transform?.scaleX !== undefined ? transform.scaleX : transform.scaleY
    transform.scaleX = scale; transform.scaleY = scale
  }
  const next = { ...element, ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }), transform, visual,
    ...(element.kind === 'text' ? { text: { ...element.text, ...patch.text }, font: patch.font ?? element.font } : { shape: { ...element.shape, ...patch.shape } }) } as TitleElement
  supported(next)
  return next
}
export function replaceTitleClip(project: SequenceProject, target: TitleEditTarget, replacement: Clip): SequenceProject {
  const { sequence, track, clip } = titleEditOwner(project, target)
  const document = { ...sequence, tracks: sequence.tracks.map((item) => item !== track ? item : { ...item, clips: item.clips.map((item) => item === clip ? replacement : item) }) }
  const candidate = { ...project, sequences: project.sequences.map((item) => item === sequence ? document : item) }
  const error = projectTitleOwnershipError(candidate) ?? projectTitleAnimationError(candidate)
  if (error) throw new Error(error)
  const next = replaceProjectSequence(project, sequence.id, document)
  if (next === project) throw new Error('The title edit exceeds the complete project limits.')
  return next
}
export function planTitleEdit(project: SequenceProject, target: TitleEditTarget, command: TitleEditCommand, factory: () => string): SequenceProject {
  const { sequence, clip, elements } = titleEditOwner(project, target)
  const allocate = command.kind === 'add' || command.kind === 'duplicate' ? createTitleElementIdAllocator(project, factory) : null
  if (command.kind === 'motion') return planTitleMotion(project, target, command)
  if (command.kind === 'gesture') return planTitleGesture(project, target, command, factory)
  let next = elements, lanes = clip.animation?.titleTracks
  if (command.kind === 'add') next = [...elements, defaultTitleElement(command.elementKind, allocate!(), sequence)]
  else {
    const selected = selection(elements, command.ids)
    if (command.kind === 'reorder') {
      if (selected.size !== elements.length) throw new Error('Reordering must include every element exactly once.')
      next = command.ids.map((id) => elements.find((item) => item.id === id)!)
    } else if (command.kind === 'delete') {
      if (selected.size === elements.length) throw new Error('Keep at least one element, or delete the title clip.')
      next = elements.filter((element) => !selected.has(element.id)); lanes = lanes?.filter((lane) => !selected.has(lane.elementId))
    } else if (command.kind === 'duplicate') {
      const copies = new Map<string, string>()
      next = elements.flatMap((element) => {
        if (!selected.has(element.id)) return [element]
        const id = allocate!(); copies.set(element.id, id)
        return [element, { ...element, id }]
      })
      if (lanes) lanes = [...lanes, ...lanes.filter((lane) => copies.has(lane.elementId)).map((lane) => ({ ...lane, elementId: copies.get(lane.elementId)! }))]
    } else next = elements.map((element) => {
      if (!selected.has(element.id)) return element
      const current = supported(element)
      if (command.kind === 'patch') return patched(current, command.patch)
      const values = { ...command.values }
      if (current.visual.scaleLocked && (values['scale-x'] !== undefined || values['scale-y'] !== undefined)) values['scale-x'] = values['scale-y'] = values['scale-x'] ?? values['scale-y']
      const result = applyTitleAnimationValues(current, Object.entries(values).map(([property, value]) => ({ propertyVersion: 1, property, value })))
      if (result.status !== 'applied') throw new Error(result.reason)
      return result.element
    })
  }
  if (JSON.stringify(next) === JSON.stringify(elements) && lanes === clip.animation?.titleTracks) return project
  return replaceTitleClip(project, target, { ...clip, title: { version: 1, elements: next }, ...(lanes === undefined ? {} : { animation: { ...clip.animation!, titleTracks: [...lanes] } }) })
}
export function titleMotionReplacements(clip: Clip, ids: readonly string[], direction: 'up' | 'down' | 'left' | 'right'): readonly TitleAnimationTrack[] {
  const property = direction === 'up' || direction === 'down' ? 'position-y' : 'position-x'
  return (clip.animation?.titleTracks ?? []).filter((lane) => ids.includes(lane.elementId) && lane.property === property)
}
function planTitleMotion(project: SequenceProject, target: TitleEditTarget, command: Extract<TitleEditCommand, { kind: 'motion' }>): SequenceProject {
  const { sequence, clip, elements } = titleEditOwner(project, target), selected = selection(elements, command.ids)
  if (!['up', 'down', 'left', 'right'].includes(command.direction)) throw new Error('Choose a supported movement direction.')
  if (!Number.isSafeInteger(command.start) || !Number.isSafeInteger(command.end) || command.start < 0 || command.start >= command.end || command.end >= clip.timelineRange.durationFrames) throw new Error('Motion needs 0 ≤ start < end < title duration, in integer frames.')
  const removed = titleMotionReplacements(clip, command.ids, command.direction)
  if (removed.length && !command.replace) throw new Error('Movement tracks already exist. Review Reapply before replacing them.')
  if (removed.some((lane) => lane.propertyVersion !== 1)) throw new Error('An unavailable movement version is preserved. Remove it explicitly in the animation workspace first.')
  const property = command.direction === 'up' || command.direction === 'down' ? 'position-y' : 'position-x'
  const clean = { ...clip, animation: { ...clip.animation ?? { tracks: [] }, titleTracks: (clip.animation?.titleTracks ?? []).filter((lane) => !removed.includes(lane)) } }
  const chosen = elements.filter((element) => selected.has(element.id)).map(supported)
  const offsets = [command.start, command.end].map((frame, index) => {
    const bounds = chosen.map((element) => {
      if (!element.enabled) throw new Error('Enable every selected element before generating movement.')
      if (element.kind === 'text' && resolveTitleFont(element.font).status === 'unavailable') throw new Error('Choose an explicit font fallback before generating movement.')
      const resolved = resolveTitleElementAnimation(element, clean.animation.titleTracks, frame)
      if (resolved.unavailable.length) throw new Error(resolved.unavailable[0])
      return titleElementBounds(resolved.element, sequence)
    })
    const negative = command.direction === 'up' || command.direction === 'left'
    const before = negative ? index === 1 : index === 0
    if (property === 'position-y') return before ? -Math.max(...bounds.map((b) => b.bottom)) - 1 : sequence.height - Math.min(...bounds.map((b) => b.top)) + 1
    return before ? -Math.max(...bounds.map((b) => b.right)) - 1 : sequence.width - Math.min(...bounds.map((b) => b.left)) + 1
  })
  const prepared = removed.length ? replaceTitleClip(project, target, clean) : project
  const result = planAnimationInsertions(prepared, sequence.id, chosen.map((element) => ({
    lane: { owner: { kind: 'clip', id: clip.id }, kind: 'title', elementId: element.id, property, propertyVersion: 1 },
    track: { elementId: element.id, property, propertyVersion: 1, keyframes: [command.start, command.end].map((frame, index) => ({ frame, sourceTimeTicks: frame * SOURCE_TIME_TICKS_PER_FRAME,
      value: (property === 'position-x' ? element.transform.x : element.transform.y) + offsets[index], easing: { type: 'linear' } })) },
  })), TITLE_ANIMATION_CONTEXT)
  if (!result.ok) throw new Error(result.reason)
  return result.project
}

/** Solve the visible bottom-right crop corner in project coordinates, including flips and anchor. */
export function titleResizeDelta(element: TitleElement, dx: number, dy: number) {
  const t = element.transform, v = element.visual, angle = t.rotation * Math.PI / 180
  const sx = t.scaleX * (v.flipHorizontal ? -1 : 1), sy = t.scaleY * (v.flipVertical ? -1 : 1)
  const x = 1 - v.crop.right - t.anchorX, y = 1 - v.crop.bottom - t.anchorY
  const a = t.anchorX - 0.5 + Math.cos(angle) * sx * x, b = -Math.sin(angle) * sy * y
  const c = Math.sin(angle) * sx * x, d = t.anchorY - 0.5 + Math.cos(angle) * sy * y
  const determinant = a * d - b * c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) throw new Error('This anchor and crop have no stable corner resize. Use numeric box controls.')
  return { width: (d * dx - b * dy) / determinant, height: (a * dy - c * dx) / determinant }
}
function planTitleGesture(project: SequenceProject, target: TitleEditTarget, command: Extract<TitleEditCommand, { kind: 'gesture' }>, factory: () => string): SequenceProject {
  const { clip, elements } = titleEditOwner(project, target), selected = selection(elements, command.ids)
  if (!Number.isFinite(command.dx) || !Number.isFinite(command.dy) || !Number.isSafeInteger(command.frame) || command.frame < 0 || command.frame >= clip.timelineRange.durationFrames) throw new Error('Use finite movement inside the title frame range.')
  if (command.mode === 'resize' && selected.size !== 1) throw new Error('Resize one element at a time.')
  let next = project
  for (const intent of elements) {
    if (!selected.has(intent.id)) continue
    const element = supported(intent), resolved = resolveTitleElementAnimation(element, clip.animation?.titleTracks ?? [], command.frame)
    if (resolved.unavailable.length) throw new Error(resolved.unavailable[0])
    const shown = resolved.element, box = shown.kind === 'text' ? shown.text : shown.shape
    const resize = command.mode === 'resize' ? titleResizeDelta(shown, command.dx, command.dy) : null
    const values = resize ? { 'box-width': box.boxWidthPx + resize.width, 'box-height': box.boxHeightPx + resize.height }
      : { 'position-x': shown.transform.x + command.dx, 'position-y': shown.transform.y + command.dy }
    for (const [property, value] of Object.entries(values)) {
      if (clip.animation?.titleTracks?.some((lane) => lane.elementId === element.id && lane.property === property)) {
        const result = planSetAnimationKey(next, target.sequenceId, { owner: { kind: 'clip', id: clip.id }, kind: 'title', elementId: element.id, propertyVersion: 1, property }, command.frame, value, undefined, TITLE_ANIMATION_CONTEXT)
        if (!result.ok) throw new Error(result.reason)
        next = result.project
      } else next = planTitleEdit(next, target, { kind: 'values', ids: [element.id], values: { [property]: value } }, factory)
    }
  }
  return next
}
