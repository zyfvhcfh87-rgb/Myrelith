import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { verifyPluginPackageArchive } from '../../app/pluginPackage'
import { selectPluginWasmProfile } from '../../domain/pluginWasmPolicy'
import { parsePluginWasmModule } from '../../workers/plugin-wasm/moduleParser'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SAMPLE_ROOT = join(REPO_ROOT, 'samples', 'plugins', 'audited-invert-v1')
const VERIFIER_PATH = join(SAMPLE_ROOT, 'verify.mjs')
const MODULE_SOURCE_PATH = join(SAMPLE_ROOT, 'source', 'module.mjs')
const PACKAGE_FILE = 'audited-invert-v1.myrelith-plugin'
const RELEASE_FILES = ['audit.json', PACKAGE_FILE, 'signature.json'] as const

interface SourceReport {
  readonly status: 'source-ready'
  readonly releaseState: 'absent' | 'present'
  readonly manifestBytes: number
  readonly moduleBytes: number
  readonly abi: {
    readonly entrypoint: string
    readonly memoryPages: number
    readonly parameterPointer: number
    readonly pixelPointer: number
  }
  readonly vectors: {
    readonly input: readonly number[]
    readonly false: { readonly code: number; readonly output: readonly number[] }
    readonly invalid: { readonly code: number; readonly output: readonly number[] }
    readonly true: { readonly code: number; readonly output: readonly number[] }
    readonly repeated: readonly number[]
    readonly fresh: readonly number[]
  }
}

interface ReleaseReport {
  readonly status: 'release-verified'
  readonly archiveBytes: number
  readonly archiveSha256: string
  readonly packageDigest: string
  readonly signerFingerprint: string
  readonly publicArtifacts: readonly string[]
  readonly privateArtifactsWritten: number
  readonly source: SourceReport
}

interface AuditedModuleSource {
  readonly AUDITED_INVERT_EXPORT: string
  readonly AUDITED_INVERT_FALSE_PARAMETERS: string
  readonly AUDITED_INVERT_MEMORY_PAGES: number
  readonly AUDITED_INVERT_PARAMETER_POINTER: number
  readonly AUDITED_INVERT_PIXEL_POINTER: number
  readonly AUDITED_INVERT_TRUE_PARAMETERS: string
  readonly buildAuditedInvertModule: () => Uint8Array
}

function runVerifier(...arguments_: string[]): unknown {
  return runVerifierAt(VERIFIER_PATH, ...arguments_)
}

function runVerifierAt(verifierPath: string, ...arguments_: string[]): unknown {
  return JSON.parse(execFileSync(
    process.execPath,
    [verifierPath, ...arguments_, '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ))
}

function checkoutText(sourcePath: string, targetPath: string, newline: '\r\n' | '\r'): void {
  const source = readFileSync(sourcePath, 'utf8')
  writeFileSync(targetPath, source.replace(/\r\n|\r|\n/g, newline), 'utf8')
}

function populateCheckoutCopy(root: string, newline: '\r\n' | '\r'): string {
  const sourceDirectory = join(root, 'source')
  mkdirSync(sourceDirectory, { recursive: true })
  checkoutText(VERIFIER_PATH, join(root, 'verify.mjs'), newline)
  checkoutText(MODULE_SOURCE_PATH, join(sourceDirectory, 'module.mjs'), newline)
  checkoutText(join(SAMPLE_ROOT, 'audit.json'), join(root, 'audit.json'), newline)
  for (const name of ['manifest.json', 'signature.json', PACKAGE_FILE]) {
    copyFileSync(join(SAMPLE_ROOT, name), join(root, name))
  }
  return join(root, 'verify.mjs')
}

function assertSafeTemporaryDirectory(path: string): void {
  const difference = relative(resolve(tmpdir()), resolve(path))
  if (difference === '' || difference.startsWith('..') || resolve(difference) === difference) {
    throw new Error('refusing to clean a directory outside the system temporary root')
  }
}

async function moduleSource(): Promise<AuditedModuleSource> {
  return await import(pathToFileURL(MODULE_SOURCE_PATH).href) as AuditedModuleSource
}

async function assertProductionAcceptance(packagePath: string): Promise<void> {
  const verified = await verifyPluginPackageArchive(new Uint8Array(readFileSync(packagePath)))
  expect(verified.manifest.id).toBe('com.myrelith.sample.audited-invert')
  expect(verified.manifest.permissions).toEqual([{
    id: 'myrelith.effect.video-frame.rgba8',
    maxVersion: 1,
    minVersion: 1,
    required: true,
  }])
  expect(verified.compatibility.status).toBe('compatible')
  const contribution = verified.manifest.contributions[0]
  expect(contribution).toMatchObject({
    contributionVersion: 1,
    descriptorVersion: 1,
    entrypoint: 'myrelith_effect_audited_invert',
    id: 'invert',
    kind: 'video-effect',
  })

  const facts = parsePluginWasmModule(verified.moduleBytes, {
    policy: selectPluginWasmProfile(verified.manifest),
    memoryMaximumPages: 1_025,
    renderEntrypoints: ['myrelith_effect_audited_invert'],
    migrationEntrypoints: [],
  })
  expect(facts.importedMemory).toEqual({ minimumPages: 1_025, maximumPages: 1_025 })
  expect(facts.definedFunctionCount).toBe(1)
  expect(facts.exportedFunctions).toEqual(['myrelith_effect_audited_invert'])
}

describe('audited sample plugin source and release artifact', () => {
  test('rebuilds the exact v1 module and proves deterministic visible behavior', async () => {
    const report = runVerifier('--source-check') as SourceReport
    expect(report).toMatchObject({
      status: 'source-ready',
      manifestBytes: 608,
      moduleBytes: 347,
      abi: {
        entrypoint: 'myrelith_effect_audited_invert',
        memoryPages: 1_025,
        parameterPointer: 0x0100_0000,
        pixelPointer: 0x0101_0000,
      },
      vectors: {
        input: [0, 1, 127, 255, 10, 20, 30, 40],
        false: { code: 1, output: [0, 1, 127, 255, 10, 20, 30, 40] },
        invalid: { code: 2, output: [0, 1, 127, 255, 10, 20, 30, 40] },
        true: { code: 0, output: [255, 254, 128, 255, 245, 235, 225, 40] },
        repeated: [255, 254, 128, 255, 245, 235, 225, 40],
        fresh: [255, 254, 128, 255, 245, 235, 225, 40],
      },
    })

    const source = await moduleSource()
    const moduleBytes = source.buildAuditedInvertModule()
    const ownedModuleBytes = new Uint8Array(moduleBytes.byteLength)
    ownedModuleBytes.set(moduleBytes)
    expect(WebAssembly.validate(ownedModuleBytes.buffer)).toBe(true)
    const memory = new WebAssembly.Memory({
      initial: source.AUDITED_INVERT_MEMORY_PAGES,
      maximum: source.AUDITED_INVERT_MEMORY_PAGES,
    })
    const instantiated = await WebAssembly.instantiate(
      ownedModuleBytes.buffer,
      { myrelith: { memory } },
    )
    const render = instantiated.instance.exports[source.AUDITED_INVERT_EXPORT]
    expect(typeof render).toBe('function')
    if (typeof render !== 'function') throw new Error('sample render export is missing')

    const bytes = new Uint8Array(memory.buffer)
    const input = Uint8Array.of(10, 20, 30, 40)
    const parameters = new TextEncoder().encode(source.AUDITED_INVERT_TRUE_PARAMETERS)
    bytes.set(parameters, source.AUDITED_INVERT_PARAMETER_POINTER)
    bytes.set(input, source.AUDITED_INVERT_PIXEL_POINTER)
    const code = render(
      source.AUDITED_INVERT_PIXEL_POINTER,
      1,
      1,
      4,
      0,
      0,
      30,
      1,
      source.AUDITED_INVERT_PARAMETER_POINTER,
      parameters.byteLength,
    )
    expect(code).toBe(0)
    expect([...bytes.slice(
      source.AUDITED_INVERT_PIXEL_POINTER,
      source.AUDITED_INVERT_PIXEL_POINTER + input.byteLength,
    )]).toEqual([245, 235, 225, 40])
  })

  test('creates and verifies only public trial artifacts outside the repository', async () => {
    const trialDirectory = mkdtempSync(join(tmpdir(), 'myrelith-audited-invert-'))
    assertSafeTemporaryDirectory(trialDirectory)
    try {
      const report = runVerifier('--trial-sign', trialDirectory) as ReleaseReport
      expect(report).toMatchObject({
        status: 'release-verified',
        privateArtifactsWritten: 0,
        publicArtifacts: [...RELEASE_FILES],
        source: { status: 'source-ready' },
      })
      expect(report.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(report.packageDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(report.signerFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(readdirSync(trialDirectory).sort()).toEqual([...RELEASE_FILES].sort())

      const signature = JSON.parse(readFileSync(join(trialDirectory, 'signature.json'), 'utf8'))
      expect(Object.keys(signature).sort()).toEqual([
        'algorithm',
        'entries',
        'fingerprint',
        'format',
        'formatVersion',
        'publicKey',
        'signature',
      ].sort())
      const audit = JSON.parse(readFileSync(join(trialDirectory, 'audit.json'), 'utf8'))
      expect(audit.release.privateKeyPersisted).toBe(false)
      expect(audit.release).not.toHaveProperty('privateKey')
      expect(audit.release).not.toHaveProperty('seed')
      await assertProductionAcceptance(join(trialDirectory, PACKAGE_FILE))
    } finally {
      rmSync(trialDirectory, { recursive: true, force: true })
    }
  })

  test('requires and verifies the immutable repository release', async () => {
    expect(RELEASE_FILES.map((name) => readdirSync(SAMPLE_ROOT).includes(name))).toEqual([
      true,
      true,
      true,
    ])
    const report = runVerifier('--check') as ReleaseReport
    expect(report.status).toBe('release-verified')
    expect(report.privateArtifactsWritten).toBe(0)
    await assertProductionAcceptance(join(SAMPLE_ROOT, PACKAGE_FILE))
  })

  test('normalizes checkout line endings for source evidence and rejects substantive drift', () => {
    const checkoutDirectory = mkdtempSync(join(tmpdir(), 'myrelith-audited-invert-checkout-'))
    assertSafeTemporaryDirectory(checkoutDirectory)
    try {
      for (const newline of ['\r\n', '\r'] as const) {
        const verifierPath = populateCheckoutCopy(checkoutDirectory, newline)
        expect(runVerifierAt(verifierPath, '--check')).toMatchObject({
          status: 'release-verified',
          archiveSha256: 'a809c6f086213064a90b63f1ca1e42c5e5215aa3cd874c706e15fe5edcded42e',
          packageDigest: 'sha256:ca3eaaba5a8a87ea88e313fd9f26dd1ebb9aefc217ea76ef219a35ca931f8b15',
          signerFingerprint: 'sha256:c955bcdaff60dc0593be20942f5f153ee4427765694b5e69a1e9a6caa5764139',
        })
      }

      writeFileSync(
        join(checkoutDirectory, 'source', 'module.mjs'),
        `${readFileSync(MODULE_SOURCE_PATH, 'utf8')}\n// substantive source drift\n`,
        'utf8',
      )
      const driftCheck = spawnSync(
        process.execPath,
        [join(checkoutDirectory, 'verify.mjs'), '--check', '--json'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
      expect(driftCheck.status).not.toBe(0)
      expect(driftCheck.stderr).toMatch(/audit\.json differs from recomputed evidence/u)
    } finally {
      rmSync(checkoutDirectory, { recursive: true, force: true })
    }
  })
})
