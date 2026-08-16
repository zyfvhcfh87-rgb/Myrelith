import {
  createPluginCandidateWorkerSource,
} from '../workers/plugin-candidate.worker'
import {
  PLUGIN_RUNTIME_PROTOCOL_VERSION,
  type PluginRuntimeFailure,
  type PluginWorkerActivateRequest,
  type PluginWorkerMigrateRequest,
  type PluginWorkerRenderRequest,
  type PluginWorkerResponse,
} from '../workers/plugin-runtime-protocol'
import type {
  PluginWasmModuleExpectations,
  PluginWasmModuleFacts,
} from '../workers/plugin-wasm/moduleParser'
import type { PluginRuntimeLifecycleObserver } from './pluginRuntimeLifecycleObserver'

export const PLUGIN_SANDBOX_BROKER_MARKER = 'MYRELITH_PLUGIN_SANDBOX_BROKER_V1'
export const PLUGIN_ACTIVATION_DEADLINE_MS = 5_000
export const PLUGIN_PREVIEW_DEADLINE_MS = 500
export const PLUGIN_EXPORT_DEADLINE_MS = 5_000
export const PLUGIN_MIGRATION_DEADLINE_MS = 1_000

export interface PluginSandboxActivationRequest {
  readonly moduleBytes: Uint8Array
  readonly expectations: PluginWasmModuleExpectations
}

export interface PluginSandboxRenderRequest {
  readonly entrypoint: string
  readonly width: number
  readonly height: number
  readonly stride: number
  readonly timelineFrame: number
  readonly frameRateNumerator: number
  readonly frameRateDenominator: number
  readonly canonicalParameterBytes: Uint8Array
  readonly rgbaBytes: Uint8Array
}

export interface PluginSandboxRenderResult {
  readonly identity: boolean
  readonly rgbaBytes: Uint8Array
}

export interface PluginSandboxMigrationRequest {
  readonly entrypoint: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly canonicalInputBytes: Uint8Array
}

export interface PluginSandboxSession {
  readonly generation: number
  readonly facts: PluginWasmModuleFacts
  render(
    request: PluginSandboxRenderRequest,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<PluginSandboxRenderResult>
  migrate(
    request: PluginSandboxMigrationRequest,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
  close(reason: string): Promise<void>
}

export interface PluginSandboxBroker {
  readonly runtimePort: MessagePort
  setFatalHandler(handler: (failure: PluginRuntimeFailure) => void): void
  terminate(reason: string): void
}

export interface PluginSandboxBrokerOwnershipSnapshot {
  readonly brokerIframeCount: number
  readonly candidateWorkerCount: number
  readonly privatePortCount: number
}

export interface PluginSandboxBrokerCreateRequest {
  readonly generation: number
  readonly workerSource: string
  readonly deadlineAt: number
  readonly signal?: AbortSignal
  readonly reportOwnership?: (snapshot: PluginSandboxBrokerOwnershipSnapshot) => void
}

export type PluginSandboxBrokerFactory = (
  request: PluginSandboxBrokerCreateRequest,
) => Promise<PluginSandboxBroker>

export interface PluginSandboxController {
  activate(
    request: PluginSandboxActivationRequest,
    signal?: AbortSignal,
  ): Promise<PluginSandboxSession>
  teardown(reason: string): Promise<void>
}

export class PluginSandboxError extends Error {
  readonly failure: PluginRuntimeFailure

  constructor(failure: PluginRuntimeFailure) {
    super(failure.message)
    this.name = 'PluginSandboxError'
    this.failure = Object.freeze({ ...failure })
  }
}

function failure(
  code: PluginRuntimeFailure['code'],
  message: string,
  terminal = true,
): PluginRuntimeFailure {
  return Object.freeze({ code, message: message.slice(0, 512), terminal })
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function zeroAttachedArrayBuffers(buffers: readonly ArrayBuffer[]): void {
  for (const buffer of buffers) {
    if (buffer.byteLength > 0) new Uint8Array(buffer).fill(0)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

const PLUGIN_RUNTIME_FAILURE_CODES = new Set<PluginRuntimeFailure['code']>([
  'aborted',
  'activation-failed',
  'busy',
  'closed',
  'crashed',
  'invalid-envelope',
  'invalid-input',
  'invalid-output',
  'plugin-failure',
  'queue-full',
  'session-disabled',
  'stale-plan',
  'stale-request',
  'stale-generation',
  'timeout',
])

function isPluginRuntimeFailure(value: unknown): value is PluginRuntimeFailure {
  if (!isRecord(value)) return false
  const hasPluginCode = Object.prototype.hasOwnProperty.call(value, 'pluginCode')
  if (!exactKeys(value, hasPluginCode
    ? ['code', 'message', 'terminal', 'pluginCode']
    : ['code', 'message', 'terminal'])) return false
  return typeof value.code === 'string'
    && PLUGIN_RUNTIME_FAILURE_CODES.has(value.code as PluginRuntimeFailure['code'])
    && typeof value.message === 'string'
    && value.message.length <= 512
    && typeof value.terminal === 'boolean'
    && (!hasPluginCode || (Number.isInteger(value.pluginCode)
      && Number(value.pluginCode) >= -0x8000_0000
      && Number(value.pluginCode) <= 0x7fff_ffff))
}

function isWorkerSuccessResponse(
  value: Record<string, unknown>,
  expectedKind: PendingRequest['expectedKind'],
): boolean {
  if (value.kind !== expectedKind) return false
  if (expectedKind === 'ready') {
    return exactKeys(value, ['protocolVersion', 'kind', 'generation', 'requestId', 'facts'])
      && isRecord(value.facts)
  }
  if (expectedKind === 'rendered') {
    return exactKeys(value, [
      'protocolVersion', 'kind', 'generation', 'requestId', 'identity', 'rgbaBytes',
    ]) && typeof value.identity === 'boolean' && isArrayBuffer(value.rgbaBytes)
  }
  if (expectedKind === 'migrated') {
    return exactKeys(value, [
      'protocolVersion', 'kind', 'generation', 'requestId', 'canonicalOutputBytes',
    ]) && isArrayBuffer(value.canonicalOutputBytes)
  }
  return exactKeys(value, ['protocolVersion', 'kind', 'generation', 'requestId'])
}

function isPluginWasmModuleFacts(
  value: unknown,
  expectations: PluginWasmModuleExpectations,
): value is PluginWasmModuleFacts {
  if (!isRecord(value) || !exactKeys(value, [
    'policy',
    'opcodeTableDigest',
    'importedMemory',
    'definedFunctionCount',
    'tableCount',
    'elementSegmentCount',
    'dataSegmentCount',
    'exportedFunctions',
  ]) || !isRecord(value.policy)
    || !exactKeys(value.policy, ['binaryPolicyVersion', 'profileId'])
    || !isRecord(value.importedMemory)
    || !exactKeys(value.importedMemory, ['minimumPages', 'maximumPages'])
    || !Array.isArray(value.exportedFunctions)) return false
  const counts = [
    value.definedFunctionCount,
    value.tableCount,
    value.elementSegmentCount,
    value.dataSegmentCount,
  ]
  return value.policy.binaryPolicyVersion === expectations.policy.binaryPolicyVersion
    && value.policy.profileId === expectations.policy.profileId
    && value.opcodeTableDigest === expectations.opcodeTableDigest
    && value.importedMemory.minimumPages === expectations.memoryMaximumPages
    && value.importedMemory.maximumPages === expectations.memoryMaximumPages
    && counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0)
    && value.exportedFunctions.length <= 8_192
    && value.exportedFunctions.every((entry) => typeof entry === 'string' && entry.length <= 128)
    && new Set(value.exportedFunctions).size === value.exportedFunctions.length
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

function randomNonce(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function escapedScriptValue(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

/** Exact opaque-origin broker document; no network-resolvable source appears in it. */
export function createPluginSandboxBrokerSrcdoc(nonce: string, workerSource: string): string {
  const script = `
'use strict';/* ${PLUGIN_SANDBOX_BROKER_MARKER} */
const handshakeNonce=${escapedScriptValue(nonce)};
const workerSource=${escapedScriptValue(workerSource)};
let connected=false;
function receiveHandshake(event){
  const data=event.data;
  if(connected||event.source!==parent||!data||typeof data!=='object'||Array.isArray(data))return;
  const keys=Object.keys(data).sort().join(',');
  if(keys!=='generation,kind,nonce,port,protocolVersion'||data.kind!=='myrelith-plugin-handshake'||data.nonce!==handshakeNonce||data.protocolVersion!==1||!Number.isSafeInteger(data.generation)||data.generation<0||!(data.port instanceof MessagePort))return;
  connected=true;
  removeEventListener('message',receiveHandshake);
  const controlPort=data.port;
  let worker;
  try{
    const blob=new Blob([workerSource],{type:'text/javascript'});
    const url=URL.createObjectURL(blob);
    worker=new Worker(url,{name:'myrelith-plugin-candidate'});
    URL.revokeObjectURL(url);
    const runtime=new MessageChannel();
    worker.postMessage({protocolVersion:1,kind:'connect',generation:data.generation,port:runtime.port2},[runtime.port2]);
    controlPort.postMessage({kind:'worker-created',nonce:handshakeNonce,generation:data.generation});
    worker.addEventListener('error',(error)=>controlPort.postMessage({kind:'worker-error',nonce:handshakeNonce,generation:data.generation,message:String(error.message||'Worker crashed.').slice(0,512)}));
    worker.addEventListener('messageerror',()=>controlPort.postMessage({kind:'worker-error',nonce:handshakeNonce,generation:data.generation,message:'Worker message deserialization failed.'}));
    controlPort.onmessage=(controlEvent)=>{
      const command=controlEvent.data;
      if(command&&typeof command==='object'&&!Array.isArray(command)&&Object.keys(command).sort().join(',')==='kind,nonce,reason'&&command.kind==='terminate'&&command.nonce===handshakeNonce&&typeof command.reason==='string'){
        worker.terminate();
        controlPort.close();
      }
    };
    controlPort.start();
    controlPort.postMessage({kind:'worker-ready',nonce:handshakeNonce,generation:data.generation,runtimePort:runtime.port1},[runtime.port1]);
  }catch(error){
    if(worker)worker.terminate();
    controlPort.postMessage({kind:'worker-error',nonce:handshakeNonce,generation:data.generation,message:String(error instanceof Error?error.message:error).slice(0,512)});
    controlPort.close();
  }
}
addEventListener('message',receiveHandshake);`
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "worker-src blob:",
    "connect-src 'none'",
    "img-src 'none'",
    "media-src 'none'",
    "style-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script nonce="${nonce}">${script}</script>`
}

export function configurePluginSandboxIframe(
  iframe: HTMLIFrameElement,
  nonce: string,
  workerSource: string,
): void {
  iframe.hidden = true
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.srcdoc = createPluginSandboxBrokerSrcdoc(nonce, workerSource)
}

/** Browser adapter that creates the candidate only after a source+nonce-bound handshake. */
export async function createBrowserPluginSandboxBroker(
  request: PluginSandboxBrokerCreateRequest,
): Promise<PluginSandboxBroker> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw new PluginSandboxError(failure('activation-failed', 'Plugin sandbox requires a browser document.'))
  }
  const nonce = randomNonce()
  const iframe = document.createElement('iframe')
  configurePluginSandboxIframe(iframe, nonce, request.workerSource)
  const controlChannel = new MessageChannel()
  let ownership: PluginSandboxBrokerOwnershipSnapshot = Object.freeze({
    brokerIframeCount: 1,
    candidateWorkerCount: 0,
    privatePortCount: 2,
  })
  const reportOwnership = (next: PluginSandboxBrokerOwnershipSnapshot): void => {
    ownership = Object.freeze({ ...next })
    try {
      request.reportOwnership?.(ownership)
    } catch {
      // Lifecycle observation cannot alter broker creation or cleanup.
    }
  }
  reportOwnership(ownership)
  let fatalHandler: ((runtimeFailure: PluginRuntimeFailure) => void) | undefined
  let terminated = false
  const terminate = (reason: string): void => {
    if (terminated) return
    terminated = true
    try {
      controlChannel.port1.postMessage({ kind: 'terminate', nonce, reason: reason.slice(0, 512) })
    } finally {
      controlChannel.port1.close()
      controlChannel.port2.close()
      iframe.remove()
      reportOwnership({
        brokerIframeCount: 0,
        candidateWorkerCount: 0,
        privatePortCount: 0,
      })
    }
  }

  const runtimePort = await new Promise<MessagePort>((resolve, reject) => {
    const remaining = request.deadlineAt - performance.now()
    const rejectAndTerminate = (runtimeFailure: PluginRuntimeFailure): void => {
      terminate(runtimeFailure.code)
      reject(new PluginSandboxError(runtimeFailure))
    }
    if (remaining <= 0) {
      rejectAndTerminate(failure('timeout', 'Plugin activation timed out before broker creation.'))
      return
    }
    const timer = window.setTimeout(() => {
      rejectAndTerminate(failure('timeout', 'Plugin activation timed out during broker creation.'))
    }, remaining)
    const onAbort = (): void => {
      window.clearTimeout(timer)
      rejectAndTerminate(failure('aborted', 'Plugin activation was cancelled.'))
    }
    if (request.signal?.aborted) {
      onAbort()
      return
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    controlChannel.port1.onmessage = (event): void => {
      const value = event.data
      if (!isRecord(value) || value.nonce !== nonce || value.generation !== request.generation) return
      if (exactKeys(value, ['kind', 'nonce', 'generation'])
        && value.kind === 'worker-created') {
        reportOwnership({ ...ownership, candidateWorkerCount: 1 })
        return
      }
      if (value.kind === 'worker-error') {
        window.clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        rejectAndTerminate(failure('crashed', typeof value.message === 'string' ? value.message : 'Plugin worker crashed.'))
        return
      }
      if (!exactKeys(value, ['kind', 'nonce', 'generation', 'runtimePort'])
        || value.kind !== 'worker-ready'
        || !(value.runtimePort instanceof MessagePort)) return
      window.clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      resolve(value.runtimePort)
    }
    controlChannel.port1.start()
    iframe.addEventListener('load', () => {
      if (terminated) return
      const target = iframe.contentWindow
      if (!target) {
        rejectAndTerminate(failure('activation-failed', 'Plugin broker has no content window.'))
        return
      }
      try {
        target.postMessage({
          protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
          kind: 'myrelith-plugin-handshake',
          nonce,
          generation: request.generation,
          port: controlChannel.port2,
        }, '*', [controlChannel.port2])
      } catch {
        rejectAndTerminate(failure('activation-failed', 'Plugin broker handshake dispatch failed.'))
      }
    }, { once: true })
    document.body.append(iframe)
  })

  controlChannel.port1.onmessage = (event): void => {
    const value = event.data
    if (isRecord(value) && value.kind === 'worker-error'
      && value.nonce === nonce && value.generation === request.generation) {
      const runtimeFailure = failure(
        'crashed',
        typeof value.message === 'string' ? value.message : 'Plugin worker crashed.',
      )
      fatalHandler?.(runtimeFailure)
      terminate(runtimeFailure.code)
    }
  }

  return {
    runtimePort,
    setFatalHandler(handler) {
      fatalHandler = handler
    },
    terminate,
  }
}

interface PendingRequest {
  readonly requestId: number
  readonly expectedKind: 'ready' | 'rendered' | 'migrated' | 'closed'
  readonly resolve: (response: PluginWorkerResponse) => void
  readonly reject: (error: PluginSandboxError) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
  readonly countsAsRequest: boolean
}

export function createPluginSandboxController(options: {
  readonly brokerFactory?: PluginSandboxBrokerFactory
  readonly now?: () => number
  readonly lifecycleObserver?: PluginRuntimeLifecycleObserver
} = {}): PluginSandboxController {
  const brokerFactory = options.brokerFactory ?? createBrowserPluginSandboxBroker
  const now = options.now ?? (() => performance.now())
  const liveBrokers = new Set<PluginSandboxBroker>()
  const liveTerminals = new Set<(runtimeFailure: PluginRuntimeFailure) => void>()
  const pendingActivationAborts = new Set<AbortController>()
  const pendingActivationSettlements = new Set<Promise<void>>()
  const pendingBrokerSettlements = new Set<Promise<void>>()
  const pendingBrokerOwnership = new Map<number, PluginSandboxBrokerOwnershipSnapshot>()
  let generationSequence = 0
  let watchdogCount = 0
  let pendingRequestCount = 0
  let sessionCount = 0
  let tornDown = false
  let terminalSnapshotEmitted = false
  let teardownPromise: Promise<void> | null = null

  const emitLifecycle = (terminal = false): void => {
    if (!options.lifecycleObserver || (terminal && terminalSnapshotEmitted)) return
    const pendingOwnership = [...pendingBrokerOwnership.values()].reduce(
      (total, value) => ({
        brokerIframeCount: total.brokerIframeCount + value.brokerIframeCount,
        candidateWorkerCount: total.candidateWorkerCount + value.candidateWorkerCount,
        privatePortCount: total.privatePortCount + value.privatePortCount,
      }),
      { brokerIframeCount: 0, candidateWorkerCount: 0, privatePortCount: 0 },
    )
    const snapshot = Object.freeze({
      brokerIframeCount: liveBrokers.size + pendingOwnership.brokerIframeCount,
      candidateWorkerCount: liveBrokers.size + pendingOwnership.candidateWorkerCount,
      privatePortCount: liveBrokers.size * 2 + pendingOwnership.privatePortCount,
      watchdogCount,
      pendingActivationCount: pendingActivationAborts.size,
      pendingRequestCount,
      sessionCount,
      terminal,
    })
    if (terminal && Object.entries(snapshot).some(([key, value]) => (
      key !== 'terminal' && value !== 0
    ))) {
      throw new Error('Plugin sandbox terminal lifecycle snapshot requires zero ownership')
    }
    if (terminal) terminalSnapshotEmitted = true
    try {
      options.lifecycleObserver.onSandboxSnapshot(snapshot)
    } catch {
      // An injection-only observer can never alter sandbox or cleanup outcomes.
    }
  }

  emitLifecycle()

  const activate = async (
    activation: PluginSandboxActivationRequest,
    signal?: AbortSignal,
  ): Promise<PluginSandboxSession> => {
    if (tornDown) throw new PluginSandboxError(failure('closed', 'Plugin sandbox controller is closed.'))
    if (signal?.aborted) throw new PluginSandboxError(failure('aborted', 'Plugin activation was cancelled.'))
    const activationAbort = new AbortController()
    let resolveActivationSettlement!: () => void
    const activationSettlement = new Promise<void>((resolve) => {
      resolveActivationSettlement = resolve
    })
    pendingActivationSettlements.add(activationSettlement)
    let activationCleaned = false
    const forwardAbort = (): void => activationAbort.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    pendingActivationAborts.add(activationAbort)
    emitLifecycle()
    const cleanupActivation = (): void => {
      if (activationCleaned) return
      activationCleaned = true
      signal?.removeEventListener('abort', forwardAbort)
      pendingActivationAborts.delete(activationAbort)
      pendingActivationSettlements.delete(activationSettlement)
      resolveActivationSettlement()
      emitLifecycle()
    }
    const generation = ++generationSequence
    const deadlineAt = now() + PLUGIN_ACTIVATION_DEADLINE_MS
    let acceptsPendingOwnership = true
    pendingBrokerOwnership.set(generation, Object.freeze({
      brokerIframeCount: 0,
      candidateWorkerCount: 0,
      privatePortCount: 0,
    }))
    const reportOwnership = (ownership: PluginSandboxBrokerOwnershipSnapshot): void => {
      if (!acceptsPendingOwnership || !pendingBrokerOwnership.has(generation)) return
      pendingBrokerOwnership.set(generation, Object.freeze({ ...ownership }))
      emitLifecycle()
    }
    const releasePendingOwnership = (): void => {
      if (!acceptsPendingOwnership) return
      acceptsPendingOwnership = false
      if (pendingBrokerOwnership.delete(generation)) emitLifecycle()
    }
    let brokerPromise: Promise<PluginSandboxBroker>
    try {
      brokerPromise = Promise.resolve(brokerFactory({
        generation,
        workerSource: createPluginCandidateWorkerSource(),
        deadlineAt,
        signal: activationAbort.signal,
        reportOwnership,
      }))
    } catch (cause) {
      releasePendingOwnership()
      cleanupActivation()
      throw cause
    }
    const brokerSettlement = brokerPromise.then(() => undefined, () => undefined)
    pendingBrokerSettlements.add(brokerSettlement)
    void brokerSettlement.finally(() => pendingBrokerSettlements.delete(brokerSettlement))
    let broker: PluginSandboxBroker
    watchdogCount++
    emitLifecycle()
    try {
      broker = await new Promise<PluginSandboxBroker>((resolve, reject) => {
        let aborted = false
        const onAbort = (): void => {
          aborted = true
          reject(new PluginSandboxError(failure('aborted', 'Plugin activation was cancelled.')))
        }
        activationAbort.signal.addEventListener('abort', onAbort, { once: true })
        brokerPromise.then(
          (created) => {
            activationAbort.signal.removeEventListener('abort', onAbort)
            if (aborted || activationAbort.signal.aborted) {
              try {
                created.terminate('activation-aborted-before-broker-ready')
              } finally {
                releasePendingOwnership()
              }
              return
            }
            resolve(created)
          },
          (cause) => {
            activationAbort.signal.removeEventListener('abort', onAbort)
            releasePendingOwnership()
            if (!aborted) reject(cause)
          },
        )
      })
    } catch (cause) {
      cleanupActivation()
      throw cause
    } finally {
      watchdogCount--
      emitLifecycle()
    }
    acceptsPendingOwnership = false
    pendingBrokerOwnership.delete(generation)
    liveBrokers.add(broker)
    emitLifecycle()
    const port = broker.runtimePort
    let requestSequence = 0
    let pending: PendingRequest | undefined
    let sessionClosed = false
    let sessionAcquired = false

    const releasePending = (current: PendingRequest): void => {
      clearTimeout(current.timer)
      watchdogCount--
      if (current.countsAsRequest) pendingRequestCount--
      if (current.signal && current.onAbort) {
        current.signal.removeEventListener('abort', current.onAbort)
      }
      emitLifecycle()
    }

    const terminal = (runtimeFailure: PluginRuntimeFailure): void => {
      if (sessionClosed) return
      sessionClosed = true
      if (pending) {
        const current = pending
        pending = undefined
        releasePending(current)
        current.reject(new PluginSandboxError(runtimeFailure))
      }
      port.close()
      broker.terminate(runtimeFailure.code)
      liveBrokers.delete(broker)
      liveTerminals.delete(terminal)
      if (sessionAcquired) {
        sessionAcquired = false
        sessionCount--
      }
      emitLifecycle()
    }
    liveTerminals.add(terminal)
    broker.setFatalHandler(terminal)
    port.onmessageerror = (): void => terminal(failure('crashed', 'Plugin worker message deserialization failed.'))
    port.onmessage = (event): void => {
      const response = event.data
      if (!pending || !isRecord(response)) return
      if (response.protocolVersion !== PLUGIN_RUNTIME_PROTOCOL_VERSION
        || response.generation !== generation
        || response.requestId !== pending.requestId) return
      if (typeof response.kind !== 'string') {
        terminal(failure('invalid-envelope', 'Plugin worker response envelope is invalid.'))
        return
      }
      const current = pending
      if (response.kind === 'failure') {
        if (!exactKeys(response, [
          'protocolVersion', 'kind', 'generation', 'requestId', 'failure',
        ]) || !isPluginRuntimeFailure(response.failure)) {
          terminal(failure('invalid-envelope', 'Plugin worker failure response is invalid.'))
          return
        }
        pending = undefined
        releasePending(current)
        const runtimeFailure = response.failure
        current.reject(new PluginSandboxError(runtimeFailure))
        if (runtimeFailure.terminal) terminal(runtimeFailure)
        return
      }
      if (!isWorkerSuccessResponse(response, current.expectedKind)) {
        terminal(failure('invalid-envelope', 'Plugin worker success response is invalid.'))
        return
      }
      pending = undefined
      releasePending(current)
      current.resolve(response as unknown as PluginWorkerResponse)
    }
    port.start()

    const send = (
      request: Omit<PluginWorkerActivateRequest, 'requestId'>
        | Omit<PluginWorkerRenderRequest, 'requestId'>
        | Omit<PluginWorkerMigrateRequest, 'requestId'>
        | { readonly protocolVersion: 1; readonly kind: 'close'; readonly generation: number; readonly reason: string },
      transfer: Transferable[],
      deadlineMs: number,
      requestSignal?: AbortSignal,
    ): Promise<PluginWorkerResponse> => {
      if (sessionClosed) return Promise.reject(new PluginSandboxError(failure('closed', 'Plugin sandbox is closed.')))
      if (pending) return Promise.reject(new PluginSandboxError(failure('busy', 'Plugin sandbox already has an active request.')))
      if (requestSignal?.aborted) {
        terminal(failure('aborted', 'Plugin request was cancelled.'))
        return Promise.reject(new PluginSandboxError(failure('aborted', 'Plugin request was cancelled.')))
      }
      const requestId = ++requestSequence
      const expectedKind = request.kind === 'activate'
        ? 'ready'
        : request.kind === 'render'
          ? 'rendered'
          : request.kind === 'migrate'
            ? 'migrated'
            : 'closed'
      return new Promise((resolve, reject) => {
        const onAbort = requestSignal ? (): void => terminal(failure('aborted', 'Plugin request was cancelled.')) : undefined
        const timer = setTimeout(() => terminal(failure('timeout', 'Plugin request exceeded its watchdog deadline.')), deadlineMs)
        const countsAsRequest = request.kind !== 'activate'
        watchdogCount++
        if (countsAsRequest) pendingRequestCount++
        pending = {
          requestId,
          expectedKind,
          resolve,
          reject,
          timer,
          signal: requestSignal,
          onAbort,
          countsAsRequest,
        }
        emitLifecycle()
        requestSignal?.addEventListener('abort', onAbort!, { once: true })
        try {
          port.postMessage({ ...request, requestId }, transfer)
        } catch {
          zeroAttachedArrayBuffers(transfer.filter(isArrayBuffer))
          terminal(failure('crashed', 'Plugin request dispatch failed.'))
        }
      })
    }

    const activationBytes = ownedArrayBuffer(activation.moduleBytes)
    let ready: PluginWorkerResponse
    try {
      const remaining = deadlineAt - now()
      if (remaining <= 0) throw new PluginSandboxError(failure('timeout', 'Plugin activation timed out before worker dispatch.'))
      ready = await send({
        protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
        kind: 'activate',
        generation,
        moduleBytes: activationBytes,
        expectations: activation.expectations,
      }, [activationBytes], remaining, activationAbort.signal)
    } catch (cause) {
      terminal(cause instanceof PluginSandboxError ? cause.failure : failure('activation-failed', String(cause)))
      cleanupActivation()
      throw cause
    } finally {
      zeroAttachedArrayBuffers([activationBytes])
    }
    if (ready.kind !== 'ready') {
      const runtimeFailure = failure('invalid-envelope', 'Plugin worker did not return a ready response.')
      terminal(runtimeFailure)
      cleanupActivation()
      throw new PluginSandboxError(runtimeFailure)
    }
    if (!isPluginWasmModuleFacts(ready.facts, activation.expectations)) {
      const runtimeFailure = failure('invalid-envelope', 'Plugin worker facts are invalid.')
      terminal(runtimeFailure)
      cleanupActivation()
      throw new PluginSandboxError(runtimeFailure)
    }
    const facts = ready.facts
    cleanupActivation()
    sessionAcquired = true
    sessionCount++
    emitLifecycle()

    return {
      generation,
      facts,
      async render(request, deadlineMs, requestSignal) {
        const canonicalParameterBytes = ownedArrayBuffer(request.canonicalParameterBytes)
        const rgbaBytes = ownedArrayBuffer(request.rgbaBytes)
        try {
          const response = await send({
            protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
            kind: 'render',
            generation,
            entrypoint: request.entrypoint,
            width: request.width,
            height: request.height,
            stride: request.stride,
            timelineFrame: request.timelineFrame,
            frameRateNumerator: request.frameRateNumerator,
            frameRateDenominator: request.frameRateDenominator,
            canonicalParameterBytes,
            rgbaBytes,
          }, [canonicalParameterBytes, rgbaBytes], deadlineMs, requestSignal)
          if (response.kind !== 'rendered' || !isArrayBuffer(response.rgbaBytes)) {
            const runtimeFailure = failure('invalid-envelope', 'Plugin render response is invalid.')
            terminal(runtimeFailure)
            throw new PluginSandboxError(runtimeFailure)
          }
          return Object.freeze({
            identity: response.identity,
            rgbaBytes: new Uint8Array(response.rgbaBytes),
          })
        } finally {
          zeroAttachedArrayBuffers([canonicalParameterBytes, rgbaBytes])
        }
      },
      async migrate(request, requestSignal) {
        const canonicalInputBytes = ownedArrayBuffer(request.canonicalInputBytes)
        try {
          const response = await send({
            protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
            kind: 'migrate',
            generation,
            entrypoint: request.entrypoint,
            fromVersion: request.fromVersion,
            toVersion: request.toVersion,
            canonicalInputBytes,
          }, [canonicalInputBytes], PLUGIN_MIGRATION_DEADLINE_MS, requestSignal)
          if (response.kind !== 'migrated' || !isArrayBuffer(response.canonicalOutputBytes)) {
            const runtimeFailure = failure('invalid-envelope', 'Plugin migration response is invalid.')
            terminal(runtimeFailure)
            throw new PluginSandboxError(runtimeFailure)
          }
          return new Uint8Array(response.canonicalOutputBytes)
        } finally {
          zeroAttachedArrayBuffers([canonicalInputBytes])
        }
      },
      async close(reason) {
        if (sessionClosed) return
        try {
          const response = await send({
            protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
            kind: 'close',
            generation,
            reason: reason.slice(0, 512),
          }, [], 250)
          if (response.kind !== 'closed') throw new Error('Worker close response is invalid.')
        } catch {
          // Terminal cleanup below is authoritative even when the worker is wedged.
        } finally {
          terminal(failure('closed', reason))
        }
      },
    }
  }

  return {
    activate,
    teardown(reason) {
      if (teardownPromise) return teardownPromise
      tornDown = true
      teardownPromise = (async () => {
        const runtimeFailure = failure('closed', reason)
        for (const activationAbort of pendingActivationAborts) activationAbort.abort()
        for (const terminal of [...liveTerminals]) terminal(runtimeFailure)
        liveTerminals.clear()
        for (const broker of [...liveBrokers]) broker.terminate(reason)
        liveBrokers.clear()
        await Promise.allSettled([...pendingBrokerSettlements])
        await Promise.allSettled([...pendingActivationSettlements])
        // Late broker resolutions are terminated by the activation guard before
        // their settlement joins this terminal boundary.
        for (const terminal of [...liveTerminals]) terminal(runtimeFailure)
        for (const broker of [...liveBrokers]) broker.terminate(reason)
        liveTerminals.clear()
        liveBrokers.clear()
        emitLifecycle(true)
      })()
      return teardownPromise
    },
  }
}
