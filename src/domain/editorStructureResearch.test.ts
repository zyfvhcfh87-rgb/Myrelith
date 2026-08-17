import { describe, expect, test } from 'vitest'
import {
  analyzeStructureResearchSequenceGraph,
  createStructureResearchAdjustmentPlanner,
  createStructureResearchMulticamPlanner,
  planStructureResearchNestedFrame,
  structureResearchSurfaceEnvelope,
  STRUCTURE_RESEARCH_MAX_LEAF_REQUESTS,
  STRUCTURE_RESEARCH_MAX_SEQUENCE_DEPTH,
  type StructureResearchSequence,
  type StructureResearchSequenceProject,
} from './editorStructureResearch'

const settings = Object.freeze({
  frameRate: Object.freeze({ num: 30, den: 1 }),
  width: 1920,
  height: 1080,
  audioSampleRate: 48_000,
})

function sequence(
  id: string,
  sources: StructureResearchSequence['sources'] = [],
  instances: StructureResearchSequence['instances'] = [],
  durationFrames = 300,
): StructureResearchSequence {
  return { id, durationFrames, settings, sources, instances }
}

function nestedProject(): StructureResearchSequenceProject {
  return {
    rootSequenceId: 'root',
    sequences: [
      sequence('leaf', [{ id: 'camera', range: { startFrame: 20, durationFrames: 80 } }]),
      sequence('middle', [{ id: 'title', range: { startFrame: 0, durationFrames: 100 } }], [{
        id: 'leaf-instance',
        sequenceId: 'leaf',
        range: { startFrame: 10, durationFrames: 50 },
        sourceStartFrame: 20,
      }]),
      sequence('root', [{ id: 'bed', range: { startFrame: 0, durationFrames: 300 } }], [{
        id: 'middle-instance',
        sequenceId: 'middle',
        range: { startFrame: 100, durationFrames: 100 },
        sourceStartFrame: 0,
      }]),
    ],
  }
}

describe('Issue #78 sequence graph research', () => {
  test('returns children before parents and exact reachable depth', () => {
    const analysis = analyzeStructureResearchSequenceGraph(nestedProject())

    expect(analysis).toEqual({
      rootSequenceId: 'root',
      sequenceCount: 3,
      referenceCount: 2,
      reachableSequenceCount: 3,
      maxDepth: 3,
      topologicalOrder: ['leaf', 'middle', 'root'],
    })
  })

  test('maps a root frame through exact one-to-one child frame offsets', () => {
    const plan = planStructureResearchNestedFrame(nestedProject(), 135)

    expect(plan.leafRequests).toEqual([
      { sequenceId: 'root', sourceId: 'bed', localFrame: 135, instancePath: [] },
      { sequenceId: 'middle', sourceId: 'title', localFrame: 35, instancePath: ['middle-instance'] },
      {
        sequenceId: 'leaf',
        sourceId: 'camera',
        localFrame: 45,
        instancePath: ['middle-instance', 'leaf-instance'],
      },
    ])
    expect(plan.visitedSequenceInstances).toBe(3)
    expect(plan.maxDepth).toBe(3)
  })

  test('uses half-open instance and source ranges', () => {
    const project = nestedProject()

    expect(planStructureResearchNestedFrame(project, 109).leafRequests.map(
      (request) => request.sourceId,
    )).toEqual(['bed', 'title'])
    expect(planStructureResearchNestedFrame(project, 110).leafRequests.map(
      (request) => request.sourceId,
    )).toEqual(['bed', 'title', 'camera'])
    expect(planStructureResearchNestedFrame(project, 160).leafRequests.map(
      (request) => request.sourceId,
    )).toEqual(['bed', 'title'])
    expect(planStructureResearchNestedFrame(project, 200).leafRequests.map(
      (request) => request.sourceId,
    )).toEqual(['bed'])
  })

  test('rejects missing references and parent-child setting mismatches', () => {
    const missing = {
      rootSequenceId: 'root',
      sequences: [sequence('root', [], [{
        id: 'missing',
        sequenceId: 'nope',
        range: { startFrame: 0, durationFrames: 10 },
        sourceStartFrame: 0,
      }])],
    }
    expect(() => analyzeStructureResearchSequenceGraph(missing))
      .toThrow(/references missing sequence/)

    const mismatchChild = {
      ...sequence('child'),
      settings: { ...settings, frameRate: { num: 24, den: 1 } },
    }
    const mismatch = {
      rootSequenceId: 'root',
      sequences: [mismatchChild, sequence('root', [], [{
        id: 'child-instance',
        sequenceId: 'child',
        range: { startFrame: 0, durationFrames: 10 },
        sourceStartFrame: 0,
      }])],
    }
    expect(() => analyzeStructureResearchSequenceGraph(mismatch))
      .toThrow(/same-settings MVP/)
  })

  test('requires canonical reduced sequence frame rates', () => {
    const unreduced = {
      ...sequence('root'),
      settings: { ...settings, frameRate: { num: 60, den: 2 } },
    }

    expect(() => analyzeStructureResearchSequenceGraph({
      rootSequenceId: 'root',
      sequences: [unreduced],
    })).toThrow(/frameRate must be reduced/)
  })

  test('rejects direct, indirect, and dormant cycles', () => {
    const direct = {
      rootSequenceId: 'root',
      sequences: [sequence('root', [], [{
        id: 'self',
        sequenceId: 'root',
        range: { startFrame: 0, durationFrames: 10 },
        sourceStartFrame: 0,
      }])],
    }
    expect(() => analyzeStructureResearchSequenceGraph(direct))
      .toThrow('nested sequence cycle: root -> root')

    const indirect = {
      rootSequenceId: 'a',
      sequences: [
        sequence('a', [], [{ id: 'to-b', sequenceId: 'b', range: { startFrame: 0, durationFrames: 10 }, sourceStartFrame: 0 }]),
        sequence('b', [], [{ id: 'to-a', sequenceId: 'a', range: { startFrame: 0, durationFrames: 10 }, sourceStartFrame: 0 }]),
      ],
    }
    expect(() => analyzeStructureResearchSequenceGraph(indirect))
      .toThrow('nested sequence cycle: a -> b -> a')

    const dormant = {
      rootSequenceId: 'root',
      sequences: [
        sequence('root'),
        sequence('unused-a', [], [{ id: 'to-unused-b', sequenceId: 'unused-b', range: { startFrame: 0, durationFrames: 10 }, sourceStartFrame: 0 }]),
        sequence('unused-b', [], [{ id: 'to-unused-a', sequenceId: 'unused-a', range: { startFrame: 0, durationFrames: 10 }, sourceStartFrame: 0 }]),
      ],
    }
    expect(() => analyzeStructureResearchSequenceGraph(dormant))
      .toThrow('nested sequence cycle: unused-a -> unused-b -> unused-a')
  })

  test('enforces the bounded nesting depth', () => {
    const sequences: StructureResearchSequence[] = []
    for (let index = 0; index <= STRUCTURE_RESEARCH_MAX_SEQUENCE_DEPTH; index++) {
      const childId = `s${index + 1}`
      sequences.push(sequence(`s${index}`, [], index === STRUCTURE_RESEARCH_MAX_SEQUENCE_DEPTH
        ? []
        : [{
            id: `to-${childId}`,
            sequenceId: childId,
            range: { startFrame: 0, durationFrames: 10 },
            sourceStartFrame: 0,
          }]))
    }

    expect(() => analyzeStructureResearchSequenceGraph({ rootSequenceId: 's0', sequences }))
      .toThrow(`nested sequence depth exceeds ${STRUCTURE_RESEARCH_MAX_SEQUENCE_DEPTH}`)
  })

  test('bounds fan-out before a frame plan can allocate without limit', () => {
    const sources = Array.from({ length: STRUCTURE_RESEARCH_MAX_LEAF_REQUESTS + 1 }, (_value, index) => ({
      id: `source-${index}`,
      range: { startFrame: 0, durationFrames: 1 },
    }))
    const project = { rootSequenceId: 'root', sequences: [sequence('root', sources, [], 1)] }

    expect(() => planStructureResearchNestedFrame(project, 0))
      .toThrow(`nested frame exceeds ${STRUCTURE_RESEARCH_MAX_LEAF_REQUESTS} leaf requests`)
  })
})

describe('Issue #78 adjustment-layer research', () => {
  test('places adjustment operations after the complete lower composite', () => {
    const planner = createStructureResearchAdjustmentPlanner([
      { id: 'V1', items: [{ kind: 'source', id: 'base', range: { startFrame: 0, durationFrames: 100 } }] },
      { id: 'V2', items: [{ kind: 'source', id: 'title', range: { startFrame: 0, durationFrames: 50 } }] },
      { id: 'V3', items: [{ kind: 'adjustment', id: 'grade', range: { startFrame: 10, durationFrames: 30 }, effectCount: 2 }] },
      { id: 'V4', items: [{ kind: 'source', id: 'logo', range: { startFrame: 0, durationFrames: 100 } }] },
      { id: 'V5', items: [{ kind: 'adjustment', id: 'vignette', range: { startFrame: 20, durationFrames: 10 }, effectCount: 1 }] },
    ])

    expect(planner.planFrame(25)).toMatchObject({
      operations: [
        { kind: 'paint-source', trackId: 'V1', itemId: 'base' },
        { kind: 'paint-source', trackId: 'V2', itemId: 'title' },
        { kind: 'apply-adjustment', trackId: 'V3', itemId: 'grade', lowerOperationCount: 2 },
        { kind: 'paint-source', trackId: 'V4', itemId: 'logo' },
        { kind: 'apply-adjustment', trackId: 'V5', itemId: 'vignette', lowerOperationCount: 4 },
      ],
      activeAdjustmentCount: 2,
      fullFramePassUpperBound: 5,
    })
  })

  test('keeps half-open timing, hidden tracks, and empty-lower-stack no-ops explicit', () => {
    const planner = createStructureResearchAdjustmentPlanner([
      { id: 'empty-adjustment', items: [{ kind: 'adjustment', id: 'empty', range: { startFrame: 0, durationFrames: 5 }, effectCount: 1 }] },
      { id: 'hidden', hidden: true, items: [{ kind: 'source', id: 'hidden-source', range: { startFrame: 0, durationFrames: 100 } }] },
      { id: 'visible', items: [{ kind: 'source', id: 'source', range: { startFrame: 5, durationFrames: 5 } }] },
    ])

    expect(planner.planFrame(4).operations).toEqual([])
    expect(planner.planFrame(5).operations).toEqual([
      { kind: 'paint-source', trackId: 'visible', itemId: 'source' },
    ])
    expect(planner.planFrame(10).operations).toEqual([])
  })

  test('rejects overlapping track items and unbounded effect stacks', () => {
    expect(() => createStructureResearchAdjustmentPlanner([{ id: 'V1', items: [
      { kind: 'source', id: 'a', range: { startFrame: 0, durationFrames: 10 } },
      { kind: 'source', id: 'b', range: { startFrame: 9, durationFrames: 10 } },
    ] }])).toThrow(/sorted and non-overlapping/)

    expect(() => createStructureResearchAdjustmentPlanner([{ id: 'V1', items: [{
      kind: 'adjustment',
      id: 'too-many',
      range: { startFrame: 0, durationFrames: 10 },
      effectCount: 33,
    }] }])).toThrow(/exceeds 32 effects/)
  })

  test('uses a logarithmic range index per visible track', () => {
    const items = Array.from({ length: 1_024 }, (_value, index) => ({
      kind: 'source' as const,
      id: `item-${index}`,
      range: { startFrame: index * 2, durationFrames: 1 },
    }))
    const plan = createStructureResearchAdjustmentPlanner([{ id: 'V1', items }])
      .planFrame(1_998)

    expect(plan.operations).toHaveLength(1)
    expect(plan.rangeComparisons).toBeLessThanOrEqual(12)
  })
})

describe('Issue #78 multicam research', () => {
  const multicam = {
    durationFrames: 120,
    angles: [
      { id: 'wide', range: { startFrame: 0, durationFrames: 120 }, sourceStartFrame: 300 },
      { id: 'close', range: { startFrame: 10, durationFrames: 100 }, sourceStartFrame: 800 },
      { id: 'roam', range: { startFrame: 20, durationFrames: 80 }, sourceStartFrame: 1_200 },
    ],
    switches: [
      { frame: 0, videoAngleId: 'wide' },
      { frame: 30, videoAngleId: 'close' },
      { frame: 70, videoAngleId: 'roam' },
    ],
    audioPolicy: { kind: 'fixed' as const, angleId: 'wide' },
  }

  test('keeps video cuts separate from one fixed master audio angle', () => {
    const planner = createStructureResearchMulticamPlanner(multicam)

    expect(planner.select(29)).toMatchObject({
      switchFrame: 0,
      videoAngleId: 'wide',
      videoSourceFrame: 329,
      audioAngleId: 'wide',
      audioSourceFrame: 329,
    })
    expect(planner.select(30)).toMatchObject({
      switchFrame: 30,
      videoAngleId: 'close',
      videoSourceFrame: 820,
      audioAngleId: 'wide',
      audioSourceFrame: 330,
    })
    expect(planner.select(70)).toMatchObject({
      switchFrame: 70,
      videoAngleId: 'roam',
      videoSourceFrame: 1_250,
      audioAngleId: 'wide',
      audioSourceFrame: 370,
    })
  })

  test('supports explicit audio-follows-video without changing cut math', () => {
    const planner = createStructureResearchMulticamPlanner({
      ...multicam,
      audioPolicy: { kind: 'follow-video' },
    })

    expect(planner.select(30)).toMatchObject({
      videoAngleId: 'close',
      videoSourceFrame: 820,
      audioAngleId: 'close',
      audioSourceFrame: 820,
    })
  })

  test('returns explicit unavailable coverage instead of falling back angles', () => {
    const planner = createStructureResearchMulticamPlanner({
      ...multicam,
      switches: [{ frame: 0, videoAngleId: 'close' }],
    })

    expect(planner.select(5)).toMatchObject({
      videoAngleId: 'close',
      videoSourceFrame: null,
      audioAngleId: 'wide',
      audioSourceFrame: 305,
    })
  })

  test('requires a bounded angle set and a canonical switch at frame zero', () => {
    expect(() => createStructureResearchMulticamPlanner({
      ...multicam,
      angles: [multicam.angles[0]],
    })).toThrow(/2..8 angles/)
    expect(() => createStructureResearchMulticamPlanner({
      ...multicam,
      switches: [{ frame: 1, videoAngleId: 'wide' }],
    })).toThrow(/first multicam switch must begin at frame zero/)
  })

  test('rejects unsafe angle source ranges before selection', () => {
    expect(() => createStructureResearchMulticamPlanner({
      ...multicam,
      angles: [
        { ...multicam.angles[0], sourceStartFrame: Number.MAX_SAFE_INTEGER - 10 },
        multicam.angles[1],
      ],
      switches: [{ frame: 0, videoAngleId: 'wide' }],
    })).toThrow(/source end must be a safe integer/)
  })

  test('uses logarithmic switch selection for large edit lists', () => {
    const switches = Array.from({ length: 65_536 }, (_value, index) => ({
      frame: index,
      videoAngleId: index % 2 === 0 ? 'wide' : 'close',
    }))
    const planner = createStructureResearchMulticamPlanner({
      durationFrames: 65_536,
      angles: [
        { id: 'wide', range: { startFrame: 0, durationFrames: 65_536 }, sourceStartFrame: 0 },
        { id: 'close', range: { startFrame: 0, durationFrames: 65_536 }, sourceStartFrame: 0 },
      ],
      switches,
      audioPolicy: { kind: 'fixed', angleId: 'wide' },
    })

    expect(planner.select(65_535).switchComparisons).toBeLessThanOrEqual(17)
  })
})

describe('Issue #78 full-frame surface research', () => {
  test('pins the narrow 4K headroom that child issues must preserve', () => {
    expect(structureResearchSurfaceEnvelope(3_840, 2_160, 7)).toMatchObject({
      allowed: true,
      aggregateBytes: 232_243_200,
    })
    expect(structureResearchSurfaceEnvelope(3_840, 2_160, 8)).toMatchObject({
      allowed: true,
      aggregateBytes: 265_420_800,
    })
    expect(structureResearchSurfaceEnvelope(3_840, 2_160, 9)).toMatchObject({
      allowed: false,
      aggregateBytes: 298_598_400,
      reason: 'aggregate surface bytes exceed the 256 MiB research envelope',
    })
  })
})
