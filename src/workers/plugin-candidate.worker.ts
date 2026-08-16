import {
  createPluginWasmPolicyParser,
  parsePluginWasmModule,
  type PluginWasmModuleExpectations,
  type PluginWasmModuleFacts,
} from './plugin-wasm/moduleParser'
import {
  PLUGIN_WASM_OPCODE_TABLE_ARTIFACTS,
  PLUGIN_WASM_OPCODE_TABLE_DIGESTS,
} from './plugin-wasm/policyTables'
import {
  PLUGIN_IO_PAGE_BYTES,
  PLUGIN_PARAMETER_POINTER,
  PLUGIN_PIXEL_POINTER,
  PLUGIN_RUNTIME_PROTOCOL_VERSION,
} from './plugin-runtime-protocol'

export const PLUGIN_CANDIDATE_WORKER_MARKER = 'MYRELITH_PLUGIN_CANDIDATE_WORKER_V1'

export interface PluginCandidateEngine {
  validate(bytes: Uint8Array): boolean
  compile(bytes: Uint8Array): Promise<unknown>
  createMemory(descriptor: { readonly initial: number; readonly maximum: number }): unknown
  instantiate(
    module: unknown,
    imports: { readonly myrelith: { readonly memory: unknown } },
  ): Promise<unknown>
}

export interface PluginCandidateActivationInput {
  readonly moduleBytes: Uint8Array
  readonly expectations: PluginWasmModuleExpectations
}

export interface PluginCandidateActivation {
  readonly facts: PluginWasmModuleFacts
  readonly module: unknown
  readonly memory: unknown
  readonly instance: unknown
}

/** Candidate-only core. The parent must still own its non-resetting activation deadline. */
export function createPluginCandidateCore(engine: PluginCandidateEngine): {
  activate(input: PluginCandidateActivationInput): Promise<PluginCandidateActivation>
} {
  return {
    async activate(input): Promise<PluginCandidateActivation> {
      const moduleBytes = Uint8Array.from(input.moduleBytes)
      try {
        const facts = parsePluginWasmModule(moduleBytes, input.expectations)
        if (!engine.validate(moduleBytes)) {
          throw new Error('The policy-valid WebAssembly module failed engine validation.')
        }
        const module = await engine.compile(moduleBytes)
        const memory = engine.createMemory({
          initial: facts.importedMemory.minimumPages,
          maximum: facts.importedMemory.maximumPages,
        })
        const instance = await engine.instantiate(module, { myrelith: { memory } })
        return Object.freeze({ facts, module, memory, instance })
      } finally {
        moduleBytes.fill(0)
      }
    },
  }
}

interface PluginCandidateWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  close(): void
}

interface PluginCandidateWorkerConfiguration {
  readonly marker: string
  readonly protocolVersion: number
  readonly parameterPointer: number
  readonly pixelPointer: number
  readonly ioPageBytes: number
}

type EmbeddedPluginWasmParser = (
  moduleBytes: Uint8Array,
  expectations: PluginWasmModuleExpectations,
) => PluginWasmModuleFacts

/** Self-contained candidate installer; serialized into the host-authored blob worker. */
export function installPluginCandidateWorker(
  scope: PluginCandidateWorkerScope,
  parse: EmbeddedPluginWasmParser,
  configuration: PluginCandidateWorkerConfiguration,
): void {
  let runtimePort: MessagePort | undefined
  let generation = -1
  let active = false
  let closed = false
  let state: {
    readonly memory: WebAssembly.Memory
    readonly instance: WebAssembly.Instance
    readonly facts: PluginWasmModuleFacts
  } | undefined

  const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  )
  const isArrayBuffer = (value: unknown): value is ArrayBuffer => (
    value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  )
  const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
    const actual = Object.keys(value).sort()
    const sortedExpected = [...expected].sort()
    return actual.length === sortedExpected.length
      && actual.every((key, index) => key === sortedExpected[index])
  }
  const isId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
  const boundedMessage = (value: unknown): string => {
    const message = value instanceof Error ? value.message : String(value)
    return message.slice(0, 512)
  }
  const failure = (
    requestId: number,
    code: string,
    message: string,
    terminal: boolean,
    pluginCode?: number,
  ): void => {
    runtimePort?.postMessage({
      protocolVersion: configuration.protocolVersion,
      kind: 'failure',
      generation,
      requestId,
      failure: pluginCode === undefined
        ? { code, message: message.slice(0, 512), terminal }
        : { code, message: message.slice(0, 512), terminal, pluginCode },
    })
  }
  const clear = (memory: Uint8Array, start: number, length: number): void => {
    if (start >= 0 && length >= 0 && start <= memory.byteLength - length) {
      memory.fill(0, start, start + length)
    }
  }
  const terminalFailure = (requestId: number, code: string, message: string, pluginCode?: number): void => {
    failure(requestId, code, message, true, pluginCode)
    state = undefined
    closed = true
    runtimePort?.close()
    scope.close()
  }
  const expectCommon = (message: Record<string, unknown>): { requestId: number } | undefined => {
    const requestId = isId(message.requestId) ? message.requestId : 0
    if (message.protocolVersion !== configuration.protocolVersion || !isId(message.generation) || !isId(message.requestId)) {
      terminalFailure(requestId, 'invalid-envelope', 'Worker request envelope is invalid.')
      return undefined
    }
    if (message.generation !== generation) {
      terminalFailure(requestId, 'stale-generation', 'Worker request generation is stale.')
      return undefined
    }
    return { requestId }
  }

  const activate = async (message: Record<string, unknown>): Promise<void> => {
    const common = expectCommon(message)
    if (!common) return
    if (!exactKeys(message, [
      'protocolVersion', 'kind', 'generation', 'requestId', 'moduleBytes', 'expectations',
    ]) || !isArrayBuffer(message.moduleBytes) || !isRecord(message.expectations)) {
      terminalFailure(common.requestId, 'invalid-envelope', 'Activation request shape is invalid.')
      return
    }
    if (state) {
      terminalFailure(common.requestId, 'invalid-envelope', 'Worker activation may occur only once.')
      return
    }
    const transferredModuleBytes = new Uint8Array(message.moduleBytes as ArrayBuffer)
    let moduleBytes: Uint8Array<ArrayBuffer> | undefined
    try {
      moduleBytes = transferredModuleBytes.slice()
      const expectations = message.expectations as unknown as PluginWasmModuleExpectations
      const facts = parse(moduleBytes, expectations)
      if (!WebAssembly.validate(moduleBytes)) throw new Error('Policy-valid module failed engine validation.')
      const module = await WebAssembly.compile(moduleBytes)
      const memory = new WebAssembly.Memory({
        initial: facts.importedMemory.minimumPages,
        maximum: facts.importedMemory.maximumPages,
      })
      const instance = await WebAssembly.instantiate(module, { myrelith: { memory } })
      if (closed) return
      state = { memory, instance, facts }
      runtimePort?.postMessage({
        protocolVersion: configuration.protocolVersion,
        kind: 'ready',
        generation,
        requestId: common.requestId,
        facts,
      })
    } catch (cause) {
      terminalFailure(common.requestId, 'activation-failed', boundedMessage(cause))
    } finally {
      moduleBytes?.fill(0)
      transferredModuleBytes.fill(0)
    }
  }

  const render = (message: Record<string, unknown>): void => {
    const common = expectCommon(message)
    if (!common) return
    if (!state || !exactKeys(message, [
      'protocolVersion', 'kind', 'generation', 'requestId', 'entrypoint', 'width', 'height',
      'stride', 'timelineFrame', 'frameRateNumerator', 'frameRateDenominator',
      'canonicalParameterBytes', 'rgbaBytes',
    ]) || typeof message.entrypoint !== 'string'
      || !Number.isInteger(message.width) || Number(message.width) <= 0
      || !Number.isInteger(message.height) || Number(message.height) <= 0
      || !Number.isInteger(message.stride) || Number(message.stride) !== Number(message.width) * 4
      || !isId(message.timelineFrame)
      || !Number.isInteger(message.frameRateNumerator) || Number(message.frameRateNumerator) <= 0
      || !Number.isInteger(message.frameRateDenominator) || Number(message.frameRateDenominator) <= 0
      || !isArrayBuffer(message.canonicalParameterBytes)
      || !isArrayBuffer(message.rgbaBytes)) {
      terminalFailure(common.requestId, 'invalid-input', 'Render request is invalid.')
      return
    }
    const width = Number(message.width)
    const height = Number(message.height)
    const stride = Number(message.stride)
    const byteLength = stride * height
    const parameterBytes = new Uint8Array(message.canonicalParameterBytes)
    const inputBytes = new Uint8Array(message.rgbaBytes)
    const memoryBytes = new Uint8Array(state.memory.buffer)
    if (!Number.isSafeInteger(byteLength) || inputBytes.byteLength !== byteLength
      || parameterBytes.byteLength > configuration.ioPageBytes
      || configuration.pixelPointer > memoryBytes.byteLength - byteLength) {
      terminalFailure(common.requestId, 'invalid-input', 'Render buffer bounds are invalid.')
      return
    }
    const callable = state.instance.exports[message.entrypoint]
    if (typeof callable !== 'function' || !state.facts.exportedFunctions.includes(message.entrypoint)) {
      terminalFailure(common.requestId, 'invalid-input', 'Render entrypoint is unavailable.')
      return
    }
    const frame = Number(message.timelineFrame)
    const frameLow = frame % 0x1_0000_0000
    const frameHigh = Math.floor(frame / 0x1_0000_0000)
    memoryBytes.set(parameterBytes, configuration.parameterPointer)
    memoryBytes.set(inputBytes, configuration.pixelPointer)
    try {
      const result = Number(callable(
        configuration.pixelPointer,
        width,
        height,
        stride,
        frameLow,
        frameHigh,
        Number(message.frameRateNumerator),
        Number(message.frameRateDenominator),
        configuration.parameterPointer,
        parameterBytes.byteLength,
      ))
      if (result !== 0 && result !== 1) {
        terminalFailure(common.requestId, 'plugin-failure', `Plugin render returned failure code ${result}.`, result)
        return
      }
      const output = result === 1
        ? inputBytes.slice()
        : memoryBytes.slice(configuration.pixelPointer, configuration.pixelPointer + byteLength)
      runtimePort?.postMessage({
        protocolVersion: configuration.protocolVersion,
        kind: 'rendered',
        generation,
        requestId: common.requestId,
        identity: result === 1,
        rgbaBytes: output.buffer,
      }, [output.buffer])
    } catch (cause) {
      terminalFailure(common.requestId, 'crashed', boundedMessage(cause))
    } finally {
      clear(memoryBytes, configuration.parameterPointer, configuration.ioPageBytes)
      clear(memoryBytes, configuration.pixelPointer, byteLength)
      parameterBytes.fill(0)
      inputBytes.fill(0)
    }
  }

  const migrate = (message: Record<string, unknown>): void => {
    const common = expectCommon(message)
    if (!common) return
    if (!state || !exactKeys(message, [
      'protocolVersion', 'kind', 'generation', 'requestId', 'entrypoint',
      'fromVersion', 'toVersion', 'canonicalInputBytes',
    ]) || typeof message.entrypoint !== 'string'
      || !Number.isInteger(message.fromVersion) || Number(message.fromVersion) < 1
      || !Number.isInteger(message.toVersion) || Number(message.toVersion) <= Number(message.fromVersion)
      || !isArrayBuffer(message.canonicalInputBytes)) {
      terminalFailure(common.requestId, 'invalid-input', 'Migration request is invalid.')
      return
    }
    const inputBytes = new Uint8Array(message.canonicalInputBytes)
    const memoryBytes = new Uint8Array(state.memory.buffer)
    if (inputBytes.byteLength > configuration.ioPageBytes
      || configuration.pixelPointer > memoryBytes.byteLength - configuration.ioPageBytes) {
      terminalFailure(common.requestId, 'invalid-input', 'Migration buffer bounds are invalid.')
      return
    }
    const callable = state.instance.exports[message.entrypoint]
    if (typeof callable !== 'function' || !state.facts.exportedFunctions.includes(message.entrypoint)) {
      terminalFailure(common.requestId, 'invalid-input', 'Migration entrypoint is unavailable.')
      return
    }
    memoryBytes.set(inputBytes, configuration.parameterPointer)
    clear(memoryBytes, configuration.pixelPointer, configuration.ioPageBytes)
    try {
      const result = Number(callable(
        configuration.parameterPointer,
        inputBytes.byteLength,
        configuration.pixelPointer,
        configuration.ioPageBytes,
        Number(message.fromVersion),
        Number(message.toVersion),
      ))
      if (!Number.isInteger(result) || result <= 0 || result > configuration.ioPageBytes) {
        terminalFailure(common.requestId, 'invalid-output', `Plugin migration returned invalid length ${result}.`)
        return
      }
      const output = memoryBytes.slice(configuration.pixelPointer, configuration.pixelPointer + result)
      runtimePort?.postMessage({
        protocolVersion: configuration.protocolVersion,
        kind: 'migrated',
        generation,
        requestId: common.requestId,
        canonicalOutputBytes: output.buffer,
      }, [output.buffer])
    } catch (cause) {
      terminalFailure(common.requestId, 'crashed', boundedMessage(cause))
    } finally {
      clear(memoryBytes, configuration.parameterPointer, configuration.ioPageBytes)
      clear(memoryBytes, configuration.pixelPointer, configuration.ioPageBytes)
      inputBytes.fill(0)
    }
  }

  const handleRequest = async (event: MessageEvent<unknown>): Promise<void> => {
    if (closed || !isRecord(event.data)) return
    const message = event.data
    if (active) {
      const requestId = isId(message.requestId) ? message.requestId : 0
      terminalFailure(requestId, 'busy', 'Candidate worker received overlapping requests.')
      return
    }
    active = true
    try {
      if (message.kind === 'activate') await activate(message)
      else if (message.kind === 'render') render(message)
      else if (message.kind === 'migrate') migrate(message)
      else if (message.kind === 'close') {
        const common = expectCommon(message)
        if (!common || !exactKeys(message, [
          'protocolVersion', 'kind', 'generation', 'requestId', 'reason',
        ]) || typeof message.reason !== 'string') {
          if (common) terminalFailure(common.requestId, 'invalid-envelope', 'Close request is invalid.')
          return
        }
        runtimePort?.postMessage({
          protocolVersion: configuration.protocolVersion,
          kind: 'closed',
          generation,
          requestId: common.requestId,
        })
        state = undefined
        closed = true
        runtimePort?.close()
        scope.close()
      } else {
        const requestId = isId(message.requestId) ? message.requestId : 0
        terminalFailure(requestId, 'invalid-envelope', 'Unknown worker request kind.')
      }
    } finally {
      active = false
    }
  }

  scope.onmessage = (event): void => {
    if (runtimePort || !isRecord(event.data)
      || !exactKeys(event.data, ['protocolVersion', 'kind', 'generation', 'port'])
      || event.data.protocolVersion !== configuration.protocolVersion
      || event.data.kind !== 'connect'
      || !isId(event.data.generation)
      || !(event.data.port instanceof MessagePort)) {
      scope.close()
      return
    }
    generation = event.data.generation
    runtimePort = event.data.port
    runtimePort.onmessage = (messageEvent): void => {
      void handleRequest(messageEvent)
    }
    runtimePort.start()
  }
}

/** JavaScript source for the exact blob worker path used by the opaque broker. */
export function createPluginCandidateWorkerSource(): string {
  const parserEnvironment = {
    binaryPolicyVersion: 1,
    opcodeTables: PLUGIN_WASM_OPCODE_TABLE_ARTIFACTS,
    opcodeTableDigests: PLUGIN_WASM_OPCODE_TABLE_DIGESTS,
  }
  const configuration: PluginCandidateWorkerConfiguration = {
    marker: PLUGIN_CANDIDATE_WORKER_MARKER,
    protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
    parameterPointer: PLUGIN_PARAMETER_POINTER,
    pixelPointer: PLUGIN_PIXEL_POINTER,
    ioPageBytes: PLUGIN_IO_PAGE_BYTES,
  }
  return [
    `'use strict';/* ${PLUGIN_CANDIDATE_WORKER_MARKER} */`,
    `const createParser = (${createPluginWasmPolicyParser.toString()});`,
    `const install = (${installPluginCandidateWorker.toString()});`,
    `const parser = createParser(${JSON.stringify(parserEnvironment)});`,
    `install(self, parser, ${JSON.stringify(configuration)});`,
  ].join('\n')
}
