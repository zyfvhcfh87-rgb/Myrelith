/**
 * Browser-free Issue #78 feasibility contracts.
 *
 * These types are deliberately not part of the persisted TimelineDoc or any
 * production planner. They make the research decisions executable without
 * committing product schema or UI ahead of the follow-up issues.
 */

export const STRUCTURE_RESEARCH_MAX_SEQUENCE_DEPTH = 8
export const STRUCTURE_RESEARCH_MAX_LEAF_REQUESTS = 4_096
export const STRUCTURE_RESEARCH_MAX_MULTICAM_ANGLES = 8
export const STRUCTURE_RESEARCH_MAX_MULTICAM_SWITCHES = 100_000
export const STRUCTURE_RESEARCH_MAX_ADJUSTMENT_EFFECTS = 32
export const STRUCTURE_RESEARCH_BYTES_PER_PIXEL = 4
export const STRUCTURE_RESEARCH_MAX_SURFACE_BYTES = 256 * 1024 * 1024

export interface StructureResearchFrameRange {
  readonly startFrame: number
  readonly durationFrames: number
}

export interface StructureResearchFrameRate {
  readonly num: number
  readonly den: number
}

export interface StructureResearchSequenceSettings {
  readonly frameRate: StructureResearchFrameRate
  readonly width: number
  readonly height: number
  readonly audioSampleRate: number
}

export interface StructureResearchSourceItem {
  readonly id: string
  readonly range: StructureResearchFrameRange
}

export interface StructureResearchSequenceInstance {
  readonly id: string
  readonly sequenceId: string
  readonly range: StructureResearchFrameRange
  readonly sourceStartFrame: number
}

export interface StructureResearchSequence {
  readonly id: string
  readonly durationFrames: number
  readonly settings: StructureResearchSequenceSettings
  readonly sources: readonly StructureResearchSourceItem[]
  readonly instances: readonly StructureResearchSequenceInstance[]
}

export interface StructureResearchSequenceProject {
  readonly rootSequenceId: string
  readonly sequences: readonly StructureResearchSequence[]
}

export interface StructureResearchSequenceAnalysis {
  readonly rootSequenceId: string
  readonly sequenceCount: number
  readonly referenceCount: number
  readonly reachableSequenceCount: number
  readonly maxDepth: number
  /** Children appear before parents, making resource setup/teardown explicit. */
  readonly topologicalOrder: readonly string[]
}

export interface StructureResearchLeafRequest {
  readonly sequenceId: string
  readonly sourceId: string
  readonly localFrame: number
  readonly instancePath: readonly string[]
}

export interface StructureResearchNestedFramePlan {
  readonly rootSequenceId: string
  readonly rootFrame: number
  readonly leafRequests: readonly StructureResearchLeafRequest[]
  readonly visitedSequenceInstances: number
  readonly maxDepth: number
}

export interface StructureResearchSourceLayerItem {
  readonly kind: 'source'
  readonly id: string
  readonly range: StructureResearchFrameRange
}

export interface StructureResearchAdjustmentLayerItem {
  readonly kind: 'adjustment'
  readonly id: string
  readonly range: StructureResearchFrameRange
  readonly effectCount: number
}

export type StructureResearchAdjustmentItem =
  | StructureResearchSourceLayerItem
  | StructureResearchAdjustmentLayerItem

export interface StructureResearchAdjustmentTrack {
  readonly id: string
  readonly hidden?: boolean
  readonly items: readonly StructureResearchAdjustmentItem[]
}

export interface StructureResearchPaintSourceOperation {
  readonly kind: 'paint-source'
  readonly trackId: string
  readonly itemId: string
}

export interface StructureResearchApplyAdjustmentOperation {
  readonly kind: 'apply-adjustment'
  readonly trackId: string
  readonly itemId: string
  readonly effectCount: number
  /** Operations already composited below this post-composite boundary. */
  readonly lowerOperationCount: number
}

export type StructureResearchAdjustmentOperation =
  | StructureResearchPaintSourceOperation
  | StructureResearchApplyAdjustmentOperation

export interface StructureResearchAdjustmentFramePlan {
  readonly frame: number
  readonly operations: readonly StructureResearchAdjustmentOperation[]
  readonly activeAdjustmentCount: number
  /** Conservative upper bound: one accumulation boundary plus every effect. */
  readonly fullFramePassUpperBound: number
  readonly rangeComparisons: number
}

export interface StructureResearchAdjustmentPlanner {
  planFrame(frame: number): StructureResearchAdjustmentFramePlan
}

export interface StructureResearchMulticamAngle {
  readonly id: string
  /** Multicam-local interval where this angle has source coverage. */
  readonly range: StructureResearchFrameRange
  /** Source frame corresponding to range.startFrame. */
  readonly sourceStartFrame: number
}

export interface StructureResearchMulticamSwitch {
  readonly frame: number
  readonly videoAngleId: string
}

export type StructureResearchMulticamAudioPolicy =
  | { readonly kind: 'fixed'; readonly angleId: string }
  | { readonly kind: 'follow-video' }

export interface StructureResearchMulticam {
  readonly durationFrames: number
  readonly angles: readonly StructureResearchMulticamAngle[]
  readonly switches: readonly StructureResearchMulticamSwitch[]
  readonly audioPolicy: StructureResearchMulticamAudioPolicy
}

export interface StructureResearchMulticamSelection {
  readonly frame: number
  readonly switchFrame: number
  readonly videoAngleId: string
  readonly videoSourceFrame: number | null
  readonly audioAngleId: string
  readonly audioSourceFrame: number | null
  readonly switchComparisons: number
}

export interface StructureResearchMulticamPlanner {
  select(frame: number): StructureResearchMulticamSelection
}

export interface StructureResearchSurfaceEnvelope {
  readonly allowed: boolean
  readonly width: number
  readonly height: number
  readonly surfaceCount: number
  readonly aggregateBytes: number
  readonly reason: string | null
}

function assertIdentifier(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 128) {
    throw new RangeError(`${label} must contain 1..128 non-whitespace characters`)
  }
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function frameRangeEnd(range: StructureResearchFrameRange, label: string): number {
  assertSafeNonNegativeInteger(range.startFrame, `${label}.startFrame`)
  assertSafePositiveInteger(range.durationFrames, `${label}.durationFrames`)
  const endFrame = range.startFrame + range.durationFrames
  if (!Number.isSafeInteger(endFrame)) {
    throw new RangeError(`${label} end must be a safe integer`)
  }
  return endFrame
}

function rangeContains(range: StructureResearchFrameRange, frame: number): boolean {
  return frame >= range.startFrame && frame < range.startFrame + range.durationFrames
}

function sameSequenceSettings(
  left: StructureResearchSequenceSettings,
  right: StructureResearchSequenceSettings,
): boolean {
  return left.frameRate.num === right.frameRate.num
    && left.frameRate.den === right.frameRate.den
    && left.width === right.width
    && left.height === right.height
    && left.audioSampleRate === right.audioSampleRate
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

function validateSequenceSettings(
  settings: StructureResearchSequenceSettings,
  label: string,
): void {
  assertSafePositiveInteger(settings.frameRate.num, `${label}.frameRate.num`)
  assertSafePositiveInteger(settings.frameRate.den, `${label}.frameRate.den`)
  if (greatestCommonDivisor(settings.frameRate.num, settings.frameRate.den) !== 1) {
    throw new RangeError(`${label}.frameRate must be reduced`)
  }
  assertSafePositiveInteger(settings.width, `${label}.width`)
  assertSafePositiveInteger(settings.height, `${label}.height`)
  assertSafePositiveInteger(settings.audioSampleRate, `${label}.audioSampleRate`)
}

function sequenceMapFor(
  project: StructureResearchSequenceProject,
): ReadonlyMap<string, StructureResearchSequence> {
  assertIdentifier(project.rootSequenceId, 'rootSequenceId')
  if (project.sequences.length === 0) {
    throw new RangeError('sequence project must contain at least one sequence')
  }
  const sequenceMap = new Map<string, StructureResearchSequence>()
  for (const sequence of project.sequences) {
    assertIdentifier(sequence.id, 'sequence.id')
    if (sequenceMap.has(sequence.id)) {
      throw new RangeError(`duplicate sequence id "${sequence.id}"`)
    }
    assertSafePositiveInteger(sequence.durationFrames, `sequence "${sequence.id}" durationFrames`)
    validateSequenceSettings(sequence.settings, `sequence "${sequence.id}" settings`)
    sequenceMap.set(sequence.id, sequence)
  }
  if (!sequenceMap.has(project.rootSequenceId)) {
    throw new RangeError(`missing root sequence "${project.rootSequenceId}"`)
  }
  return sequenceMap
}

/**
 * Validate the proposed project-level sequence graph and freeze its ownership
 * facts. The bounded MVP intentionally requires identical sequence settings,
 * making parent/child frame mapping exact and avoiding implicit resampling.
 */
export function analyzeStructureResearchSequenceGraph(
  project: StructureResearchSequenceProject,
): StructureResearchSequenceAnalysis {
  const sequenceMap = sequenceMapFor(project)
  let referenceCount = 0

  for (const sequence of project.sequences) {
    const itemIds = new Set<string>()
    for (const source of sequence.sources) {
      assertIdentifier(source.id, `sequence "${sequence.id}" source.id`)
      if (itemIds.has(source.id)) {
        throw new RangeError(`duplicate item id "${source.id}" in sequence "${sequence.id}"`)
      }
      itemIds.add(source.id)
      const endFrame = frameRangeEnd(source.range, `source "${source.id}" range`)
      if (endFrame > sequence.durationFrames) {
        throw new RangeError(`source "${source.id}" exceeds sequence "${sequence.id}"`)
      }
    }
    for (const instance of sequence.instances) {
      referenceCount++
      assertIdentifier(instance.id, `sequence "${sequence.id}" instance.id`)
      if (itemIds.has(instance.id)) {
        throw new RangeError(`duplicate item id "${instance.id}" in sequence "${sequence.id}"`)
      }
      itemIds.add(instance.id)
      const child = sequenceMap.get(instance.sequenceId)
      if (!child) {
        throw new RangeError(
          `instance "${instance.id}" references missing sequence "${instance.sequenceId}"`,
        )
      }
      if (!sameSequenceSettings(sequence.settings, child.settings)) {
        throw new RangeError(
          `instance "${instance.id}" crosses the bounded same-settings MVP`,
        )
      }
      const endFrame = frameRangeEnd(instance.range, `instance "${instance.id}" range`)
      if (endFrame > sequence.durationFrames) {
        throw new RangeError(`instance "${instance.id}" exceeds sequence "${sequence.id}"`)
      }
      assertSafeNonNegativeInteger(
        instance.sourceStartFrame,
        `instance "${instance.id}" sourceStartFrame`,
      )
      const sourceEndFrame = instance.sourceStartFrame + instance.range.durationFrames
      if (!Number.isSafeInteger(sourceEndFrame) || sourceEndFrame > child.durationFrames) {
        throw new RangeError(`instance "${instance.id}" exceeds child "${child.id}"`)
      }
    }
  }

  const visitState = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const topologicalOrder: string[] = []
  let maxDepth = 0

  const visit = (sequenceId: string, depth: number): void => {
    const state = visitState.get(sequenceId)
    if (state === 'visited') return
    if (state === 'visiting') {
      const cycleStart = stack.indexOf(sequenceId)
      const cycle = [...stack.slice(cycleStart), sequenceId]
      throw new RangeError(`nested sequence cycle: ${cycle.join(' -> ')}`)
    }
    if (depth > STRUCTURE_RESEARCH_MAX_SEQUENCE_DEPTH) {
      throw new RangeError(
        `nested sequence depth exceeds ${STRUCTURE_RESEARCH_MAX_SEQUENCE_DEPTH}`,
      )
    }
    maxDepth = Math.max(maxDepth, depth)
    visitState.set(sequenceId, 'visiting')
    stack.push(sequenceId)
    const sequence = sequenceMap.get(sequenceId)
    if (!sequence) throw new RangeError(`missing sequence "${sequenceId}"`)
    for (const instance of sequence.instances) {
      visit(instance.sequenceId, depth + 1)
    }
    stack.pop()
    visitState.set(sequenceId, 'visited')
    topologicalOrder.push(sequenceId)
  }

  visit(project.rootSequenceId, 1)
  const reachableSequenceCount = visitState.size
  for (const sequence of project.sequences) {
    visit(sequence.id, 1)
  }

  return Object.freeze({
    rootSequenceId: project.rootSequenceId,
    sequenceCount: project.sequences.length,
    referenceCount,
    reachableSequenceCount,
    maxDepth,
    topologicalOrder: Object.freeze(topologicalOrder),
  })
}

/** Expand one exact root frame through immutable, same-rate sequence instances. */
export function planStructureResearchNestedFrame(
  project: StructureResearchSequenceProject,
  frame: number,
): StructureResearchNestedFramePlan {
  assertSafeNonNegativeInteger(frame, 'frame')
  const analysis = analyzeStructureResearchSequenceGraph(project)
  const sequenceMap = sequenceMapFor(project)
  const root = sequenceMap.get(project.rootSequenceId)
  if (!root || frame >= root.durationFrames) {
    throw new RangeError('frame falls outside the root sequence')
  }
  const leafRequests: StructureResearchLeafRequest[] = []
  let visitedSequenceInstances = 0
  let maxDepth = 0

  const expand = (
    sequence: StructureResearchSequence,
    localFrame: number,
    instancePath: readonly string[],
    depth: number,
  ): void => {
    visitedSequenceInstances++
    maxDepth = Math.max(maxDepth, depth)
    for (const source of sequence.sources) {
      if (!rangeContains(source.range, localFrame)) continue
      if (leafRequests.length >= STRUCTURE_RESEARCH_MAX_LEAF_REQUESTS) {
        throw new RangeError(
          `nested frame exceeds ${STRUCTURE_RESEARCH_MAX_LEAF_REQUESTS} leaf requests`,
        )
      }
      leafRequests.push(Object.freeze({
        sequenceId: sequence.id,
        sourceId: source.id,
        localFrame,
        instancePath: Object.freeze([...instancePath]),
      }))
    }
    for (const instance of sequence.instances) {
      if (!rangeContains(instance.range, localFrame)) continue
      const child = sequenceMap.get(instance.sequenceId)
      if (!child) throw new RangeError(`missing sequence "${instance.sequenceId}"`)
      const childFrame = instance.sourceStartFrame
        + (localFrame - instance.range.startFrame)
      expand(child, childFrame, [...instancePath, instance.id], depth + 1)
    }
  }

  expand(root, frame, [], 1)
  return Object.freeze({
    rootSequenceId: analysis.rootSequenceId,
    rootFrame: frame,
    leafRequests: Object.freeze(leafRequests),
    visitedSequenceInstances,
    maxDepth,
  })
}

interface IndexedAdjustmentItem {
  readonly item: StructureResearchAdjustmentItem
  readonly startFrame: number
  readonly endFrame: number
}

function activeAdjustmentItemAt(
  items: readonly IndexedAdjustmentItem[],
  frame: number,
): { readonly item: StructureResearchAdjustmentItem | null; readonly comparisons: number } {
  let lower = 0
  let upper = items.length
  let comparisons = 0
  while (lower < upper) {
    comparisons++
    const middle = lower + Math.floor((upper - lower) / 2)
    if (items[middle].startFrame <= frame) lower = middle + 1
    else upper = middle
  }
  if (lower === 0) return { item: null, comparisons }
  comparisons++
  const candidate = items[lower - 1]
  return {
    item: frame < candidate.endFrame ? candidate.item : null,
    comparisons,
  }
}

/** Prototype a post-composite adjustment boundary over track-indexed ranges. */
export function createStructureResearchAdjustmentPlanner(
  tracks: readonly StructureResearchAdjustmentTrack[],
): StructureResearchAdjustmentPlanner {
  const trackIds = new Set<string>()
  const itemIds = new Set<string>()
  const indexedTracks: Array<{
    readonly id: string
    readonly hidden: boolean
    readonly items: readonly IndexedAdjustmentItem[]
  }> = []

  for (const track of tracks) {
    assertIdentifier(track.id, 'adjustment track.id')
    if (trackIds.has(track.id)) throw new RangeError(`duplicate track id "${track.id}"`)
    trackIds.add(track.id)
    let previousEnd = -1
    const items: IndexedAdjustmentItem[] = []
    for (const item of track.items) {
      assertIdentifier(item.id, `track "${track.id}" item.id`)
      if (itemIds.has(item.id)) throw new RangeError(`duplicate adjustment item id "${item.id}"`)
      itemIds.add(item.id)
      const endFrame = frameRangeEnd(item.range, `item "${item.id}" range`)
      if (item.range.startFrame < previousEnd) {
        throw new RangeError(`track "${track.id}" items must be sorted and non-overlapping`)
      }
      previousEnd = endFrame
      if (item.kind === 'adjustment') {
        assertSafePositiveInteger(item.effectCount, `adjustment "${item.id}" effectCount`)
        if (item.effectCount > STRUCTURE_RESEARCH_MAX_ADJUSTMENT_EFFECTS) {
          throw new RangeError(
            `adjustment "${item.id}" exceeds ${STRUCTURE_RESEARCH_MAX_ADJUSTMENT_EFFECTS} effects`,
          )
        }
      }
      items.push(Object.freeze({ item: Object.freeze({ ...item }), startFrame: item.range.startFrame, endFrame }))
    }
    indexedTracks.push(Object.freeze({
      id: track.id,
      hidden: track.hidden === true,
      items: Object.freeze(items),
    }))
  }

  return Object.freeze({
    planFrame(frame: number): StructureResearchAdjustmentFramePlan {
      assertSafeNonNegativeInteger(frame, 'frame')
      const operations: StructureResearchAdjustmentOperation[] = []
      let activeAdjustmentCount = 0
      let fullFramePassUpperBound = 0
      let rangeComparisons = 0
      for (const track of indexedTracks) {
        if (track.hidden) continue
        const active = activeAdjustmentItemAt(track.items, frame)
        rangeComparisons += active.comparisons
        if (!active.item) continue
        if (active.item.kind === 'source') {
          operations.push(Object.freeze({
            kind: 'paint-source',
            trackId: track.id,
            itemId: active.item.id,
          }))
          continue
        }
        if (operations.length === 0) continue
        activeAdjustmentCount++
        fullFramePassUpperBound += 1 + active.item.effectCount
        operations.push(Object.freeze({
          kind: 'apply-adjustment',
          trackId: track.id,
          itemId: active.item.id,
          effectCount: active.item.effectCount,
          lowerOperationCount: operations.length,
        }))
      }
      return Object.freeze({
        frame,
        operations: Object.freeze(operations),
        activeAdjustmentCount,
        fullFramePassUpperBound,
        rangeComparisons,
      })
    },
  })
}

function multicamSourceFrame(
  angle: StructureResearchMulticamAngle,
  frame: number,
): number | null {
  if (!rangeContains(angle.range, frame)) return null
  return angle.sourceStartFrame + (frame - angle.range.startFrame)
}

/** Prototype exact, independently selectable video/audio multicam cuts. */
export function createStructureResearchMulticamPlanner(
  multicam: StructureResearchMulticam,
): StructureResearchMulticamPlanner {
  assertSafePositiveInteger(multicam.durationFrames, 'multicam.durationFrames')
  if (
    multicam.angles.length < 2
    || multicam.angles.length > STRUCTURE_RESEARCH_MAX_MULTICAM_ANGLES
  ) {
    throw new RangeError(
      `multicam must contain 2..${STRUCTURE_RESEARCH_MAX_MULTICAM_ANGLES} angles`,
    )
  }
  if (
    multicam.switches.length === 0
    || multicam.switches.length > STRUCTURE_RESEARCH_MAX_MULTICAM_SWITCHES
  ) {
    throw new RangeError(
      `multicam must contain 1..${STRUCTURE_RESEARCH_MAX_MULTICAM_SWITCHES} switches`,
    )
  }
  const angleMap = new Map<string, StructureResearchMulticamAngle>()
  for (const angle of multicam.angles) {
    assertIdentifier(angle.id, 'multicam angle.id')
    if (angleMap.has(angle.id)) throw new RangeError(`duplicate multicam angle "${angle.id}"`)
    const endFrame = frameRangeEnd(angle.range, `angle "${angle.id}" range`)
    if (endFrame > multicam.durationFrames) {
      throw new RangeError(`angle "${angle.id}" exceeds multicam duration`)
    }
    assertSafeNonNegativeInteger(angle.sourceStartFrame, `angle "${angle.id}" sourceStartFrame`)
    const sourceEndFrame = angle.sourceStartFrame + angle.range.durationFrames
    if (!Number.isSafeInteger(sourceEndFrame)) {
      throw new RangeError(`angle "${angle.id}" source end must be a safe integer`)
    }
    angleMap.set(angle.id, Object.freeze({ ...angle }))
  }
  if (
    multicam.audioPolicy.kind === 'fixed'
    && !angleMap.has(multicam.audioPolicy.angleId)
  ) {
    throw new RangeError(`fixed audio references missing angle "${multicam.audioPolicy.angleId}"`)
  }
  let previousFrame = -1
  const switches = multicam.switches.map((item, index) => {
    assertSafeNonNegativeInteger(item.frame, `multicam switch ${index}.frame`)
    if (item.frame <= previousFrame || item.frame >= multicam.durationFrames) {
      throw new RangeError('multicam switches must be strictly increasing and in range')
    }
    if (!angleMap.has(item.videoAngleId)) {
      throw new RangeError(`multicam switch references missing angle "${item.videoAngleId}"`)
    }
    previousFrame = item.frame
    return Object.freeze({ ...item })
  })
  if (switches[0].frame !== 0) {
    throw new RangeError('the first multicam switch must begin at frame zero')
  }

  return Object.freeze({
    select(frame: number): StructureResearchMulticamSelection {
      assertSafeNonNegativeInteger(frame, 'frame')
      if (frame >= multicam.durationFrames) throw new RangeError('frame falls outside multicam duration')
      let lower = 0
      let upper = switches.length
      let switchComparisons = 0
      while (lower < upper) {
        switchComparisons++
        const middle = lower + Math.floor((upper - lower) / 2)
        if (switches[middle].frame <= frame) lower = middle + 1
        else upper = middle
      }
      const selectedSwitch = switches[lower - 1]
      const videoAngle = angleMap.get(selectedSwitch.videoAngleId)
      if (!videoAngle) throw new RangeError(`missing angle "${selectedSwitch.videoAngleId}"`)
      const audioAngleId = multicam.audioPolicy.kind === 'fixed'
        ? multicam.audioPolicy.angleId
        : selectedSwitch.videoAngleId
      const audioAngle = angleMap.get(audioAngleId)
      if (!audioAngle) throw new RangeError(`missing audio angle "${audioAngleId}"`)
      return Object.freeze({
        frame,
        switchFrame: selectedSwitch.frame,
        videoAngleId: videoAngle.id,
        videoSourceFrame: multicamSourceFrame(videoAngle, frame),
        audioAngleId: audioAngle.id,
        audioSourceFrame: multicamSourceFrame(audioAngle, frame),
        switchComparisons,
      })
    },
  })
}

/** Deterministic full-frame surface accounting for candidate child designs. */
export function structureResearchSurfaceEnvelope(
  width: number,
  height: number,
  surfaceCount: number,
): StructureResearchSurfaceEnvelope {
  let reason: string | null = null
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) {
    reason = 'surface dimensions must be positive safe integers'
  } else if (!Number.isSafeInteger(surfaceCount) || surfaceCount <= 0) {
    reason = 'surface count must be a positive safe integer'
  }
  const aggregateBytes = reason === null
    ? width * height * STRUCTURE_RESEARCH_BYTES_PER_PIXEL * surfaceCount
    : Number.NaN
  if (reason === null && !Number.isSafeInteger(aggregateBytes)) {
    reason = 'aggregate surface bytes must be a safe integer'
  } else if (
    reason === null
    && aggregateBytes > STRUCTURE_RESEARCH_MAX_SURFACE_BYTES
  ) {
    reason = 'aggregate surface bytes exceed the 256 MiB research envelope'
  }
  return Object.freeze({
    allowed: reason === null,
    width,
    height,
    surfaceCount,
    aggregateBytes,
    reason,
  })
}
