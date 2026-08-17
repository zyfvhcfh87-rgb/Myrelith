import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import {
  analyzeStructureResearchSequenceGraph,
  createStructureResearchAdjustmentPlanner,
  createStructureResearchMulticamPlanner,
  planStructureResearchNestedFrame,
  structureResearchSurfaceEnvelope,
} from '../../src/domain/editorStructureResearch.ts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const sourceFiles = [
  'src/domain/editorStructureResearch.ts',
  'src/domain/editorStructureResearch.test.ts',
  'scripts/issue78/run-structure-research.mjs',
]

function sourceFingerprint() {
  const hash = createHash('sha256')
  for (const path of sourceFiles) {
    hash.update(`${path}\0`)
    hash.update(readFileSync(new URL(`../../${path}`, import.meta.url)))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function benchmark(run) {
  const startedAt = performance.now()
  const result = run()
  return { result, elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10 }
}

function adjustmentEvidence() {
  const trackCount = 128
  const itemsPerTrack = 1_024
  const tracks = Array.from({ length: trackCount }, (_value, trackIndex) => ({
    id: `V${trackIndex + 1}`,
    items: Array.from({ length: itemsPerTrack }, (_item, itemIndex) => ({
      kind: trackIndex % 8 === 7 ? 'adjustment' : 'source',
      id: `track-${trackIndex}-item-${itemIndex}`,
      range: { startFrame: itemIndex * 4, durationFrames: 3 },
      ...(trackIndex % 8 === 7 ? { effectCount: 3 } : {}),
    })),
  }))
  const planner = createStructureResearchAdjustmentPlanner(tracks)
  let comparisons = 0
  let operations = 0
  let fullFramePassUpperBound = 0
  const measured = benchmark(() => {
    for (let frame = 0; frame < 4_096; frame++) {
      const plan = planner.planFrame(frame)
      comparisons += plan.rangeComparisons
      operations += plan.operations.length
      fullFramePassUpperBound = Math.max(
        fullFramePassUpperBound,
        plan.fullFramePassUpperBound,
      )
    }
  })
  const comparisonBound = 4_096 * trackCount * 12
  if (comparisons > comparisonBound) {
    throw new Error(`adjustment lookup exceeded comparison bound: ${comparisons}`)
  }
  return {
    trackCount,
    itemsPerTrack,
    plannedFrames: 4_096,
    operations,
    comparisons,
    comparisonBound,
    maxFullFramePassUpperBound: fullFramePassUpperBound,
    elapsedMs: measured.elapsedMs,
  }
}

function sequenceEvidence() {
  const sequenceCount = 256
  const durationFrames = 2_000
  const settings = {
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
  }
  const sequences = Array.from({ length: sequenceCount }, (_value, index) => ({
    id: `sequence-${index}`,
    durationFrames,
    settings,
    sources: [{ id: `source-${index}`, range: { startFrame: 0, durationFrames } }],
    instances: [],
  }))
  sequences[0].instances = Array.from({ length: sequenceCount - 1 }, (_value, index) => ({
    id: `instance-${index + 1}`,
    sequenceId: `sequence-${index + 1}`,
    range: { startFrame: 0, durationFrames },
    sourceStartFrame: 0,
  }))
  const project = { rootSequenceId: 'sequence-0', sequences }
  const measured = benchmark(() => {
    let analysis
    for (let iteration = 0; iteration < 100; iteration++) {
      analysis = analyzeStructureResearchSequenceGraph(project)
    }
    return analysis
  })
  const framePlan = planStructureResearchNestedFrame(project, 1_000)
  if (framePlan.leafRequests.length !== sequenceCount) {
    throw new Error(`nested fixture planned ${framePlan.leafRequests.length} leaves`)
  }
  return {
    sequenceCount,
    referenceCount: measured.result.referenceCount,
    validationIterations: 100,
    maxDepth: measured.result.maxDepth,
    frameLeafRequests: framePlan.leafRequests.length,
    visitedSequenceInstances: framePlan.visitedSequenceInstances,
    elapsedMs: measured.elapsedMs,
  }
}

function multicamEvidence() {
  const durationFrames = 120_000
  const angleCount = 8
  const switchIntervalFrames = 5
  const switchCount = durationFrames / switchIntervalFrames
  const angles = Array.from({ length: angleCount }, (_value, index) => ({
    id: `angle-${index + 1}`,
    range: { startFrame: 0, durationFrames },
    sourceStartFrame: index * durationFrames,
  }))
  const switches = Array.from({ length: switchCount }, (_value, index) => ({
    frame: index * switchIntervalFrames,
    videoAngleId: angles[index % angles.length].id,
  }))
  const planner = createStructureResearchMulticamPlanner({
    durationFrames,
    angles,
    switches,
    audioPolicy: { kind: 'fixed', angleId: angles[0].id },
  })
  const lookupCount = 250_000
  let comparisons = 0
  let sourceFrameChecksum = 0
  const measured = benchmark(() => {
    for (let index = 0; index < lookupCount; index++) {
      const selection = planner.select(index % durationFrames)
      comparisons += selection.switchComparisons
      sourceFrameChecksum += selection.videoSourceFrame ?? 0
    }
  })
  const comparisonsPerLookupBound = Math.ceil(Math.log2(switchCount)) + 1
  if (comparisons > lookupCount * comparisonsPerLookupBound) {
    throw new Error(`multicam lookup exceeded comparison bound: ${comparisons}`)
  }
  return {
    angleCount,
    switchCount,
    lookupCount,
    comparisons,
    comparisonsPerLookupBound,
    sourceFrameChecksum,
    elapsedMs: measured.elapsedMs,
  }
}

const evidence = {
  schemaVersion: 1,
  issue: 78,
  generatedAt: new Date().toISOString(),
  baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim(),
  sourceFingerprint: sourceFingerprint(),
  fixtures: {
    adjustment: adjustmentEvidence(),
    sequences: sequenceEvidence(),
    multicam: multicamEvidence(),
  },
  surfaceEnvelope4k: {
    sevenSurfaces: structureResearchSurfaceEnvelope(3_840, 2_160, 7),
    eightSurfaces: structureResearchSurfaceEnvelope(3_840, 2_160, 8),
    nineSurfaces: structureResearchSurfaceEnvelope(3_840, 2_160, 9),
  },
}

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
