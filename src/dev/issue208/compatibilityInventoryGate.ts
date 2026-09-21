/** Disposable Issue #208 browser inventory. Only the gate HTML may import this. */

import { AnalysisStorage } from '../../app/analysisStorage'
import { getExportDirectoryPickerAvailability } from '../../app/exportDirectoryPicker'
import { getExportFilePickerAvailability } from '../../app/exportFilePicker'
import {
  supportsLocalMediaFolders,
  supportsLocalMediaHandles,
} from '../../app/localMediaHandles'
import { supportsLocalProjectFiles } from '../../app/localProjectStorage'
import {
  PLUGIN_SANDBOX_BROKER_MARKER,
  createBrowserPluginSandboxBroker,
  createPluginSandboxBrokerSrcdoc,
  type PluginSandboxBrokerOwnershipSnapshot,
} from '../../app/pluginSandboxController'
import { ProxyStorage } from '../../app/proxyStorage'
import {
  AUTO_EXPORT_PRESET_ORDER,
  EXPORT_PRESETS,
  exportPresetById,
} from '../../domain/exportProfile'
import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../../domain/projectFile'
import type { TimelineDoc } from '../../domain/schema'
import {
  checkExportProfileSupport,
  verifyExportProfileSupportFresh,
} from '../../pipeline/export-capabilities'
import { mediabunnyExportCapabilityProbe } from '../../pipeline/export-mediabunny-capabilities'
import {
  COMPATIBILITY_INVENTORY_CONTRACT,
  COMPATIBILITY_INVENTORY_SCHEMA_VERSION,
  type CompatibilityInventoryEvidence,
  type CompatibilityInventoryFacts,
  type ExportProfileInventory,
  type FileSystemAccessFacts,
  type InventoryResourceLedger,
  type InventoryWorkerRequest,
  type InventoryWorkerResponse,
  type NativeCodecProbe,
  type OriginStorageFacts,
  type PluginIsolationFacts,
  type SupportProbe,
  type WorkerLifecycleEvidence,
  type WorkerProbeEvidence,
} from './compatibilityInventoryContract'
import { decideCompatibilityInventory } from './compatibilityInventoryDecision'

const WORKER_TIMEOUT_MS = 20_000
const PLUGIN_PROBE_TIMEOUT_MS = 8_000
const NATIVE_ROUNDTRIP_ABORT_MS = 4_000
const NATIVE_ROUNDTRIP_BUDGET_MS = 6_000
const EXPORT_CAN_ENCODE_BUDGET_MS = 8_000
const EXPORT_FRESH_ENCODE_BUDGET_MS = 12_000
const AUDIO_CONTEXT_RESUME_MS = 2_000
const AUDIO_CONTEXT_CLOSE_MS = 2_000
const PROBE_DRAIN_MS = 3_000
const NATIVE_VIDEO_WIDTH = 320
const NATIVE_VIDEO_HEIGHT = 180
const INVENTORY_OPFS_PROBE_NAME = 'myrelith-issue208-inventory-probe'
const VIDEO_CODEC_PROBES = Object.freeze([
  Object.freeze({ id: 'avc', codec: 'avc1.42001E' }),
  Object.freeze({ id: 'vp9', codec: 'vp09.00.10.08' }),
  Object.freeze({ id: 'av1', codec: 'av01.0.04M.08' }),
  Object.freeze({ id: 'hevc', codec: 'hvc1.1.6.L90.B0' }),
])
const AUDIO_CODEC_PROBES = Object.freeze([
  Object.freeze({ id: 'opus', codec: 'opus' }),
  Object.freeze({ id: 'aac', codec: 'mp4a.40.2' }),
])

class InventoryLedger {
  videoFramesCreated = 0
  videoFramesClosed = 0
  audioDataCreated = 0
  audioDataClosed = 0
  imageBitmapsCreated = 0
  imageBitmapsClosed = 0

  snapshot(): InventoryResourceLedger {
    return Object.freeze({
      videoFramesCreated: this.videoFramesCreated,
      videoFramesClosed: this.videoFramesClosed,
      audioDataCreated: this.audioDataCreated,
      audioDataClosed: this.audioDataClosed,
      imageBitmapsCreated: this.imageBitmapsCreated,
      imageBitmapsClosed: this.imageBitmapsClosed,
    })
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim().slice(0, 240)
  }
  return String(cause).slice(0, 240)
}

function constructorPresent(name: string): boolean {
  const value = (globalThis as unknown as Record<string, unknown>)[name]
  return typeof value === 'function'
}

function failed(reason: string): SupportProbe {
  return Object.freeze({ supported: false, reason })
}

function closeQuietly(closable: { close(): void } | null | undefined): void {
  if (!closable) return
  try {
    closable.close()
  } catch {
    // Already closed by an abort timer or by the encoder/decoder itself.
  }
}

/**
 * Bound a probe without abandoning it. If the budget expires, wait briefly for
 * the in-flight work to close VideoFrames / AudioData before the next probe.
 */
export async function raceInventoryProbe(
  label: string,
  ms: number,
  work: () => Promise<SupportProbe>,
): Promise<SupportProbe> {
  const workPromise = work().then(
    (value) => value,
    (cause): SupportProbe => failed(errorMessage(cause)),
  )
  let timedOut = false
  let timeoutId = 0
  const timeoutPromise = new Promise<SupportProbe>((resolve) => {
    timeoutId = window.setTimeout(() => {
      timedOut = true
      resolve(failed(`${label}-timeout`))
    }, ms)
  })
  const first = await Promise.race([workPromise, timeoutPromise])
  window.clearTimeout(timeoutId)
  if (!timedOut) return first
  let drainExpired = false
  let drainId = 0
  const drainPromise = new Promise<SupportProbe>((resolve) => {
    drainId = window.setTimeout(() => {
      drainExpired = true
      resolve(failed(`${label}-drain-timeout`))
    }, PROBE_DRAIN_MS)
  })
  const drained = await Promise.race([workPromise, drainPromise])
  window.clearTimeout(drainId)
  return drainExpired ? first : drained
}

function succeeded(): SupportProbe {
  return Object.freeze({ supported: true, reason: null })
}

function markProgress(step: string): void {
  ;(globalThis as unknown as { __issue208InventoryProgress?: string })
    .__issue208InventoryProgress = step
}

function probeDocument(): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'issue208-inventory',
    name: 'Issue 208 inventory',
    frameRate: { num: 30, den: 1 },
    width: NATIVE_VIDEO_WIDTH,
    height: NATIVE_VIDEO_HEIGHT,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'A1',
      kind: 'audio',
      name: 'A1',
      clips: [{
        id: 'audio-clip',
        assetId: 'audio-asset',
        name: 'inventory.wav',
        sourceMode: 'timed',
        sourceRange: { startFrame: 0, durationFrames: 30 },
        timelineRange: { startFrame: 0, durationFrames: 30 },
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          anchorX: 0.5,
          anchorY: 0.5,
        },
        opacity: 1,
        volume: 1,
        effects: [],
      }],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

async function probeVideoIsConfigSupported(codec: string): Promise<SupportProbe> {
  if (typeof VideoDecoder !== 'function') return failed('video-decoder-missing')
  try {
    const result = await VideoDecoder.isConfigSupported({
      codec,
      codedWidth: NATIVE_VIDEO_WIDTH,
      codedHeight: NATIVE_VIDEO_HEIGHT,
    })
    return result.supported === true ? succeeded() : failed('decoder-config-unsupported')
  } catch (cause) {
    return failed(errorMessage(cause))
  }
}

async function probeAudioIsConfigSupported(codec: string): Promise<SupportProbe> {
  if (typeof AudioDecoder !== 'function') return failed('audio-decoder-missing')
  try {
    const result = await AudioDecoder.isConfigSupported({
      codec,
      numberOfChannels: 2,
      sampleRate: 48_000,
    })
    return result.supported === true ? succeeded() : failed('decoder-config-unsupported')
  } catch (cause) {
    return failed(errorMessage(cause))
  }
}

async function nativeVideoRoundTrip(
  codec: string,
  ledger: InventoryLedger,
): Promise<SupportProbe> {
  if (typeof VideoEncoder !== 'function' || typeof VideoDecoder !== 'function') {
    return failed('webcodecs-encoder-or-decoder-missing')
  }
  if (typeof VideoFrame !== 'function' || typeof OffscreenCanvas === 'undefined') {
    return failed('videoframe-or-offscreencanvas-missing')
  }
  const canvas = new OffscreenCanvas(NATIVE_VIDEO_WIDTH, NATIVE_VIDEO_HEIGHT)
  const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' })
  if (!context) return failed('offscreencanvas-2d-missing')
  context.fillStyle = '#224466'
  context.fillRect(0, 0, NATIVE_VIDEO_WIDTH, NATIVE_VIDEO_HEIGHT)
  const ownedVideo = {
    frame: null as VideoFrame | null,
    decoded: null as VideoFrame | null,
    encoder: null as VideoEncoder | null,
    decoder: null as VideoDecoder | null,
  }
  let abortTimer = 0
  try {
    const encoderSupport = await VideoEncoder.isConfigSupported({
      codec,
      width: NATIVE_VIDEO_WIDTH,
      height: NATIVE_VIDEO_HEIGHT,
      bitrate: 1_000_000,
      framerate: 30,
    })
    if (encoderSupport.supported !== true) return failed('encoder-config-unsupported')
    ownedVideo.frame = new VideoFrame(canvas, { timestamp: 0, duration: 33_333 })
    ledger.videoFramesCreated += 1
    const chunks: EncodedVideoChunk[] = []
    let decoderConfig: VideoDecoderConfig | undefined
    let encodeError: string | null = null
    abortTimer = window.setTimeout(() => {
      closeQuietly(ownedVideo.encoder)
      closeQuietly(ownedVideo.decoder)
    }, NATIVE_ROUNDTRIP_ABORT_MS)
    ownedVideo.encoder = new VideoEncoder({
      output(chunk, metadata) {
        if (metadata?.decoderConfig) decoderConfig = metadata.decoderConfig
        chunks.push(chunk)
      },
      error(cause) {
        encodeError = errorMessage(cause)
      },
    })
    ownedVideo.encoder.configure({
      codec,
      width: NATIVE_VIDEO_WIDTH,
      height: NATIVE_VIDEO_HEIGHT,
      bitrate: 1_000_000,
      framerate: 30,
    })
    ownedVideo.encoder.encode(ownedVideo.frame, { keyFrame: true })
    await ownedVideo.encoder.flush()
    if (encodeError) return failed(encodeError)
    if (!decoderConfig || chunks.length === 0) return failed('encoder-produced-no-config')
    const decoderSupport = await VideoDecoder.isConfigSupported(decoderConfig)
    if (decoderSupport.supported !== true) return failed('decoder-config-unsupported')
    let gotFrame = false
    ownedVideo.decoder = new VideoDecoder({
      output(outputFrame) {
        gotFrame = true
        ownedVideo.decoded = outputFrame
        ledger.videoFramesCreated += 1
      },
      error(cause) {
        encodeError = errorMessage(cause)
      },
    })
    ownedVideo.decoder.configure(decoderConfig)
    ownedVideo.decoder.decode(chunks[0]!)
    await ownedVideo.decoder.flush()
    if (encodeError) return failed(encodeError)
    return gotFrame ? succeeded() : failed('decoder-produced-no-frame')
  } catch (cause) {
    return failed(errorMessage(cause))
  } finally {
    window.clearTimeout(abortTimer)
    if (ownedVideo.decoded) {
      closeQuietly(ownedVideo.decoded)
      ledger.videoFramesClosed += 1
    }
    if (ownedVideo.frame) {
      closeQuietly(ownedVideo.frame)
      ledger.videoFramesClosed += 1
    }
    closeQuietly(ownedVideo.encoder)
    closeQuietly(ownedVideo.decoder)
  }
}

async function nativeAudioRoundTrip(
  codec: string,
  ledger: InventoryLedger,
): Promise<SupportProbe> {
  if (typeof AudioEncoder !== 'function' || typeof AudioDecoder !== 'function') {
    return failed('webcodecs-encoder-or-decoder-missing')
  }
  if (typeof AudioData !== 'function') return failed('audiodata-missing')
  const frames = 960
  const plane = new Float32Array(frames * 2)
  const ownedAudio = {
    data: null as AudioData | null,
    decoded: null as AudioData | null,
    encoder: null as AudioEncoder | null,
    decoder: null as AudioDecoder | null,
  }
  let abortTimer = 0
  try {
    const encoderSupport = await AudioEncoder.isConfigSupported({
      codec,
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 64_000,
    })
    if (encoderSupport.supported !== true) return failed('encoder-config-unsupported')
    ownedAudio.data = new AudioData({
      format: 'f32',
      sampleRate: 48_000,
      numberOfFrames: frames,
      numberOfChannels: 2,
      timestamp: 0,
      data: plane,
    })
    ledger.audioDataCreated += 1
    const chunks: EncodedAudioChunk[] = []
    let decoderConfig: AudioDecoderConfig | undefined
    let encodeError: string | null = null
    abortTimer = window.setTimeout(() => {
      closeQuietly(ownedAudio.encoder)
      closeQuietly(ownedAudio.decoder)
    }, NATIVE_ROUNDTRIP_ABORT_MS)
    ownedAudio.encoder = new AudioEncoder({
      output(chunk, metadata) {
        if (metadata?.decoderConfig) decoderConfig = metadata.decoderConfig
        chunks.push(chunk)
      },
      error(cause) {
        encodeError = errorMessage(cause)
      },
    })
    ownedAudio.encoder.configure({
      codec,
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 64_000,
    })
    ownedAudio.encoder.encode(ownedAudio.data)
    await ownedAudio.encoder.flush()
    if (encodeError) return failed(encodeError)
    if (!decoderConfig || chunks.length === 0) return failed('encoder-produced-no-config')
    const decoderSupport = await AudioDecoder.isConfigSupported(decoderConfig)
    if (decoderSupport.supported !== true) return failed('decoder-config-unsupported')
    let gotFrame = false
    ownedAudio.decoder = new AudioDecoder({
      output(outputData) {
        gotFrame = true
        ownedAudio.decoded = outputData
        ledger.audioDataCreated += 1
      },
      error(cause) {
        encodeError = errorMessage(cause)
      },
    })
    ownedAudio.decoder.configure(decoderConfig)
    ownedAudio.decoder.decode(chunks[0]!)
    await ownedAudio.decoder.flush()
    if (encodeError) return failed(encodeError)
    return gotFrame ? succeeded() : failed('decoder-produced-no-frame')
  } catch (cause) {
    return failed(errorMessage(cause))
  } finally {
    window.clearTimeout(abortTimer)
    if (ownedAudio.decoded) {
      closeQuietly(ownedAudio.decoded)
      ledger.audioDataClosed += 1
    }
    if (ownedAudio.data) {
      closeQuietly(ownedAudio.data)
      ledger.audioDataClosed += 1
    }
    closeQuietly(ownedAudio.encoder)
    closeQuietly(ownedAudio.decoder)
  }
}

async function probeNativeCodecs(ledger: InventoryLedger): Promise<{
  readonly videoCodecs: readonly NativeCodecProbe[]
  readonly audioCodecs: readonly NativeCodecProbe[]
}> {
  const videoCodecs: NativeCodecProbe[] = []
  for (const entry of VIDEO_CODEC_PROBES) {
    markProgress(`native-video-${entry.id}`)
    const isConfigSupported = await probeVideoIsConfigSupported(entry.codec)
    videoCodecs.push(Object.freeze({
      id: entry.id,
      codec: entry.codec,
      isConfigSupported,
      roundTrip: isConfigSupported.supported
        ? await raceInventoryProbe(
          `${entry.id}-video-roundtrip`,
          NATIVE_ROUNDTRIP_BUDGET_MS,
          () => nativeVideoRoundTrip(entry.codec, ledger),
        )
        : failed('skipped-config-unsupported'),
    }))
  }
  const audioCodecs: NativeCodecProbe[] = []
  for (const entry of AUDIO_CODEC_PROBES) {
    markProgress(`native-audio-${entry.id}`)
    const isConfigSupported = await probeAudioIsConfigSupported(entry.codec)
    audioCodecs.push(Object.freeze({
      id: entry.id,
      codec: entry.codec,
      isConfigSupported,
      roundTrip: isConfigSupported.supported
        ? await raceInventoryProbe(
          `${entry.id}-audio-roundtrip`,
          NATIVE_ROUNDTRIP_BUDGET_MS,
          () => nativeAudioRoundTrip(entry.codec, ledger),
        )
        : failed('skipped-config-unsupported'),
    }))
  }
  return {
    videoCodecs: Object.freeze(videoCodecs),
    audioCodecs: Object.freeze(audioCodecs),
  }
}

async function probeStillImages(ledger: InventoryLedger): Promise<{
  readonly imageDecoder: SupportProbe
  readonly createImageBitmap: SupportProbe
}> {
  if (typeof OffscreenCanvas === 'undefined') {
    return {
      imageDecoder: failed('offscreencanvas-missing'),
      createImageBitmap: failed('offscreencanvas-missing'),
    }
  }
  const canvas = new OffscreenCanvas(1, 1)
  const context = canvas.getContext('2d')
  if (!context) {
    return {
      imageDecoder: failed('offscreencanvas-2d-missing'),
      createImageBitmap: failed('offscreencanvas-2d-missing'),
    }
  }
  context.fillStyle = '#808080'
  context.fillRect(0, 0, 1, 1)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  let imageDecoderResult: SupportProbe = failed('image-decoder-missing')
  if (typeof ImageDecoder === 'function') {
    try {
      const decoder = new ImageDecoder({
        data: await blob.arrayBuffer(),
        type: 'image/png',
      })
      try {
        const result = await decoder.decode({ frameIndex: 0 })
        result.image.close()
        ledger.videoFramesCreated += 1
        ledger.videoFramesClosed += 1
        imageDecoderResult = succeeded()
      } finally {
        decoder.close()
      }
    } catch (cause) {
      imageDecoderResult = failed(errorMessage(cause))
    }
  }
  let bitmapResult: SupportProbe
  try {
    const bitmap = await createImageBitmap(blob)
    ledger.imageBitmapsCreated += 1
    bitmap.close()
    ledger.imageBitmapsClosed += 1
    bitmapResult = succeeded()
  } catch (cause) {
    bitmapResult = failed(errorMessage(cause))
  }
  return { imageDecoder: imageDecoderResult, createImageBitmap: bitmapResult }
}

async function probeExportProfiles(): Promise<readonly ExportProfileInventory[]> {
  const doc = probeDocument()
  const results: ExportProfileInventory[] = []
  for (const preset of EXPORT_PRESETS) {
    markProgress(`export-${preset.id}`)
    const selected = exportPresetById(preset.id)
    let canEncode: SupportProbe
    try {
      canEncode = await raceInventoryProbe(`${preset.id}-can-encode`, EXPORT_CAN_ENCODE_BUDGET_MS, async () => {
        const result = await checkExportProfileSupport(
          doc,
          selected.profile,
          mediabunnyExportCapabilityProbe,
        )
        return result.supported
          ? succeeded()
          : failed(result.reason ?? 'can-encode-unsupported')
      })
    } catch (cause) {
      canEncode = failed(errorMessage(cause))
    }
    let freshEncode: SupportProbe
    if (!canEncode.supported) {
      freshEncode = failed('skipped-can-encode-unsupported')
    } else {
      try {
        freshEncode = await raceInventoryProbe(`${preset.id}-fresh-encode`, EXPORT_FRESH_ENCODE_BUDGET_MS, async () => {
          const result = await verifyExportProfileSupportFresh(
            doc,
            selected.profile,
            mediabunnyExportCapabilityProbe,
          )
          return result.supported
            ? succeeded()
            : failed(result.reason ?? 'fresh-encode-unsupported')
        })
      } catch (cause) {
        freshEncode = failed(errorMessage(cause))
      }
    }
    results.push(Object.freeze({
      id: preset.id,
      autoCandidate: AUTO_EXPORT_PRESET_ORDER.includes(preset.id),
      canEncode,
      freshEncode,
    }))
  }
  return Object.freeze(results)
}

function readFileSystemFacts(): FileSystemAccessFacts {
  const host = window as Window & {
    showOpenFilePicker?: unknown
    showSaveFilePicker?: unknown
    showDirectoryPicker?: unknown
  }
  const liveSave = getExportFilePickerAvailability()
  const folder = getExportDirectoryPickerAvailability()
  return Object.freeze({
    showOpenFilePicker: typeof host.showOpenFilePicker === 'function',
    showSaveFilePicker: typeof host.showSaveFilePicker === 'function',
    showDirectoryPicker: typeof host.showDirectoryPicker === 'function',
    rememberedMediaHandles: supportsLocalMediaHandles(),
    rememberedProjectFiles: supportsLocalProjectFiles(),
    liveSaveAvailable: liveSave.available,
    directFileExportAvailable: liveSave.available,
    folderExportAvailable: folder.available && supportsLocalMediaFolders(),
    liveSaveReason: liveSave.reason,
    folderExportReason: folder.reason,
  })
}

async function probeOriginStorage(): Promise<OriginStorageFacts> {
  const indexedDbPresent = typeof indexedDB !== 'undefined'
  if (indexedDbPresent) {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('myrelith-issue208-inventory')
        request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
        request.onsuccess = () => {
          request.result.close()
          indexedDB.deleteDatabase('myrelith-issue208-inventory')
          resolve()
        }
      })
    } catch {
      // Presence is enough; open failures are origin-policy data.
    }
  }
  let cacheStorage = typeof caches !== 'undefined'
  if (cacheStorage) {
    try {
      await caches.open('myrelith-issue208-inventory')
      await caches.delete('myrelith-issue208-inventory')
    } catch {
      cacheStorage = false
    }
  }
  const proxy = new ProxyStorage()
  const analysis = new AnalysisStorage()
  const opfsGetDirectory = proxy.supported()
    && analysis.supported()
    && typeof navigator.storage?.getDirectory === 'function'
  let opfsCreateWritable: SupportProbe = failed('opfs-getdirectory-missing')
  if (typeof navigator.storage?.getDirectory === 'function') {
    try {
      const root = await navigator.storage.getDirectory()
      const handle = await root.getFileHandle(INVENTORY_OPFS_PROBE_NAME, { create: true })
      const writable = await handle.createWritable()
      try {
        await writable.write(new Uint8Array([1]))
      } finally {
        await writable.close()
      }
      await root.removeEntry(INVENTORY_OPFS_PROBE_NAME)
      opfsCreateWritable = succeeded()
    } catch (cause) {
      opfsCreateWritable = failed(errorMessage(cause))
      try {
        const root = await navigator.storage.getDirectory()
        await root.removeEntry(INVENTORY_OPFS_PROBE_NAME)
      } catch {
        // Best-effort cleanup of a leftover probe file.
      }
    }
  }
  let persisted: boolean | null = null
  try {
    if (typeof navigator.storage?.persisted === 'function') {
      persisted = await navigator.storage.persisted()
    }
  } catch {
    persisted = null
  }
  return Object.freeze({
    indexedDB: indexedDbPresent,
    cacheStorage,
    opfsGetDirectory,
    opfsCreateWritable,
    persisted,
  })
}

async function probeAudioContext(): Promise<CompatibilityInventoryFacts['audioContext']> {
  if (typeof AudioContext !== 'function') {
    return Object.freeze({
      constructed: false,
      initialState: null,
      resumeAttempted: false,
      stateAfterResume: null,
      closed: false,
      reason: 'AudioContext is not defined',
    })
  }
  let context: AudioContext | null = null
  try {
    context = new AudioContext()
    const initialState = context.state
    const resumeOutcome = await Promise.race([
      context.resume().then(() => 'resumed' as const),
      new Promise<'timeout'>((resolve) => {
        window.setTimeout(() => resolve('timeout'), AUDIO_CONTEXT_RESUME_MS)
      }),
    ])
    const stateAfterResume = context.state
    try {
      await Promise.race([
        context.close(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('audio-context-close-timeout')), AUDIO_CONTEXT_CLOSE_MS)
        }),
      ])
    } catch (cause) {
      return Object.freeze({
        constructed: true,
        initialState,
        resumeAttempted: true,
        stateAfterResume,
        closed: false,
        reason: resumeOutcome === 'timeout'
          ? 'audio-context-resume-timeout'
          : errorMessage(cause),
      })
    }
    return Object.freeze({
      constructed: true,
      initialState,
      resumeAttempted: true,
      stateAfterResume,
      closed: true,
      reason: resumeOutcome === 'timeout' ? 'audio-context-resume-timeout' : null,
    })
  } catch (cause) {
    if (context) {
      try {
        await context.close()
      } catch {
        // Close is best-effort after a construct/resume failure.
      }
    }
    return Object.freeze({
      constructed: context !== null,
      initialState: context?.state ?? null,
      resumeAttempted: context !== null,
      stateAfterResume: context?.state ?? null,
      closed: false,
      reason: errorMessage(cause),
    })
  }
}

function readGraphicsFacts(): CompatibilityInventoryFacts['graphics'] {
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined'
  let offscreenCanvas2d = false
  if (offscreenCanvas) {
    const canvas = new OffscreenCanvas(8, 8)
    offscreenCanvas2d = canvas.getContext('2d') !== null
  }
  const pageCanvas = document.createElement('canvas')
  pageCanvas.width = 16
  pageCanvas.height = 16
  const canTransfer = typeof pageCanvas.transferControlToOffscreen === 'function'
  let transferred = false
  if (canTransfer) {
    try {
      pageCanvas.transferControlToOffscreen()
      transferred = true
    } catch {
      transferred = false
    }
  }
  return Object.freeze({
    offscreenCanvas,
    offscreenCanvas2d,
    transferControlToOffscreen: transferred,
  })
}

function workerFailure(prefix: string, event: ErrorEvent | MessageEvent): Error {
  if (event instanceof ErrorEvent) return new Error(`${prefix}: ${event.message}`)
  return new Error(`${prefix}: worker response could not be deserialized`)
}

export async function runInventoryWorkerProbe(): Promise<{
  readonly worker: WorkerProbeEvidence
  readonly lifecycle: WorkerLifecycleEvidence
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./compatibility-inventory.worker.ts', import.meta.url),
      { type: 'module' },
    )
    let settled = false
    const finish = (
      workerEvidence: WorkerProbeEvidence | null,
      error: unknown | null,
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
      worker.terminate()
      if (error !== null) reject(error)
      else {
        resolve({
          worker: workerEvidence!,
          lifecycle: Object.freeze({
            workersCreated: 1,
            workersTerminated: 1,
            activeWorkers: 0,
          }),
        })
      }
    }
    const onMessage = (event: MessageEvent<InventoryWorkerResponse>): void => {
      if (event.data.type === 'error') finish(null, new Error(event.data.detail))
      else finish(event.data.worker, null)
    }
    const onError = (event: ErrorEvent): void => {
      finish(null, workerFailure('Issue 208 inventory worker failed', event))
    }
    const onMessageError = (event: MessageEvent): void => {
      finish(null, workerFailure('Issue 208 inventory worker failed', event))
    }
    const timeout = setTimeout(() => {
      finish(null, new Error(`Issue 208 inventory worker exceeded its ${WORKER_TIMEOUT_MS / 1000} second deadline`))
    }, WORKER_TIMEOUT_MS)
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)
    try {
      const request: InventoryWorkerRequest = { type: 'run', canvas: null }
      worker.postMessage(request)
    } catch (cause) {
      finish(null, cause)
    }
  })
}

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
    try {
      const socket=new WebSocket(webSocketTarget);
      socket.onerror=()=>finish(true);socket.onopen=()=>{socket.close();finish(false)};
    } catch { finish(true) }
  });
  let sendBeaconBlocked=true;
  try {
    sendBeaconBlocked=typeof navigator==='undefined'||typeof navigator.sendBeacon!=='function'||navigator.sendBeacon(networkTarget,new Uint8Array([1]))===false;
  } catch { sendBeaconBlocked=true }
  const indexedDbBlocked=typeof indexedDB==='undefined'||await blockedRequest((finish)=>{
    const request=indexedDB.open('myrelith-issue208-plugin-probe');
    request.onerror=()=>finish(true);request.onblocked=()=>finish(true);request.onsuccess=()=>{request.result.close();indexedDB.deleteDatabase('myrelith-issue208-plugin-probe');finish(false)};
  });
  const cacheStorageBlocked=typeof caches==='undefined'||await caches.open('myrelith-issue208-plugin-probe').then(async()=>{await caches.delete('myrelith-issue208-plugin-probe');return false},()=>true);
  let opfsBlocked=true;
  try {
    opfsBlocked=typeof navigator==='undefined'||typeof navigator.storage?.getDirectory!=='function'||await navigator.storage.getDirectory().then(()=>false,()=>true);
  } catch { opfsBlocked=true }
  return {
    opaqueOrigin:self.origin==='null'||location.origin==='null',
    parentDomUnavailable:typeof document==='undefined',
    networkFetchBlocked,networkXhrBlocked,networkWebSocketBlocked,sendBeaconBlocked,indexedDbBlocked,cacheStorageBlocked,opfsBlocked,
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

const PLUGIN_BLOCK_KEYS = [
  'opaqueOrigin',
  'parentDomUnavailable',
  'networkFetchBlocked',
  'networkXhrBlocked',
  'networkWebSocketBlocked',
  'sendBeaconBlocked',
  'indexedDbBlocked',
  'cacheStorageBlocked',
  'opfsBlocked',
] as const

async function probePluginIsolation(): Promise<PluginIsolationFacts> {
  const srcdoc = createPluginSandboxBrokerSrcdoc('issue208nonce', 'self.close()')
  const wasmUnsafeEvalInSrcdoc = srcdoc.includes("'wasm-unsafe-eval'")
    && srcdoc.includes(PLUGIN_SANDBOX_BROKER_MARKER)
  const ownershipSnapshots: PluginSandboxBrokerOwnershipSnapshot[] = []
  try {
    const broker = await createBrowserPluginSandboxBroker({
      generation: 208,
      workerSource: sandboxProbeWorkerSource(
        `${window.location.origin}/scripts/issue208/compatibility-inventory-gate.html`,
        `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/`,
      ),
      deadlineAt: performance.now() + 5_000,
      reportOwnership: (snapshot) => ownershipSnapshots.push(snapshot),
    })
    let results: Record<string, unknown>
    try {
      results = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error('Plugin isolation probe timed out')),
          PLUGIN_PROBE_TIMEOUT_MS,
        )
        broker.runtimePort.onmessage = (event): void => {
          if (!isRecord(event.data)) return
          if (event.data.kind === 'sandbox-capability-probe-error') {
            window.clearTimeout(timer)
            reject(new Error(
              typeof event.data.message === 'string'
                ? event.data.message
                : 'Plugin isolation probe failed',
            ))
            return
          }
          if (event.data.kind !== 'sandbox-capability-probe' || !isRecord(event.data.results)) {
            return
          }
          window.clearTimeout(timer)
          resolve(event.data.results)
        }
        broker.runtimePort.start()
      })
    } finally {
      await broker.terminate('issue208-plugin-isolation-probe-complete')
    }
    const terminal = ownershipSnapshots.at(-1)
    const released = terminal !== undefined
      && terminal.brokerIframeCount === 0
      && terminal.candidateWorkerCount === 0
      && terminal.privatePortCount === 0
    const failedKeys = PLUGIN_BLOCK_KEYS.filter((key) => results[key] !== true)
    const isolationProven = released && failedKeys.length === 0
    return Object.freeze({
      srcdocSandboxCreated: true,
      wasmUnsafeEvalInSrcdoc,
      opaqueOrigin: results.opaqueOrigin === true,
      networkFetchBlocked: results.networkFetchBlocked === true,
      networkXhrBlocked: results.networkXhrBlocked === true,
      networkWebSocketBlocked: results.networkWebSocketBlocked === true,
      sendBeaconBlocked: results.sendBeaconBlocked === true,
      indexedDbBlocked: results.indexedDbBlocked === true,
      cacheStorageBlocked: results.cacheStorageBlocked === true,
      opfsBlocked: results.opfsBlocked === true,
      parentDomUnavailable: results.parentDomUnavailable === true,
      isolationProven,
      reason: isolationProven
        ? null
        : (!released
          ? 'plugin-broker-resources-not-released'
          : `isolation-unproven:${failedKeys.join(',')}`),
    })
  } catch (cause) {
    return Object.freeze({
      srcdocSandboxCreated: false,
      wasmUnsafeEvalInSrcdoc,
      opaqueOrigin: null,
      networkFetchBlocked: null,
      networkXhrBlocked: null,
      networkWebSocketBlocked: null,
      sendBeaconBlocked: null,
      indexedDbBlocked: null,
      cacheStorageBlocked: null,
      opfsBlocked: null,
      parentDomUnavailable: null,
      isolationProven: false,
      reason: errorMessage(cause),
    })
  }
}

export async function runCompatibilityInventoryBrowserGate(): Promise<CompatibilityInventoryEvidence> {
  const ledger = new InventoryLedger()
  markProgress('audio-context')
  const audioContext = await probeAudioContext()
  markProgress('filesystem')
  const fileSystem = readFileSystemFacts()
  markProgress('graphics')
  const graphics = readGraphicsFacts()
  markProgress('worker')
  const workerRun = await runInventoryWorkerProbe()
  markProgress('storage')
  const storage = await probeOriginStorage()
  markProgress('native-codecs')
  const nativeCodecs = await probeNativeCodecs(ledger)
  markProgress('still-images')
  const stillImages = await probeStillImages(ledger)
  markProgress('export-profiles')
  const exportProfiles = await probeExportProfiles()
  markProgress('plugins')
  const plugins = await probePluginIsolation()
  markProgress('assemble')
  const facts: CompatibilityInventoryFacts = Object.freeze({
    secureContext: window.isSecureContext === true,
    webCodecs: Object.freeze({
      VideoDecoder: Object.freeze({ present: constructorPresent('VideoDecoder') }),
      VideoEncoder: Object.freeze({ present: constructorPresent('VideoEncoder') }),
      AudioDecoder: Object.freeze({ present: constructorPresent('AudioDecoder') }),
      AudioEncoder: Object.freeze({ present: constructorPresent('AudioEncoder') }),
      ImageDecoder: Object.freeze({ present: constructorPresent('ImageDecoder') }),
      VideoFrame: Object.freeze({ present: constructorPresent('VideoFrame') }),
      AudioData: Object.freeze({ present: constructorPresent('AudioData') }),
    }),
    videoCodecs: nativeCodecs.videoCodecs,
    audioCodecs: nativeCodecs.audioCodecs,
    stillImages,
    exportProfiles,
    fileSystem,
    storage,
    audioContext,
    graphics,
    worker: workerRun.worker,
    plugins,
  })
  const resources = ledger.snapshot()
  if (
    resources.videoFramesCreated !== resources.videoFramesClosed
    || resources.audioDataCreated !== resources.audioDataClosed
    || resources.imageBitmapsCreated !== resources.imageBitmapsClosed
  ) {
    throw new Error(
      'Issue 208 inventory leaked a VideoFrame, AudioData, or ImageBitmap',
    )
  }
  return Object.freeze({
    contract: COMPATIBILITY_INVENTORY_CONTRACT,
    schemaVersion: COMPATIBILITY_INVENTORY_SCHEMA_VERSION,
    publicSupportClaim: false,
    facts,
    decision: decideCompatibilityInventory(facts),
    resources,
    workerLifecycle: workerRun.lifecycle,
  })
}
