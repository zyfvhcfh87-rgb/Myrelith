/** Browser-only Issue #77 gate: the audited archive crosses the real app boundary. */

import {
  createPluginAppAcceptanceSession,
  type PluginAppController,
  type PluginAppFile,
} from '../../app/pluginAppController'
import {
  createBrowserPluginSandboxBroker,
  type PluginSandboxBrokerOwnershipSnapshot,
} from '../../app/pluginSandboxController'
import { localPluginStorage } from '../../app/localPluginStorage'
import { createPluginLifecycleEvidence, type PluginLifecycleEvidence } from './pluginLifecycleEvidence'

const SAMPLE_PLUGIN_ID = 'com.myrelith.sample.audited-invert'
type PluginEffectBridgeHandlerRequest = Parameters<
  ReturnType<PluginAppController['getEffectBridgeHandler']>['apply']
>[0]

export interface PluginAcceptanceEvidence {
  readonly pluginId: string
  readonly packageDigest: string
  readonly signerFingerprint: string
  readonly contributionCount: number
  readonly tamperedPackageRejected: boolean
  readonly cancellationRejected: boolean
  readonly crossContextRevocationRejected: boolean
  readonly previewOutput: readonly number[]
  readonly exportOutput: readonly number[]
  readonly sandboxCapabilities: PluginSandboxCapabilityEvidence
  readonly lifecycle: PluginLifecycleEvidence
}

export interface PluginSandboxCapabilityEvidence {
  readonly opaqueOrigin: boolean
  readonly domUnavailable: boolean
  readonly openerUnavailable: boolean
  readonly networkFetchBlocked: boolean
  readonly networkXhrBlocked: boolean
  readonly networkWebSocketBlocked: boolean
  readonly sendBeaconBlocked: boolean
  readonly indexedDbBlocked: boolean
  readonly cacheStorageBlocked: boolean
  readonly dynamicScriptBlocked: boolean
  readonly nestedWorkerBlocked: boolean
  readonly webRtcUnavailable: boolean
  readonly terminalOwnership: PluginSandboxBrokerOwnershipSnapshot
}

const SANDBOX_CAPABILITY_KEYS = Object.freeze([
  'opaqueOrigin',
  'domUnavailable',
  'openerUnavailable',
  'networkFetchBlocked',
  'networkXhrBlocked',
  'networkWebSocketBlocked',
  'sendBeaconBlocked',
  'indexedDbBlocked',
  'cacheStorageBlocked',
  'dynamicScriptBlocked',
  'nestedWorkerBlocked',
  'webRtcUnavailable',
] as const)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sandboxProbeWorkerSource(networkTarget: string, webSocketTarget: string): string {
  return `'use strict';
const networkTarget=${JSON.stringify(networkTarget)};
const webSocketTarget=${JSON.stringify(webSocketTarget)};
function blockedRequest(start) {
  return new Promise((resolve) => {
    let settled=false;
    const finish=(blocked)=>{if(settled)return;settled=true;resolve(blocked)};
    try{start(finish)}catch{finish(true)}
    setTimeout(()=>finish(false),2000);
  });
}
async function runProbe() {
  const networkFetchBlocked=typeof fetch!=='function'||await fetch(networkTarget,{cache:'no-store'}).then(()=>false,()=>true);
  const networkXhrBlocked=typeof XMLHttpRequest==='undefined'||await blockedRequest((finish)=>{
    const request=new XMLHttpRequest();
    request.onerror=()=>finish(true);request.onabort=()=>finish(true);request.ontimeout=()=>finish(true);request.onload=()=>finish(false);
    request.timeout=1500;request.open('GET',networkTarget);request.send();
  });
  const networkWebSocketBlocked=typeof WebSocket==='undefined'||await blockedRequest((finish)=>{
    const socket=new WebSocket(webSocketTarget);
    socket.onerror=()=>finish(true);socket.onopen=()=>{socket.close();finish(false)};
  });
  const sendBeaconBlocked=typeof navigator==='undefined'||typeof navigator.sendBeacon!=='function'||navigator.sendBeacon(networkTarget,new Uint8Array([1]))===false;
  const indexedDbBlocked=typeof indexedDB==='undefined'||await blockedRequest((finish)=>{
    const request=indexedDB.open('myrelith-plugin-security-probe');
    request.onerror=()=>finish(true);request.onblocked=()=>finish(true);request.onsuccess=()=>{request.result.close();indexedDB.deleteDatabase('myrelith-plugin-security-probe');finish(false)};
  });
  const cacheStorageBlocked=typeof caches==='undefined'||await caches.open('myrelith-plugin-security-probe').then(async()=>{await caches.delete('myrelith-plugin-security-probe');return false},()=>true);
  let dynamicScriptBlocked=true;
  try{importScripts('data:text/javascript,self.__myrelithDynamicScript=true');dynamicScriptBlocked=self.__myrelithDynamicScript!==true}catch{}
  const nestedWorkerBlocked=typeof Worker==='undefined'||await blockedRequest((finish)=>{
    const nested=new Worker('data:text/javascript,self.postMessage(1)');
    nested.onerror=()=>{nested.terminate();finish(true)};nested.onmessage=()=>{nested.terminate();finish(false)};
  });
  return {
    opaqueOrigin:self.origin==='null'||location.origin==='null',
    domUnavailable:typeof document==='undefined'&&typeof window==='undefined',
    openerUnavailable:typeof parent==='undefined'&&typeof opener==='undefined'&&typeof open==='undefined',
    networkFetchBlocked,networkXhrBlocked,networkWebSocketBlocked,sendBeaconBlocked,indexedDbBlocked,cacheStorageBlocked,dynamicScriptBlocked,nestedWorkerBlocked,
    webRtcUnavailable:typeof RTCPeerConnection==='undefined',
  };
}
self.onmessage=async(event)=>{
  const value=event.data;
  if(!value||value.kind!=='connect'||!(value.port instanceof MessagePort))return;
  const port=value.port;port.start();
  try{port.postMessage({kind:'sandbox-capability-probe',results:await runProbe()})}
  catch(error){port.postMessage({kind:'sandbox-capability-probe-error',message:String(error instanceof Error?error.message:error).slice(0,512)})}
};`
}

async function runSandboxCapabilityProbe(): Promise<PluginSandboxCapabilityEvidence> {
  const ownershipSnapshots: PluginSandboxBrokerOwnershipSnapshot[] = []
  const broker = await createBrowserPluginSandboxBroker({
    generation: 77,
    workerSource: sandboxProbeWorkerSource(
      `${window.location.origin}/scripts/issue77/plugin-acceptance-gate.html`,
      `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/`,
    ),
    deadlineAt: performance.now() + 5_000,
    reportOwnership: (snapshot) => ownershipSnapshots.push(snapshot),
  })
  let results: Record<string, unknown>
  try {
    results = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Sandbox capability probe timed out')), 8_000)
      broker.runtimePort.onmessage = (event): void => {
        if (!isRecord(event.data)) return
        if (event.data.kind === 'sandbox-capability-probe-error') {
          window.clearTimeout(timer)
          reject(new Error(typeof event.data.message === 'string' ? event.data.message : 'Sandbox capability probe failed'))
          return
        }
        if (event.data.kind !== 'sandbox-capability-probe' || !isRecord(event.data.results)) return
        window.clearTimeout(timer)
        resolve(event.data.results)
      }
      broker.runtimePort.start()
    })
    const failed = SANDBOX_CAPABILITY_KEYS.filter((key) => results[key] !== true)
    if (failed.length > 0) {
      throw new Error(`Sandbox capability probes escaped: ${failed.join(', ')}`)
    }
  } finally {
    await broker.terminate('issue77-sandbox-capability-probe-complete')
  }
  const terminalOwnership = ownershipSnapshots.at(-1)
  if (!terminalOwnership
    || terminalOwnership.brokerIframeCount !== 0
    || terminalOwnership.candidateWorkerCount !== 0
    || terminalOwnership.privatePortCount !== 0) {
    throw new Error('Sandbox capability probe did not release every broker resource')
  }
  return Object.freeze({
    ...Object.fromEntries(SANDBOX_CAPABILITY_KEYS.map((key) => [key, true])),
    terminalOwnership,
  }) as unknown as PluginSandboxCapabilityEvidence
}

function archiveFile(bytes: ArrayBuffer): PluginAppFile {
  const owned = bytes.slice(0)
  return Object.freeze({
    size: owned.byteLength,
    arrayBuffer: async () => owned.slice(0),
  })
}

export async function runPluginAcceptanceBrowserGate(
  archiveBytes: ArrayBuffer,
): Promise<PluginAcceptanceEvidence> {
  const sandboxCapabilities = await runSandboxCapabilityProbe()
  const lifecycle = createPluginLifecycleEvidence()
  const acceptance = createPluginAppAcceptanceSession(lifecycle.observer)
  try {
    const tampered = archiveBytes.slice(0)
    const tamperedBytes = new Uint8Array(tampered)
    tamperedBytes[tamperedBytes.byteLength - 1] ^= 0xff
    let tamperedPackageRejected = false
    try {
      await acceptance.controller.inspectFile(archiveFile(tampered))
    } catch {
      tamperedPackageRejected = true
    }
    if (!tamperedPackageRejected) throw new Error('A tampered sample package was accepted')
    await acceptance.controller.cancelInspection()

    const cancelled = new AbortController()
    cancelled.abort('issue77-cancel-probe')
    let cancellationRejected = false
    try {
      await acceptance.controller.inspectFile(archiveFile(archiveBytes), cancelled.signal)
    } catch {
      cancellationRejected = true
    }
    if (!cancellationRejected) throw new Error('A pre-cancelled package inspection was accepted')

    const review = await acceptance.controller.inspectFile(archiveFile(archiveBytes))
    if (review.id !== SAMPLE_PLUGIN_ID || review.signatureState !== 'valid') {
      throw new Error('The app-owned inspection did not accept the audited sample identity')
    }
    await acceptance.controller.installPlugin({
      reviewToken: review.reviewToken,
      trustSigner: true,
      grantedPermissionIds: review.permissions.filter((permission) => permission.required).map((permission) => permission.id),
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })
    const catalog = await acceptance.exportFacade.getDeclarationCatalog()
    const declaration = catalog.declarations.find((candidate) => candidate.pluginId === SAMPLE_PLUGIN_ID)
    if (!declaration || declaration.availability !== 'ready') {
      throw new Error('The installed audited sample is absent from the ready app-owned declaration catalog')
    }
    const identity = Object.freeze({
      catalogGeneration: catalog.generation,
      pluginId: declaration.pluginId,
      pluginVersion: declaration.pluginVersion,
      packageDigest: declaration.packageDigest,
      signerFingerprint: declaration.signerFingerprint,
      kind: declaration.kind,
      contributionId: declaration.contributionId,
      contributionVersion: declaration.contributionVersion,
      descriptorVersion: declaration.descriptorVersion,
      entrypoint: declaration.entrypoint,
    })
    const applyRequest = (requestId: number, rgbaBytes: Uint8Array) => Object.freeze({
      ...identity,
      requestId,
      descriptorId: 'issue77-browser-effect',
      canonicalParameterJson: '{"invert":true}',
      timelineFrame: 0,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      width: 1,
      height: 1,
      stride: 4,
      rgbaBytes,
    })
    const previewRequest = (
      requestId: number,
      rgbaBytes: Uint8Array<ArrayBuffer>,
    ): PluginEffectBridgeHandlerRequest => Object.freeze({
      requestId,
      execution: Object.freeze({
        ...identity,
        parameterRecord: Object.freeze({ invert: true }),
        canonicalParameterJson: '{"invert":true}',
      }),
      descriptorId: 'issue77-browser-effect',
      timelineFrame: 0,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      width: 1,
      height: 1,
      stride: 4,
      rgbaBytes,
    })
    const preview = await acceptance.controller.getEffectBridgeHandler().apply(
      previewRequest(1, Uint8Array.of(10, 20, 30, 255)),
      new AbortController().signal,
    )
    if (preview.status !== 'applied') throw new Error('The sample plugin did not render in preview')
    const previewOutput = [...preview.rgbaBytes]
    if (previewOutput.join(',') !== '245,235,225,255') {
      throw new Error(`Preview returned unexpected sample pixels: ${previewOutput.join(',')}`)
    }

    const preflight = Object.freeze({
      requiredEffects: [Object.freeze({
        ...identity,
        maximumSurfaceWidth: 1,
        maximumSurfaceHeight: 1,
        maximumSurfaceStride: 4,
        maximumSurfaceByteLength: 4,
      })],
    })
    const exported = await acceptance.exportFacade.applyAndCloseExport(
      preflight,
      applyRequest(2, Uint8Array.of(1, 2, 3, 255)),
    )
    if (exported.status !== 'applied') throw new Error('The sample plugin did not render in export')
    const exportOutput = [...exported.rgbaBytes]
    if (exportOutput.join(',') !== '254,253,252,255') {
      throw new Error(`Export returned unexpected sample pixels: ${exportOutput.join(',')}`)
    }

    // Mutate the authoritative IndexedDB record through the same CAS primitive
    // used by another same-origin tab. The first controller has no in-memory
    // notification, so its per-call generation recheck is the decisive gate.
    const currentRecord = await localPluginStorage.load(SAMPLE_PLUGIN_ID)
    if (!currentRecord) throw new Error('The installed sample disappeared before revocation')
    const disabledRecord = Object.freeze({
      ...currentRecord,
      revision: currentRecord.revision + 1,
      updatedAt: Math.max(Date.now(), currentRecord.updatedAt),
      activationState: 'disabled' as const,
      archiveBytes: currentRecord.archiveBytes.slice(),
    })
    const disabled = await localPluginStorage.replace(
      SAMPLE_PLUGIN_ID,
      { packageDigest: currentRecord.packageDigest, revision: currentRecord.revision },
      disabledRecord,
    )
    if (!disabled) throw new Error('The independent IndexedDB revocation did not commit')
    let crossContextRevocationRejected = false
    let revocationFailure: unknown
    try {
      const staleApply = await acceptance.controller.getEffectBridgeHandler().apply(
        previewRequest(3, Uint8Array.of(10, 20, 30, 255)),
        new AbortController().signal,
      )
      crossContextRevocationRejected = staleApply.status === 'bypassed'
      if (!crossContextRevocationRejected) {
        throw new Error('A warmed runtime survived an independent IndexedDB revocation')
      }
    } catch (cause) {
      revocationFailure = cause
    }
    let restorationFailure: unknown
    try {
      const revokedRecord = await localPluginStorage.load(SAMPLE_PLUGIN_ID)
      if (!revokedRecord) throw new Error('The revoked sample disappeared before restoration')
      const enabledRecord = Object.freeze({
        ...revokedRecord,
        revision: revokedRecord.revision + 1,
        updatedAt: Math.max(Date.now(), revokedRecord.updatedAt),
        activationState: 'enabled' as const,
        archiveBytes: revokedRecord.archiveBytes.slice(),
      })
      const restored = await localPluginStorage.replace(
        SAMPLE_PLUGIN_ID,
        { packageDigest: revokedRecord.packageDigest, revision: revokedRecord.revision },
        enabledRecord,
      )
      if (!restored) throw new Error('The independent IndexedDB revocation could not be restored')
    } catch (cause) {
      restorationFailure = cause
    }
    if (revocationFailure !== undefined && restorationFailure !== undefined) {
      throw new AggregateError(
        [revocationFailure, restorationFailure],
        'Revocation proof and authoritative state restoration both failed',
      )
    }
    if (revocationFailure !== undefined) throw revocationFailure
    if (restorationFailure !== undefined) throw restorationFailure
    await acceptance.controller.refreshManagement()
    await acceptance.controller.uninstallPlugin(SAMPLE_PLUGIN_ID)
    await acceptance.close('issue77-browser-gate-complete')
    return Object.freeze({
      pluginId: review.id,
      packageDigest: review.packageDigest,
      signerFingerprint: review.signerFingerprint,
      contributionCount: catalog.declarations.length,
      tamperedPackageRejected,
      cancellationRejected,
      crossContextRevocationRejected,
      previewOutput: Object.freeze(previewOutput),
      exportOutput: Object.freeze(exportOutput),
      sandboxCapabilities,
      lifecycle: lifecycle.assertTerminal(),
    })
  } catch (cause) {
    await acceptance.close('issue77-browser-gate-failed').catch(() => {})
    throw cause
  }
}
