// Capture immutable pre-extraction numerical results; never imported by production.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../..', import.meta.url))
const commit = 'ce91074c276ca6892a74addb7dd673b9a19c7eeb'
const source = execFileSync('git', ['show', `${commit}:src/domain/clipAnimation.ts`], {
  cwd: root,
  env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' },
  encoding: 'utf8',
})
function block(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to <= from) throw new Error(`Baseline block missing: ${start}`)
  return source.slice(from, to)
}
const baselineSource = [
  block('export const MAX_KEYFRAMES_PER_TRACK', 'export const MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP'),
  block('export function animationEasingValidationError(', 'export function animationTrackValidationError('),
  block('function keyframesValidationError(', 'export function effectAnimationTrackValidationError('),
  block('function cubicCoordinate(', 'function applyAnimatedValues('),
].join('\n')
const baseline = {}
runInNewContext(ts.transpileModule(baselineSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: baseline }, { timeout: 1_000 })

function bits(value) {
  const bytes = Buffer.alloc(8)
  bytes.writeDoubleBE(value)
  return bytes.toString('hex')
}
const easings = [
  { type: 'hold' },
  { type: 'linear' },
  ...[
    [0, 0, 1, 1], [0.42, 0, 1, 1], [0, 0, 0.58, 1], [0.42, 0, 0.58, 1],
    [0.25, 0.1, 0.25, 1], [0, 0, 0, 0], [1, 1, 1, 1], [1, 0, 0, 1],
    [0, 1, 1, 0], [1, 1, 0, 0],
  ].map(([x1, y1, x2, y2]) => ({ type: 'cubic-bezier', x1, y1, x2, y2 })),
]
const tracks = easings.map((easing, index) => ({
  keyframes: [-1_000_000_000, -3, 0, 7, 31, 1_000_000_000].map((frame, keyIndex) => ({
    frame,
    sourceTimeTicks: frame * 1_000_000,
    value: [-1_000_000_000, 0, 0.99, 0.001, 123.456, 1_000_000_000][keyIndex],
    easing: easings[(index + keyIndex) % easings.length] ?? easing,
  })),
}))
const easingSamples = easings.flatMap((easing, easingIndex) =>
  [-1, 0, Number.EPSILON, 1e-8, 0.001, 0.125, 0.5, 0.875, 0.999, 1 - Number.EPSILON, 1, 2]
    .map((progress) => ({
      easingIndex, progress, expected: bits(baseline.animationEasingProgress(easing, progress)),
    })),
)
const fallback = -321.25
const samples = tracks.flatMap((track, trackIndex) =>
  [-1_000_000_001, -1_000_000_000, -999_999_999, -4, -3, -2.5, -1, 0, 0.25,
    1, 3.5, 6, 7, 8, 15, 30.999, 31, 32, 999_999_999, 1_000_000_000, 1_000_000_001]
    .map((frame) => ({
      trackIndex, frame,
      integer: bits(baseline.evaluateAnimationTrack(track, frame, fallback)),
      boundary: bits(baseline.evaluateAnimationTrackAtBoundaryPosition(track, frame, fallback)),
      validated: bits(baseline.evaluateValidatedAnimationTrackAtBoundaryPosition(track, frame, fallback)),
    })),
)
const output = new URL('../../src/test/fixtures/animation-scalar-baseline.json', import.meta.url)
mkdirSync(fileURLToPath(new URL('.', output)), { recursive: true })
writeFileSync(output, `${JSON.stringify({
  commit,
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  extractedSha256: createHash('sha256').update(baselineSource).digest('hex'),
  fallback, easings, tracks, easingSamples, samples,
}, null, 2)}\n`)
console.log(`Captured ${easingSamples.length} easing and ${samples.length * 3} scalar results from ${commit}.`)

const timingSource = execFileSync('git', ['show', `${commit}:src/domain/sourceTimeMap.ts`], {
  cwd: root,
  env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' },
  encoding: 'utf8',
})
const timing = {}
runInNewContext(ts.transpileModule(timingSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText, {
  exports: timing,
  require: (name) => {
    if (name !== './clipAnimation') throw new Error(`Unexpected baseline import: ${name}`)
    return baseline
  },
}, { timeout: 1_000 })
const oldMap = timing.defaultSourceTimeMap(37, 120)
const animations = [
  { tracks: [] },
  { tracks: [{ property: 'position-x', keyframes: [-5, 0, 3, 7, 90].map((frame, index) => ({
    frame, value: index * 3, easing: easings[index],
  })) }], effectTracks: [{ effectId: 'future-effect', parameter: 'future-parameter',
    keyframes: [{ frame: -9, value: 0.5, easing: easings[1] }] }] },
  { tracks: [{ property: 'volume', keyframes: [0, 1, 2].map((frame) => ({
    frame, sourceTimeTicks: (37 + frame) * 1_000_000, value: frame, easing: easings[1],
  })) }], effectTracks: [] },
  { tracks: [], effectTracks: [{ effectId: 'future-effect', parameter: 'future-parameter',
    keyframes: [{ frame: 7, sourceTimeTicks: Number.MAX_SAFE_INTEGER,
      value: 0.5, easing: easings[1] }] }] },
]
const shiftSamples = animations.flatMap((animation, animationIndex) =>
  [-2_000_000, 0, 3_000_000, Number.MAX_SAFE_INTEGER].map((delta) => ({
    animationIndex, delta,
    expected: timing.shiftClipAnimationSourceTimeIntent(animation, oldMap, delta),
  })),
)
const newMaps = [[1, 4], [3, 4], [1, 1], [3, 2], [4, 1]].map(([numerator, denominator]) => ({
  ...oldMap, rate: { numerator, denominator },
}))
const retimeSamples = animations.flatMap((animation, animationIndex) =>
  newMaps.map((newMap, mapIndex) => ({
    animationIndex, mapIndex,
    expected: timing.retimeClipAnimation(animation, oldMap, newMap, 120),
  })),
)
writeFileSync(new URL('../../src/test/fixtures/animation-timing-baseline.json', import.meta.url),
  `${JSON.stringify({ commit,
    sourceSha256: createHash('sha256').update(timingSource).digest('hex'),
    oldMap, newMaps, animations, shiftSamples, retimeSamples,
  }, null, 2)}\n`)
console.log(`Captured ${shiftSamples.length + retimeSamples.length} source-time outcomes from ${commit}.`)
