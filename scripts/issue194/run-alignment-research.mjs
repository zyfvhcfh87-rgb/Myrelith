import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const sourceFiles = [
  'src/domain/localProjectBinding.ts',
  'src/domain/multicamAlignmentResearch.ts',
  'src/domain/multicamAlignmentResearchFixtures.ts',
  'src/domain/multicamAlignmentProvenanceResearch.ts',
  'src/domain/multicamTimecodeResearch.ts',
  'src/domain/multicamAlignmentResearch.test.ts',
  'src/domain/multicamAlignmentProvenanceResearch.test.ts',
  'src/domain/multicamTimecodeResearch.test.ts',
  'src/test/architecture.test.ts',
  'scripts/issue194/run-alignment-research.mjs',
].sort()

function sourceFingerprint() {
  const hash = createHash('sha256')
  for (const path of sourceFiles) {
    hash.update(`${path}\0`)
    hash.update(readFileSync(new URL(`../../${path}`, import.meta.url)))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

const fingerprint = sourceFingerprint()
// Transform the pure TS proof with the repository's locked Vite; no listening server or app entry.
const server = await createServer({
  root, configFile: false, envFile: false, logLevel: 'error', appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true },
})

try {
  const { createResearchAudioFixture: fixture, runResearchCorrelation: correlate } = await server.ssrLoadModule(
    '/src/domain/multicamAlignmentResearchFixtures.ts',
  )
  const { ALIGNMENT_RESEARCH_LIMITS: limits } = await server.ssrLoadModule('/src/domain/multicamAlignmentResearch.ts')
  const { alignResearchTimecodes } = await server.ssrLoadModule('/src/domain/multicamTimecodeResearch.ts')
  const startedAt = performance.now()
  const quality = []
  for (const kind of ['coded-tone', 'speech-shaped', 'noise']) {
    const reference = fixture({ kind, inputSampleRate: 44_100, durationSeconds: 15 })
    for (const offsetSeconds of [-1.235, 0, 0.765]) {
      const target = fixture({
        kind, inputSampleRate: 48_000, durationSeconds: 15,
        recordingStartSeconds: offsetSeconds, gain: 0.5, channels: 2, invertRightChannel: true,
      })
      const { result, maxWorkBetweenYields } = correlate(reference, target)
      assert.equal(result.state, 'aligned', JSON.stringify({ kind, offsetSeconds, result }))
      const expectedFrame = Math.round(offsetSeconds * 30)
      assert.ok(Math.abs(result.offsetFrames - expectedFrame) <= 1, 'frame tolerance')
      assert.ok(maxWorkBetweenYields <= limits.yieldComparisons, 'cooperative work bound')
      quality.push({ kind, offsetSeconds, expectedFrame, measuredFrame: result.offsetFrames, ...result.facts })
    }
  }
  const negatives = []
  for (const kind of ['silence', 'steady-tone', 'repeated']) {
    const reference = fixture({ kind, inputSampleRate: 8_000 })
    const target = fixture({ kind, inputSampleRate: 8_000, recordingStartSeconds: 0.3 })
    const { result } = correlate(reference, target)
    assert.notEqual(result.state, 'aligned', kind)
    assert.ok(!('offsetFrames' in result), 'rejection must not expose an applicable offset')
    negatives.push({ kind, ...result })
  }
  const reference = fixture({ inputSampleRate: 8_000, durationSeconds: 30 })
  const eightAngles = []
  let totalComparisons = 0
  for (const offsetSeconds of [-3, -2, -1, 0, 1, 2, 3]) {
    const target = fixture({ inputSampleRate: 8_000, durationSeconds: 30, recordingStartSeconds: offsetSeconds })
    const { result, maxWorkBetweenYields } = correlate(reference, target)
    assert.equal(result.state, 'aligned')
    assert.equal(result.offsetFrames, offsetSeconds * 30)
    assert.ok(result.facts.comparisons <= limits.maxPairComparisons)
    assert.ok(maxWorkBetweenYields <= limits.yieldComparisons)
    totalComparisons += result.facts.comparisons
    eightAngles.push({ offsetSeconds, offsetFrames: result.offsetFrames, comparisons: result.facts.comparisons })
  }
  assert.ok(totalComparisons <= 7 * limits.maxPairComparisons)
  const timecode = (label, patch = {}) => ({
    format: 'normalized-timecode-research-v1', label, rate: { num: 30_000, den: 1_001 },
    counting: 'non-drop', origin: 'presentation-frame-zero', continuity: 'continuous',
    dayOffset: 0, clockDomain: 'fixture:common-clock-same-day', ...patch,
  })
  const validTimecode = alignResearchTimecodes(timecode('01:00:00:00'), timecode('01:00:02:05'), { num: 30_000, den: 1_001 })
  const dropFrame = alignResearchTimecodes(timecode('01:00:00:00'), timecode('01:00:02:05', { counting: 'drop-frame' }), { num: 30_000, den: 1_001 })
  assert.deepEqual(validTimecode, { state: 'aligned', offsetFrames: 65 })
  assert.equal(dropFrame.state, 'unavailable')
  assert.equal(sourceFingerprint(), fingerprint, 'research sources changed during the run')
  const report = {
    format: 'myrelith-multicam-alignment-research-v1', recordedAt: new Date().toISOString(),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceFingerprint: fingerprint, sourceFiles,
    dirtyTree: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    scope: { input: 'synthetic-float32-pcm', humanSpeechVerified: false, browserDecodeVerified: false, containerTimecodeAdapter: false, productIntegration: false },
    limits, quality, negatives, eightAngles, totalComparisons,
    timecode: { normalizedNonDrop: validTimecode, dropFrameRejected: dropFrame },
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
  }
  const directory = new URL('../../.tmp/issue194/', import.meta.url)
  mkdirSync(directory, { recursive: true })
  const output = new URL('alignment-research.json', directory)
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`Issue 194 research passed: ${quality.length} quality cases, ${negatives.length} negative cases, 8-angle work bound, strict normalized timecode.\n`)
  process.stdout.write(`Evidence: ${fileURLToPath(output)}\nSource: ${fingerprint}\n`)
} finally {
  await server.close()
}
