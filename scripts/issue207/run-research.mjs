#!/usr/bin/env node
/** Local Issue #207 evidence runner. Writes facts and hashes, never media bytes. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import os from 'node:os'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { SCHEMA } from './protocol.mjs'
import { CANDIDATES, RANKING_AUTHORITY, RANKING_RECORDED_AT, RUBRIC } from './ranking.mjs'
import { assertPinnedVocabulary, productPolicy, staticInventoryRows } from './inventory.mjs'
import { fixtureDirectory, generateFixtures } from './fixtures.mjs'
import { probeDemuxFile } from './demux.mjs'
import { measureDecoderPayloads } from './sizes.mjs'
import { evaluateAll } from './decision.mjs'

const root = process.cwd()
const nodeOnly = process.argv.includes('--node-only')
const port = 42207
const artifactDir = resolve(root, '.tmp/issue207')
const evidenceDir = resolve(root, 'docs/evidence/issue207')

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: root }).trim()
}

function walkSrc(directory, hits, needles) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      walkSrc(path, hits, needles)
      continue
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) continue
    const text = readFileSync(path, 'utf8')
    for (const needle of needles) {
      if (text.includes(needle)) hits.push({ path: path.slice(root.length + 1), needle })
    }
  }
  return hits
}

function scanProduct() {
  const hits = walkSrc(resolve(root, 'src'), [], [
    'registerAc3Encoder',
    'registerProresEncoder',
    'ffmpeg.wasm',
    '@ffmpeg/core',
  ])
  return {
    registersAc3Encoder: hits.some((hit) => hit.needle === 'registerAc3Encoder'),
    registersProresEncoder: hits.some((hit) => hit.needle === 'registerProresEncoder'),
    ffmpegWasm: hits.some((hit) => hit.needle === 'ffmpeg.wasm' || hit.needle === '@ffmpeg/core'),
    hits,
  }
}

function base64(name, directory) {
  return readFileSync(join(directory, name)).toString('base64')
}

async function measureBrowser(fixtures) {
  const server = await createServer({
    root,
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      hmr: false,
      ws: false,
    },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({
      headless: true,
      args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    })
    const page = await browser.newPage()
    page.setDefaultTimeout(60_000)
    await page.goto(`http://127.0.0.1:${port}/scripts/issue207/lab.html`)
    const host = await page.evaluate(async () => {
      const lab = await import('/scripts/issue207/lab.mjs')
      return lab.hostFacts()
    })
    const names = [
      'pcm-s16.wav', 'mp3.mp3', 'flac.flac', 'vorbis.ogg',
      'avc-aac.mp4', 'avc-aac.mov', 'avc-aac.ts',
      'vp9-opus.webm', 'vp8-opus.webm', 'av1-opus.webm',
      'hevc-aac.mp4', 'avc-ac3.mkv', 'prores.mov',
      'mpeg2-aac.ts', 'avc-dts.mkv', 'playlist.m3u8',
    ]
    const measured = {}
    for (const name of names) {
      process.stdout.write(`Browser measure ${name}\n`)
      measured[name] = await page.evaluate(async ({ b64, cancel }) => {
        const binary = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0))
        const lab = await import('/scripts/issue207/lab.mjs')
        return lab.measureBytes(binary, { cancel })
      }, { b64: base64(name, fixtures.outputDirectory), cancel: name === 'avc-aac.mp4' })
    }
    const encoders = await page.evaluate(async () => {
      const lab = await import('/scripts/issue207/lab.mjs')
      return lab.measureEncoders()
    })
    process.stdout.write('Browser measure existing ProRes/AC-3 fallbacks\n')
    const fallbacks = await page.evaluate(async ({ prores, ac3 }) => {
      const toBytes = (b64) => Uint8Array.from(atob(b64), (char) => char.charCodeAt(0))
      const lab = await import('/scripts/issue207/lab.mjs')
      return lab.measureExistingFallbacks(toBytes(prores), toBytes(ac3))
    }, {
      prores: base64('prores.mov', fixtures.outputDirectory),
      ac3: base64('avc-ac3.mkv', fixtures.outputDirectory),
    })
    const cdp = await browser.newBrowserCDPSession()
    const version = await cdp.send('Browser.getVersion')
    let gpu = null
    try { gpu = await cdp.send('SystemInfo.getInfo') } catch { gpu = { error: 'SystemInfo.getInfo-unavailable' } }
    return {
      host,
      browserVersion: browser.version(),
      browserFacts: version,
      gpu,
      fixtures: measured,
      encoders,
      fallbacks,
    }
  } finally {
    await browser?.close()
    await server.close()
  }
}

function decodeCell(cell) {
  if (cell.canRead === false) return cell.failClosed || cell.error ? 'unsupported' : 'unsupported'
  const video = cell.decode?.video
  const audio = cell.decode?.audio
  const issues = []
  if (video?.skipped === 'not-decodable') issues.push('video-undecodable')
  if (audio?.skipped === 'not-decodable') issues.push('audio-undecodable')
  if (video && !video.skipped && video.ok !== true) issues.push('video-seek')
  if (audio && !audio.skipped && audio.ok !== true) issues.push('audio-seek')
  if (issues.length) return `limited (${issues.join(', ')})`
  if (cell.decode?.ok) return 'ready'
  return 'limited'
}

function renderMarkdown(result) {
  const lines = [
    '# Issue #207 measured run',
    '',
    `Schema \`${result.schema}\`. Host ${result.machine.platform}/${result.machine.arch}.`,
    'Firefox and Safari cells are **U** (Issue #208). This run does not ship formats.',
    '',
    '## Decisions',
    '',
    '| Candidate | Recommendation |',
    '|---|---|',
  ]
  for (const decision of result.decisions) {
    lines.push(`| \`${decision.id}\` | **${decision.recommendation}** |`)
  }
  lines.push('', '## Demux (Node, Mediabunny 1.50.9)', '', '| Fixture | Format | Codecs | canDecode (Node) |', '|---|---|---|---|')
  for (const [name, probe] of Object.entries(result.demux)) {
    const codecs = (probe.tracks ?? []).map((track) => `${track.kind}:${track.codec ?? 'null'}`).join(', ') || 'none'
    const decode = (probe.tracks ?? []).map((track) => String(track.canDecode)).join(',') || 'n/a'
    lines.push(`| \`${name}\` | ${probe.format?.name ?? (probe.failClosed ? 'fail-closed' : 'unread')} | ${codecs} | ${decode} |`)
  }
  if (result.browser) {
    lines.push('', `## Chromium decode / encode`, '')
    lines.push(`Host: \`${result.browser.host?.userAgent ?? 'unknown'}\`. Isolated: ${result.browser.host?.crossOriginIsolated}. HEVC observation: ${result.browser.host?.hevcHardwareObservation}. AV1 observation: ${result.browser.host?.av1HardwareObservation}. Firefox/Safari: **U**.`)
    lines.push('', '| Fixture | Direct decode | Notes |', '|---|---|---|')
    for (const [name, cell] of Object.entries(result.browser.fixtures ?? {})) {
      lines.push(`| \`${name}\` | ${decodeCell(cell)} | ${cell.format?.name ?? cell.error ?? ''} |`)
    }
    lines.push('', '### Existing fallback path (already shipped, not a new format)', '')
    const fallbacks = result.browser.fallbacks
    if (fallbacks) {
      const proresDirect = fallbacks.direct?.prores?.tracks?.find((track) => track.kind === 'video')
      const proresAfter = fallbacks.fallback?.prores?.tracks?.find((track) => track.kind === 'video')
      const ac3Direct = fallbacks.direct?.ac3?.tracks?.find((track) => track.kind === 'audio')
      const ac3After = fallbacks.fallback?.ac3?.tracks?.find((track) => track.kind === 'audio')
      lines.push(`- ProRes direct \`canDecode\`: ${proresDirect?.nativeCanDecode}; after \`registerProresDecoder\`: ${proresAfter?.nativeCanDecode}; sample seek: ${fallbacks.fallback?.prores?.decode?.video?.ok}`)
      lines.push(`- AC-3 direct \`canDecode\`: ${ac3Direct?.nativeCanDecode}; after \`registerAc3Decoder\`: ${ac3After?.nativeCanDecode}; sample seek: ${fallbacks.fallback?.ac3?.decode?.audio?.ok}`)
      lines.push(`- Encoder registration attempted: ${fallbacks.encoderRegistration === true}`)
    }
    lines.push('', '### Native encoder probes', '')
    for (const row of result.browser.encoders?.video ?? []) {
      lines.push(`- video \`${row.id}\`: ${row.supported ? 'supported' : 'unsupported'}`)
    }
    for (const row of result.browser.encoders?.audio ?? []) {
      lines.push(`- audio \`${row.id}\`: ${row.supported ? 'supported' : 'unsupported'}`)
    }
  } else {
    lines.push('', 'Browser lab skipped (`--node-only`). Chromium cells remain **U** until `npm run qa:issue207:research`.', '')
  }
  lines.push('', '## Payload sizes', '')
  for (const payload of result.sizes.payloads) {
    lines.push(`- ${payload.packageName}: ${payload.primaryBundle?.bytes ?? payload.totalBytes} bytes primary bundle (${payload.license})`)
  }
  return `${lines.join('\n')}\n`
}

const researchSources = [
  'scripts/issue207/protocol.mjs',
  'scripts/issue207/ranking.mjs',
  'scripts/issue207/inventory.mjs',
  'scripts/issue207/fixtures.mjs',
  'scripts/issue207/demux.mjs',
  'scripts/issue207/sizes.mjs',
  'scripts/issue207/decision.mjs',
  'scripts/issue207/lab.mjs',
  'scripts/issue207/run-research.mjs',
]

async function main() {
  mkdirSync(artifactDir, { recursive: true })
  mkdirSync(evidenceDir, { recursive: true })
  const vocabulary = assertPinnedVocabulary()
  const fixtures = generateFixtures(fixtureDirectory(root))
  process.stdout.write(`Generated ${fixtures.fixtures.length} fixtures\n`)

  const demux = {}
  for (const fixture of fixtures.fixtures) {
    process.stdout.write(`Demux ${fixture.name}\n`)
    const probe = await probeDemuxFile(join(fixtures.outputDirectory, fixture.name))
    delete probe.filePath
    demux[fixture.name] = { ...probe, sha256: fixture.sha256, bytes: fixture.bytes }
  }

  const product = scanProduct()
  const sizes = measureDecoderPayloads(root)
  let browser = null
  if (!nodeOnly) browser = await measureBrowser(fixtures)
  const evidence = { demux, browser, product }
  const decisionsFromNamed = evaluateAll(evidence)

  const result = {
    schema: SCHEMA,
    startedAt: new Date().toISOString(),
    commit: git('rev-parse', 'HEAD'),
    ranking: { recordedAt: RANKING_RECORDED_AT, authority: RANKING_AUTHORITY, rubric: RUBRIC, candidates: CANDIDATES },
    vocabulary,
    inventory: staticInventoryRows(),
    product: { ...productPolicy(), ...product },
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().map((cpu) => cpu.model),
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
    },
    fixtures: fixtures.fixtures,
    ffmpegVersion: fixtures.ffmpegVersion,
    demux,
    sizes,
    browser,
    decisions: decisionsFromNamed,
    sourceDigests: Object.fromEntries(researchSources.map((path) => [
      path,
      createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
    ])),
    wasmSpikes: CANDIDATES.filter((candidate) => candidate.paperVocabularyBlock).map((candidate) => ({
      id: candidate.id,
      ran: false,
    })),
  }

  const jsonPath = join(artifactDir, 'run.json')
  const evidenceJson = join(evidenceDir, 'measured-run.json')
  const evidenceMd = join(evidenceDir, 'measured-run.md')
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(evidenceJson, `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(evidenceMd, renderMarkdown(result))
  process.stdout.write(`Wrote ${evidenceJson}\n`)
  for (const decision of decisionsFromNamed) {
    process.stdout.write(`${decision.id}: ${decision.recommendation}\n`)
  }
}

await main()
