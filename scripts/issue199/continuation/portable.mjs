// Pure-domain host helpers. No top-level work, browser, listener,
// dependency install, or modification of existing fixture/product files.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function canonical(root, productSource, action) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } }).trim()
  // Fixture preparation may have uncommitted harness/output files. The entire
  // product/config diff must still match the reviewed source, before and after.
  const head = git('rev-parse', 'HEAD')
  assert.equal(git('diff', productSource, '--', 'src', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.app.json'), '')
  const server = await createServer({ root, configFile: false, envFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
  try {
    const result = await action(await server.ssrLoadModule('/src/domain/projectFile.ts'), (path) => server.ssrLoadModule(path))
    assert.equal(git('rev-parse', 'HEAD'), head, 'Source commit changed during canonical fixture/API work')
    assert.equal(git('diff', productSource, '--', 'src', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.app.json'), '')
    return result
  } finally { await server.close() }
}

export function serializeCanonicalSnapshot(root, productSource, snapshot) {
  return canonical(root, productSource, ({ createProjectFileSnapshot, serializeProjectFile, parseProjectFile }) => {
    const serialized = serializeProjectFile(createProjectFileSnapshot(snapshot.project, snapshot.assets, snapshot.collections))
    assert.equal(serializeProjectFile(parseProjectFile(serialized)), serialized)
    return serialized + '\n'
  })
}

export function prepareDenseScalarFixture(root, output, productSource) {
  return canonical(root, productSource, async ({ serializeProjectFile, parseProjectFile }, load) => {
    const originalPath = join(root, 'scripts/issue199/fixtures/dense.myrelith')
    const original = readFileSync(originalPath), originalManifest = JSON.parse(readFileSync(join(root, 'scripts/issue199/fixtures/manifest.json'), 'utf8'))
    assert.equal(hash(original), originalManifest.files['dense.myrelith'].sha256)
    const file = structuredClone(parseProjectFile(original.toString('utf8')))
    const owner = file.sequences[0].tracks[0].clips[0]
    const first = owner.animation.effectTracks.shift(); assert.equal(first.keyframes.length, 1024)
    owner.animation.tracks.push({ property: 'opacity', keyframes: first.keyframes })
    const count = owner.animation.tracks.reduce((sum, track) => sum + track.keyframes.length, 0) + owner.animation.effectTracks.reduce((sum, track) => sum + track.keyframes.length, 0)
    assert.equal(count, 100000)
    const { buildAnimationLaneIndex, animationCurvePoints, animationKeyGlyphs } = await load('/src/domain/animationLaneIndex.ts')
    const index = buildAnimationLaneIndex(file.sequences[0], {}), scalar = index.lanes.find((lane) => lane.address.kind === 'scalar' && lane.address.property === 'opacity')
    assert.equal(index.keyCount, 100000); assert.equal(scalar.status, 'scalar'); assert.equal(scalar.frames.length, 1024)
    assert.equal(scalar.frames[0], 0); assert.equal(scalar.frames.at(-1), 1023)
    const points = animationCurvePoints(scalar, 0, 1023).points, glyphs = animationKeyGlyphs(scalar, 0, 1023, 32)
    assert.ok(points.length > 0 && points.length <= 256); assert.ok(glyphs.length <= 32)
    const serialized = serializeProjectFile(file); assert.equal(serializeProjectFile(parseProjectFile(serialized)), serialized)
    const bytes = Buffer.from(serialized + '\n'), name = 'dense-scalar.myrelith'
    const manifest = { productSource, generatorSha256: hash(readFileSync(fileURLToPath(import.meta.url))), originalFixtureSha256: hash(original), scope: '100000 authored keys with one available1024-key opacity lane; other lanes remain unavailable and original committed fixture is unchanged.', domainValidation: { totalKeys: index.keyCount, scalarStatus: scalar.status, scalarKeys: scalar.frames.length, first: scalar.frames[0], last: scalar.frames.at(-1), curvePoints: points.length, glyphsAtBudget32: glyphs.length, canonicalRoundTripExact: true, browserRun: false }, files: { [name]: { bytes: bytes.length, sha256: hash(bytes) } } }
    mkdirSync(output, { recursive: true }); writeFileSync(join(output, name), bytes); writeFileSync(join(output, 'supplemental-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    return manifest
  })
}
