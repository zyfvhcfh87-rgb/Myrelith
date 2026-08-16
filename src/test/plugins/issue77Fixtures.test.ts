import { describe, expect, test } from 'vitest'
import {
  buildSignedPackageFixture,
  GOLDEN_MANIFEST_JSON,
  GOLDEN_PLUGIN_FACTS,
  GOLDEN_SIGNATURE_JSON,
  GOLDEN_WASM_HEX,
  goldenPluginArchive,
  hostileArchiveFixtures,
  ISSUE77_PACKAGE_BOUNDARIES,
} from './archiveFixtures'
import {
  base64urlDecode,
  base64urlEncode,
  decodeU32Leb,
  encodeU32Leb,
  hexBytes,
  sha256Hex,
  utf8Bytes,
  utf8Text,
} from './bytes'
import {
  classifyIssue77Message,
  createIssue77LifecycleLedger,
  issue77MessageCases,
} from './lifecycleFixtures'
import {
  buildFunctionCountModule,
  buildStatefulRenderModule,
  buildTypeCountModule,
  ISSUE77_MEMORY_PAGES,
  ISSUE77_PARAMETER_POINTER,
  ISSUE77_PIXEL_POINTER,
  issue77RenderArguments,
  ISSUE77_WASM_COUNT_BOUNDARIES,
  readSectionVectorCount,
  STATEFUL_SAMPLE_EXPORT,
  STATEFUL_SAMPLE_MODULE_PATH,
  statefulSampleManifestJson,
} from './wasmFixtures'

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

describe('Issue #77 independent fixture builders', () => {
  test('round-trips canonical byte encodings and rejects noncanonical u32 LEB', () => {
    for (const value of [0, 1, 127, 128, 16_384, 0xffff_ffff]) {
      expect(decodeU32Leb(encodeU32Leb(value))).toEqual({
        value,
        nextOffset: encodeU32Leb(value).byteLength,
      })
    }
    const publicKey = base64urlDecode(GOLDEN_PLUGIN_FACTS.publicKey)
    expect(publicKey).toHaveLength(32)
    expect(base64urlEncode(publicKey)).toBe(GOLDEN_PLUGIN_FACTS.publicKey)
    expect(() => decodeU32Leb(Uint8Array.of(0x80, 0x00))).toThrow('noncanonical')
    expect(() => base64urlDecode(`${GOLDEN_PLUGIN_FACTS.publicKey}=`)).toThrow('canonical')
  })

  test('reconstructs and independently verifies the complete canonical golden package', async () => {
    const fixture = await buildSignedPackageFixture({
      manifestJson: GOLDEN_MANIFEST_JSON,
      modulePath: 'runtime/plugin.wasm',
      moduleBytes: hexBytes(GOLDEN_WASM_HEX),
    })

    expect(fixture.manifestBytes).toHaveLength(GOLDEN_PLUGIN_FACTS.manifestLength)
    expect(await sha256Hex(fixture.manifestBytes)).toBe(GOLDEN_PLUGIN_FACTS.manifestSha256)
    expect(fixture.moduleBytes).toHaveLength(GOLDEN_PLUGIN_FACTS.moduleLength)
    expect(await sha256Hex(fixture.moduleBytes)).toBe(GOLDEN_PLUGIN_FACTS.moduleSha256)
    expect(fixture.signedPayloadBytes).toHaveLength(GOLDEN_PLUGIN_FACTS.signedPayloadLength)
    expect(await sha256Hex(fixture.signedPayloadBytes)).toBe(GOLDEN_PLUGIN_FACTS.signedPayloadSha256)
    expect(fixture.signatureBytes).toHaveLength(GOLDEN_PLUGIN_FACTS.signatureEnvelopeLength)
    expect(await sha256Hex(fixture.signatureBytes)).toBe(GOLDEN_PLUGIN_FACTS.signatureEnvelopeSha256)
    expect(utf8Text(fixture.signatureBytes)).toBe(GOLDEN_SIGNATURE_JSON)
    expect(base64urlEncode(fixture.signature)).toBe(GOLDEN_PLUGIN_FACTS.signature)
    expect(fixture.packageDigest).toBe(GOLDEN_PLUGIN_FACTS.packageDigest)
    expect([...fixture.archive]).toEqual([...goldenPluginArchive()])

    const publicKey = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(base64urlDecode(GOLDEN_PLUGIN_FACTS.publicKey)).buffer,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    await expect(crypto.subtle.verify(
      'Ed25519',
      publicKey,
      Uint8Array.from(fixture.signature).buffer,
      Uint8Array.from(fixture.signedPayloadBytes).buffer,
    )).resolves.toBe(true)
  })

  test('builds deterministic hostile archive cases without production imports', () => {
    const fixtures = hostileArchiveFixtures()
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length)
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      'duplicate-entry',
      'absolute-path',
      'parent-segment',
      'backslash',
      'nul',
      'case-fold-collision',
      'unix-symlink',
      'checksum-mismatch',
      'trailing-bytes',
    ])
    for (const fixture of fixtures) {
      expect(fixture.expectedGate.length).toBeGreaterThan(0)
      expect([...fixture.build()]).toEqual([...fixture.build()])
    }
  })

  test('pins package byte, entry, and path exact boundaries lazily', () => {
    expect(ISSUE77_PACKAGE_BOUNDARIES.manifest.atMinimum()).toHaveLength(1)
    expect(ISSUE77_PACKAGE_BOUNDARIES.manifest.atMaximum()).toHaveLength(65_536)
    expect(ISSUE77_PACKAGE_BOUNDARIES.manifest.aboveMaximum()).toHaveLength(65_537)
    expect(ISSUE77_PACKAGE_BOUNDARIES.wasm.belowMinimum()).toHaveLength(7)
    expect(ISSUE77_PACKAGE_BOUNDARIES.wasm.atMinimum()).toHaveLength(8)
    expect(ISSUE77_PACKAGE_BOUNDARIES.wasm.maximum).toBe(32 * 1024 * 1024)
    expect(ISSUE77_PACKAGE_BOUNDARIES.expanded.maximum).toBe(64 * 1024 * 1024)
    expect(ISSUE77_PACKAGE_BOUNDARIES.entries.atMaximum()).toHaveLength(256)
    expect(ISSUE77_PACKAGE_BOUNDARIES.entries.aboveMaximum()).toHaveLength(257)
    expect(ISSUE77_PACKAGE_BOUNDARIES.runtimePath.atMaximum()).toHaveLength(240)
    expect(ISSUE77_PACKAGE_BOUNDARIES.runtimePath.aboveMaximum()).toHaveLength(241)
  })

  test('makes editor reuse and fresh export lifecycles observable in valid Wasm', async () => {
    const moduleBytes = buildStatefulRenderModule()
    expect(WebAssembly.validate(ownedArrayBuffer(moduleBytes))).toBe(true)

    const instantiate = async () => {
      const memory = new WebAssembly.Memory({
        initial: ISSUE77_MEMORY_PAGES,
        maximum: ISSUE77_MEMORY_PAGES,
      })
      const source = await WebAssembly.instantiate(
        ownedArrayBuffer(moduleBytes),
        { myrelith: { memory } },
      )
      const exported = source.instance.exports[STATEFUL_SAMPLE_EXPORT]
      if (typeof exported !== 'function') throw new TypeError('stateful fixture export is missing')
      return { memory, render: exported as (...arguments_: number[]) => number }
    }

    const editor = await instantiate()
    const editorBytes = new Uint8Array(editor.memory.buffer)
    editorBytes.set(utf8Bytes('{}'), ISSUE77_PARAMETER_POINTER)
    editorBytes[ISSUE77_PIXEL_POINTER] = 10
    expect(editor.render(...issue77RenderArguments())).toBe(0)
    expect(editorBytes[ISSUE77_PIXEL_POINTER]).toBe(11)
    editorBytes[ISSUE77_PIXEL_POINTER] = 10
    expect(editor.render(...issue77RenderArguments(0x1_0000_0001))).toBe(0)
    expect(editorBytes[ISSUE77_PIXEL_POINTER]).toBe(12)

    const freshExport = await instantiate()
    const exportBytes = new Uint8Array(freshExport.memory.buffer)
    exportBytes.set(utf8Bytes('{}'), ISSUE77_PARAMETER_POINTER)
    exportBytes[ISSUE77_PIXEL_POINTER] = 10
    expect(freshExport.render(...issue77RenderArguments())).toBe(0)
    expect(exportBytes[ISSUE77_PIXEL_POINTER]).toBe(11)
  })

  test('signs the stateful sample as a complete deterministic package', async () => {
    const moduleBytes = buildStatefulRenderModule()
    const manifestJson = statefulSampleManifestJson()
    const first = await buildSignedPackageFixture({
      manifestJson,
      modulePath: STATEFUL_SAMPLE_MODULE_PATH,
      moduleBytes,
    })
    const second = await buildSignedPackageFixture({
      manifestJson,
      modulePath: STATEFUL_SAMPLE_MODULE_PATH,
      moduleBytes,
    })

    expect(JSON.parse(manifestJson)).toMatchObject({
      id: 'com.myrelith.qa.stateful',
      runtime: { entry: STATEFUL_SAMPLE_MODULE_PATH, memoryMaximumPages: 258 },
      contributions: [{ entrypoint: STATEFUL_SAMPLE_EXPORT }],
    })
    expect(first.packageDigest).toBe(second.packageDigest)
    expect([...first.archive]).toEqual([...second.archive])
  })

  test('builds valid small modules and exact/+1 type and function count bombs', () => {
    expect(WebAssembly.validate(ownedArrayBuffer(buildTypeCountModule(3)))).toBe(true)
    expect(WebAssembly.validate(ownedArrayBuffer(buildFunctionCountModule(3)))).toBe(true)

    const maximumTypes = ISSUE77_WASM_COUNT_BOUNDARIES.types.atMaximum()
    const tooManyTypes = ISSUE77_WASM_COUNT_BOUNDARIES.types.aboveMaximum()
    expect(readSectionVectorCount(maximumTypes, 1)).toBe(1_024)
    expect(readSectionVectorCount(tooManyTypes, 1)).toBe(1_025)

    const maximumFunctions = ISSUE77_WASM_COUNT_BOUNDARIES.functions.atMaximum()
    const tooManyFunctions = ISSUE77_WASM_COUNT_BOUNDARIES.functions.aboveMaximum()
    expect(readSectionVectorCount(maximumFunctions, 3)).toBe(8_192)
    expect(readSectionVectorCount(tooManyFunctions, 3)).toBe(8_193)
  })

  test('tracks terminal resource ownership and classifies stale or duplicate messages', () => {
    const ledger = createIssue77LifecycleLedger()
    const worker = ledger.own('worker', 'candidate-7')
    const port = ledger.own('port', 'candidate-7')
    const watchdog = ledger.own('watchdog', 'activation-7')
    const request = ledger.beginRequest('7:11')
    expect(ledger.terminalViolations()).toEqual([
      'open resource: port:candidate-7',
      'open resource: watchdog:activation-7',
      'open resource: worker:candidate-7',
      'pending request: 7:11',
    ])

    request.settle('timeout')
    watchdog.release('timeout')
    port.release('timeout')
    worker.release('timeout')
    expect(ledger.terminalViolations()).toEqual([])
    expect(ledger.snapshot().events.map((event) => event.action)).toEqual([
      'own', 'own', 'own', 'begin', 'settle', 'release', 'release', 'release',
    ])

    const messages = issue77MessageCases()
    const accepted = new Set<string>()
    expect(classifyIssue77Message(messages.current, 7, 11, accepted)).toBe('accepted')
    expect(classifyIssue77Message(messages.duplicate, 7, 11, accepted)).toBe('duplicate')
    expect(classifyIssue77Message(messages.staleGeneration, 7, 11, accepted)).toBe('stale-generation')
    expect(classifyIssue77Message(messages.staleRequest, 7, 11, accepted)).toBe('stale-request')
  })
})
