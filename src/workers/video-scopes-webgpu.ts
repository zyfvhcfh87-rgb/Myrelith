/** Optional WebGPU compute experiment for the existing bounded video scopes. */

import {
  analyzeVideoScopes,
  VIDEO_SCOPE_HISTOGRAM_BINS,
  VIDEO_SCOPE_SAMPLE_HEIGHT,
  VIDEO_SCOPE_SAMPLE_WIDTH,
  VIDEO_SCOPE_VECTOR_SIZE,
  VIDEO_SCOPE_WAVEFORM_HEIGHT,
  videoScopeLegacyLumaTieRoundsDown,
  type VideoScopeAnalysis,
} from '../domain/videoScopes'

export type VideoScopeExecutionBackend = 'cpu' | 'webgpu'

export type VideoScopeWebGpuFallbackReason =
  | 'not-requested'
  | 'unsupported-input-shape'
  | 'api-unavailable'
  | 'adapter-unavailable'
  | 'initialization-failed'
  | 'self-test-mismatch'
  | 'device-lost'
  | 'execution-failed'

export interface VideoScopeAdapterInfo {
  readonly vendor: string
  readonly architecture: string
  readonly device: string
  readonly description: string
}

export interface VideoScopeWebGpuSessionSnapshot {
  readonly adapterInfo: VideoScopeAdapterInfo
  readonly activeBufferBytes: number
  readonly peakBufferBytes: number
  readonly released: boolean
}

export interface VideoScopeWebGpuSession {
  readonly lost: Promise<string>
  analyze(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<VideoScopeAnalysis>
  snapshot(): VideoScopeWebGpuSessionSnapshot
  loseForExperiment(): Promise<string>
  release(): void
}

export type VideoScopeWebGpuSessionRequest =
  | {
      readonly status: 'ready'
      readonly session: VideoScopeWebGpuSession
    }
  | {
      readonly status: 'unavailable'
      readonly reason: 'api-unavailable' | 'adapter-unavailable' | 'initialization-failed'
      readonly detail: string
    }

export interface OptionalVideoScopeAnalysisResult {
  readonly analysis: VideoScopeAnalysis
  readonly backend: VideoScopeExecutionBackend
  readonly fallbackReason: VideoScopeWebGpuFallbackReason | null
  readonly elapsedMs: number
}

export interface OptionalVideoScopeAnalyzerSnapshot {
  readonly state: 'idle' | 'initializing' | 'ready' | 'fallback' | 'released'
  readonly fallbackReason: VideoScopeWebGpuFallbackReason | null
  readonly fallbackDetail: string | null
  readonly startupMs: number | null
  readonly adapterInfo: VideoScopeAdapterInfo | null
  readonly activeBufferBytes: number
  readonly peakBufferBytes: number
}

export interface OptionalVideoScopeAnalyzer {
  analyze(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<OptionalVideoScopeAnalysisResult>
  snapshot(): OptionalVideoScopeAnalyzerSnapshot
  loseDeviceForExperiment(): Promise<string | null>
  release(): void
}

export interface OptionalVideoScopeAnalyzerOptions {
  readonly preferWebGpu?: boolean
  readonly now?: () => number
  readonly requestSession?: () => Promise<VideoScopeWebGpuSessionRequest>
  readonly cpuAnalyze?: typeof analyzeVideoScopes
}

const HISTOGRAM_U32_COUNT = VIDEO_SCOPE_HISTOGRAM_BINS * 4
const WAVEFORM_U32_COUNT = VIDEO_SCOPE_SAMPLE_WIDTH * VIDEO_SCOPE_WAVEFORM_HEIGHT
const VECTOR_U32_COUNT = VIDEO_SCOPE_VECTOR_SIZE * VIDEO_SCOPE_VECTOR_SIZE
const WAVEFORM_OFFSET = HISTOGRAM_U32_COUNT
const VECTOR_OFFSET = WAVEFORM_OFFSET + WAVEFORM_U32_COUNT
const SAMPLE_COUNT_OFFSET = VECTOR_OFFSET + VECTOR_U32_COUNT
const OUTPUT_U32_COUNT = SAMPLE_COUNT_OFFSET + 1
const INPUT_U32_COUNT = VIDEO_SCOPE_SAMPLE_WIDTH * VIDEO_SCOPE_SAMPLE_HEIGHT * 4
const PARAMETER_BYTES = 16
const GPU_BUFFER_USAGE = {
  mapRead: 0x0001,
  copySrc: 0x0004,
  copyDst: 0x0008,
  uniform: 0x0040,
  storage: 0x0080,
} as const
const GPU_MAP_READ = 0x0001
const INPUT_ALPHA_MASK = 0xff
const INPUT_LEGACY_LUMA_TIE_DOWN_FLAG = 0x100

export const VIDEO_SCOPE_WEBGPU_ACTIVE_BUFFER_BYTES =
  INPUT_U32_COUNT * Uint32Array.BYTES_PER_ELEMENT
  + OUTPUT_U32_COUNT * Uint32Array.BYTES_PER_ELEMENT * 2
  + PARAMETER_BYTES

function wgslRoundThresholds(divisor: number, scale: number): string {
  return Array.from({ length: scale }, (_, index) => {
    const level = index + 1
    return `${Math.ceil((2 * level - 1) * divisor / (2 * scale))}u`
  }).join(', ')
}

const WAVEFORM_THRESHOLDS = wgslRoundThresholds(650_250_000, 63)
const CB_THRESHOLDS = wgslRoundThresholds(2 * 255 * 255 * 18_556, 63)
const CR_THRESHOLDS = wgslRoundThresholds(2 * 255 * 255 * 15_748, 63)

const VIDEO_SCOPE_COMPUTE_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  pixelCount: u32,
  padding: u32,
}

@group(0) @binding(0) var<storage, read> rgba: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: Params;

const HISTOGRAM_BINS: u32 = ${VIDEO_SCOPE_HISTOGRAM_BINS}u;
const WAVEFORM_HEIGHT: u32 = ${VIDEO_SCOPE_WAVEFORM_HEIGHT}u;
const VECTOR_SIZE: u32 = ${VIDEO_SCOPE_VECTOR_SIZE}u;
const WAVEFORM_OFFSET: u32 = ${WAVEFORM_OFFSET}u;
const VECTOR_OFFSET: u32 = ${VECTOR_OFFSET}u;
const SAMPLE_COUNT_OFFSET: u32 = ${SAMPLE_COUNT_OFFSET}u;
const INPUT_ALPHA_MASK: u32 = ${INPUT_ALPHA_MASK}u;
const INPUT_LEGACY_LUMA_TIE_DOWN_FLAG: u32 = ${INPUT_LEGACY_LUMA_TIE_DOWN_FLAG}u;
const WAVEFORM_THRESHOLDS = array<u32, 63>(${WAVEFORM_THRESHOLDS});
const CB_THRESHOLDS = array<u32, 63>(${CB_THRESHOLDS});
const CR_THRESHOLDS = array<u32, 63>(${CR_THRESHOLDS});

fn round_div(numerator: u32, divisor: u32) -> u32 {
  return (numerator + divisor / 2u) / divisor;
}

fn displayed_channel(channel: u32, alpha: u32) -> u32 {
  return round_div(channel * alpha, 255u);
}

fn waveform_level(numerator: u32) -> u32 {
  var result = 0u;
  for (var level = 1u; level < 64u; level++) {
    if (numerator >= WAVEFORM_THRESHOLDS[level - 1u]) {
      result = level;
    }
  }
  return result;
}

fn cb_bin(numerator: u32) -> u32 {
  var result = 0u;
  for (var level = 1u; level < 64u; level++) {
    if (numerator >= CB_THRESHOLDS[level - 1u]) {
      result = level;
    }
  }
  return result;
}

fn cr_bin(numerator: u32) -> u32 {
  var result = 0u;
  for (var level = 1u; level < 64u; level++) {
    if (numerator >= CR_THRESHOLDS[level - 1u]) {
      result = level;
    }
  }
  return result;
}

fn chroma_numerator(delta: i32, divisor: u32) -> u32 {
  if (delta >= 0) {
    return min(divisor * 2u, divisor + u32(delta) * 2u);
  }
  let magnitude = u32(-delta) * 2u;
  if (magnitude >= divisor) {
    return 0u;
  }
  return divisor - magnitude;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let pixel = id.x;
  if (pixel >= params.pixelCount) {
    return;
  }

  let offset = pixel * 4u;
  let packed_alpha = rgba[offset + 3u];
  let alpha = packed_alpha & INPUT_ALPHA_MASK;
  if (alpha == 0u) {
    return;
  }

  let source_red = rgba[offset];
  let source_green = rgba[offset + 1u];
  let source_blue = rgba[offset + 2u];
  let red = displayed_channel(source_red, alpha);
  let green = displayed_channel(source_green, alpha);
  let blue = displayed_channel(source_blue, alpha);
  let weighted_luma = source_red * 2126u + source_green * 7152u + source_blue * 722u;
  let luma_numerator = alpha * weighted_luma;
  var luma = round_div(luma_numerator, 2550000u);
  if ((packed_alpha & INPUT_LEGACY_LUMA_TIE_DOWN_FLAG) != 0u) {
    luma -= 1u;
  }

  atomicAdd(&output[red], 1u);
  atomicAdd(&output[HISTOGRAM_BINS + green], 1u);
  atomicAdd(&output[HISTOGRAM_BINS * 2u + blue], 1u);
  atomicAdd(&output[HISTOGRAM_BINS * 3u + luma], 1u);

  let source_x = pixel % params.width;
  let waveform_y = WAVEFORM_HEIGHT - 1u - waveform_level(luma_numerator);
  atomicAdd(&output[WAVEFORM_OFFSET + waveform_y * params.width + source_x], 1u);

  let cb_delta = i32(alpha) * (i32(source_blue * 10000u) - i32(weighted_luma));
  let cr_delta = i32(alpha) * (i32(source_red * 10000u) - i32(weighted_luma));
  let vector_x = cb_bin(chroma_numerator(cb_delta, 1206603900u));
  let vector_y = VECTOR_SIZE - 1u - cr_bin(chroma_numerator(cr_delta, 1024013700u));
  atomicAdd(&output[VECTOR_OFFSET + vector_y * VECTOR_SIZE + vector_x], 1u);
  atomicAdd(&output[SAMPLE_COUNT_OFFSET], 1u);
}
`

function safeAdapterInfo(info: GPUAdapterInfo): VideoScopeAdapterInfo {
  return {
    vendor: info.vendor || 'unavailable',
    architecture: info.architecture || 'unavailable',
    device: info.device || 'unavailable',
    description: info.description || 'unavailable',
  }
}

function copyU16(source: Uint32Array, start: number, length: number): Uint16Array {
  return Uint16Array.from(source.subarray(start, start + length))
}

function decodeGpuOutput(
  values: Uint32Array,
  width: number,
  height: number,
): VideoScopeAnalysis {
  return {
    sourceWidth: width,
    sourceHeight: height,
    sampleCount: values[SAMPLE_COUNT_OFFSET],
    histogram: {
      red: copyU16(values, 0, VIDEO_SCOPE_HISTOGRAM_BINS),
      green: copyU16(values, VIDEO_SCOPE_HISTOGRAM_BINS, VIDEO_SCOPE_HISTOGRAM_BINS),
      blue: copyU16(values, VIDEO_SCOPE_HISTOGRAM_BINS * 2, VIDEO_SCOPE_HISTOGRAM_BINS),
      luma: copyU16(values, VIDEO_SCOPE_HISTOGRAM_BINS * 3, VIDEO_SCOPE_HISTOGRAM_BINS),
    },
    waveform: {
      width,
      height: VIDEO_SCOPE_WAVEFORM_HEIGHT,
      density: copyU16(values, WAVEFORM_OFFSET, WAVEFORM_U32_COUNT),
    },
    vectorscope: {
      width: VIDEO_SCOPE_VECTOR_SIZE,
      height: VIDEO_SCOPE_VECTOR_SIZE,
      density: copyU16(values, VECTOR_OFFSET, VECTOR_U32_COUNT),
    },
  }
}

function assertExperimentShape(rgba: Uint8ClampedArray, width: number, height: number): void {
  if (width !== VIDEO_SCOPE_SAMPLE_WIDTH || height !== VIDEO_SCOPE_SAMPLE_HEIGHT) {
    throw new RangeError(
      `WebGPU scope experiment requires ${VIDEO_SCOPE_SAMPLE_WIDTH} x ${VIDEO_SCOPE_SAMPLE_HEIGHT}`,
    )
  }
  if (rgba.length !== width * height * 4) {
    throw new RangeError('Scope RGBA input does not match its dimensions')
  }
}

export function expandVideoScopeWebGpuInput(rgba: Uint8ClampedArray): Uint32Array {
  const expanded = Uint32Array.from(rgba)
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (videoScopeLegacyLumaTieRoundsDown(
      rgba[offset],
      rgba[offset + 1],
      rgba[offset + 2],
      rgba[offset + 3],
    )) {
      expanded[offset + 3] |= INPUT_LEGACY_LUMA_TIE_DOWN_FLAG
    }
  }
  return expanded
}

async function createBrowserWebGpuSession(): Promise<VideoScopeWebGpuSessionRequest> {
  if (!('gpu' in navigator)) {
    return {
      status: 'unavailable',
      reason: 'api-unavailable',
      detail: 'navigator.gpu is unavailable',
    }
  }

  let adapter: GPUAdapter | null
  try {
    adapter = await navigator.gpu.requestAdapter()
  } catch (error) {
    return {
      status: 'unavailable',
      reason: 'initialization-failed',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
  if (!adapter) {
    return {
      status: 'unavailable',
      reason: 'adapter-unavailable',
      detail: 'navigator.gpu.requestAdapter() returned null',
    }
  }

  let device: GPUDevice
  try {
    device = await adapter.requestDevice()
  } catch (error) {
    return {
      status: 'unavailable',
      reason: 'initialization-failed',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }

  let pipeline: GPUComputePipeline
  let errorScopeOpen = false
  try {
    device.pushErrorScope('validation')
    errorScopeOpen = true
    const module = device.createShaderModule({
      label: 'Myrelith video scopes compute experiment',
      code: VIDEO_SCOPE_COMPUTE_SHADER,
    })
    pipeline = await device.createComputePipelineAsync({
      label: 'Myrelith video scopes compute pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    })
    const validationError = await device.popErrorScope()
    errorScopeOpen = false
    if (validationError) throw validationError
  } catch (error) {
    if (errorScopeOpen) {
      try {
        await device.popErrorScope()
      } catch {
        // The original initialization error remains authoritative.
      }
    }
    device.destroy()
    return {
      status: 'unavailable',
      reason: 'initialization-failed',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }

  const adapterInfo = safeAdapterInfo(adapter.info)
  let activeBufferBytes = 0
  let peakBufferBytes = 0
  let released = false
  let lifecycle = 0
  const lost = device.lost.then((info) => `${info.reason}: ${info.message || 'device lost'}`)

  const snapshot = (): VideoScopeWebGpuSessionSnapshot => ({
    adapterInfo,
    activeBufferBytes,
    peakBufferBytes,
    released,
  })

  const release = (): void => {
    if (released) return
    released = true
    lifecycle++
    activeBufferBytes = 0
    device.destroy()
  }

  const analyze = async (
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<VideoScopeAnalysis> => {
    assertExperimentShape(rgba, width, height)
    if (released) throw new DOMException('WebGPU scope session was released', 'AbortError')
    const requestLifecycle = lifecycle
    const expanded = expandVideoScopeWebGpuInput(rgba)
    const parameters = new Uint32Array([width, height, width * height, 0])
    const ownedBuffers: GPUBuffer[] = []
    let readback: GPUBuffer | null = null

    try {
      const input = device.createBuffer({
        label: 'Myrelith scope RGBA input',
        size: expanded.byteLength,
        usage: GPU_BUFFER_USAGE.storage | GPU_BUFFER_USAGE.copyDst,
      })
      const output = device.createBuffer({
        label: 'Myrelith scope atomic output',
        size: OUTPUT_U32_COUNT * Uint32Array.BYTES_PER_ELEMENT,
        usage: GPU_BUFFER_USAGE.storage | GPU_BUFFER_USAGE.copySrc,
      })
      const parameterBuffer = device.createBuffer({
        label: 'Myrelith scope parameters',
        size: PARAMETER_BYTES,
        usage: GPU_BUFFER_USAGE.uniform | GPU_BUFFER_USAGE.copyDst,
      })
      readback = device.createBuffer({
        label: 'Myrelith scope readback',
        size: OUTPUT_U32_COUNT * Uint32Array.BYTES_PER_ELEMENT,
        usage: GPU_BUFFER_USAGE.copyDst | GPU_BUFFER_USAGE.mapRead,
      })
      ownedBuffers.push(input, output, parameterBuffer, readback)
      activeBufferBytes = VIDEO_SCOPE_WEBGPU_ACTIVE_BUFFER_BYTES
      peakBufferBytes = Math.max(peakBufferBytes, activeBufferBytes)

      device.queue.writeBuffer(input, 0, expanded)
      device.queue.writeBuffer(parameterBuffer, 0, parameters)
      const bindGroup = device.createBindGroup({
        label: 'Myrelith scope compute bindings',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: { buffer: parameterBuffer } },
        ],
      })
      const encoder = device.createCommandEncoder({ label: 'Myrelith scope compute commands' })
      const pass = encoder.beginComputePass({ label: 'Myrelith scope compute pass' })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(width * height / 64))
      pass.end()
      encoder.copyBufferToBuffer(
        output,
        0,
        readback,
        0,
        OUTPUT_U32_COUNT * Uint32Array.BYTES_PER_ELEMENT,
      )
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPU_MAP_READ)
      if (released || lifecycle !== requestLifecycle) {
        throw new DOMException('WebGPU scope session was released', 'AbortError')
      }
      const values = new Uint32Array(readback.getMappedRange()).slice()
      readback.unmap()
      return decodeGpuOutput(values, width, height)
    } finally {
      if (readback?.mapState === 'mapped') readback.unmap()
      for (const buffer of ownedBuffers) buffer.destroy()
      activeBufferBytes = 0
    }
  }

  return {
    status: 'ready',
    session: {
      lost,
      analyze,
      snapshot,
      loseForExperiment: () => {
        if (!released) device.destroy()
        return lost
      },
      release,
    },
  }
}

function createSelfTestFixture(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(
    VIDEO_SCOPE_SAMPLE_WIDTH * VIDEO_SCOPE_SAMPLE_HEIGHT * 4,
  )
  for (let pixel = 0; pixel < rgba.length / 4; pixel++) {
    const offset = pixel * 4
    rgba[offset] = pixel * 17 % 256
    rgba[offset + 1] = (pixel * 67 + 31) % 256
    rgba[offset + 2] = (pixel * 131 + 7) % 256
    rgba[offset + 3] = pixel % 19 === 0 ? 0 : (pixel * 29 + 13) % 256
  }
  rgba.set([
    13, 163, 113, 241,
    0, 13, 142, 150,
    0, 35, 190, 102,
  ])
  return rgba
}

function equalArrays(left: Uint16Array, right: Uint16Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function videoScopeAnalysesEqual(
  left: VideoScopeAnalysis,
  right: VideoScopeAnalysis,
): boolean {
  return left.sourceWidth === right.sourceWidth
    && left.sourceHeight === right.sourceHeight
    && left.sampleCount === right.sampleCount
    && equalArrays(left.histogram.red, right.histogram.red)
    && equalArrays(left.histogram.green, right.histogram.green)
    && equalArrays(left.histogram.blue, right.histogram.blue)
    && equalArrays(left.histogram.luma, right.histogram.luma)
    && left.waveform.width === right.waveform.width
    && left.waveform.height === right.waveform.height
    && equalArrays(left.waveform.density, right.waveform.density)
    && left.vectorscope.width === right.vectorscope.width
    && left.vectorscope.height === right.vectorscope.height
    && equalArrays(left.vectorscope.density, right.vectorscope.density)
}

export function createOptionalVideoScopeAnalyzer(
  options: OptionalVideoScopeAnalyzerOptions = {},
): OptionalVideoScopeAnalyzer {
  const preferWebGpu = options.preferWebGpu ?? false
  const now = options.now ?? (() => performance.now())
  const requestSession = options.requestSession ?? createBrowserWebGpuSession
  const cpuAnalyze = options.cpuAnalyze ?? analyzeVideoScopes
  let state: OptionalVideoScopeAnalyzerSnapshot['state'] = 'idle'
  let fallbackReason: VideoScopeWebGpuFallbackReason | null = preferWebGpu
    ? null
    : 'not-requested'
  let fallbackDetail: string | null = null
  let startupMs: number | null = null
  let session: VideoScopeWebGpuSession | null = null
  let initialization: Promise<VideoScopeWebGpuSession | null> | null = null
  let lifecycle = 0
  const isReleased = (): boolean => state === 'released'

  const fallBack = (
    reason: VideoScopeWebGpuFallbackReason,
    detail: string,
    ownedSession: VideoScopeWebGpuSession | null = session,
  ): void => {
    ownedSession?.release()
    if (ownedSession === session) session = null
    state = 'fallback'
    fallbackReason = reason
    fallbackDetail = detail
  }

  const ensureSession = async (): Promise<VideoScopeWebGpuSession | null> => {
    if (!preferWebGpu || state === 'fallback' || state === 'released') return null
    if (session) return session
    if (initialization) return initialization
    const initializationLifecycle = lifecycle
    const startedAt = now()
    state = 'initializing'
    initialization = (async () => {
      const requested = await requestSession()
      if (isReleased() || lifecycle !== initializationLifecycle) {
        if (requested.status === 'ready') requested.session.release()
        return null
      }
      if (requested.status === 'unavailable') {
        startupMs = now() - startedAt
        fallBack(requested.reason, requested.detail, null)
        return null
      }

      const candidate = requested.session
      try {
        const fixture = createSelfTestFixture()
        const expected = cpuAnalyze(
          fixture,
          VIDEO_SCOPE_SAMPLE_WIDTH,
          VIDEO_SCOPE_SAMPLE_HEIGHT,
        )
        const actual = await candidate.analyze(
          fixture,
          VIDEO_SCOPE_SAMPLE_WIDTH,
          VIDEO_SCOPE_SAMPLE_HEIGHT,
        )
        if (!videoScopeAnalysesEqual(actual, expected)) {
          startupMs = now() - startedAt
          fallBack('self-test-mismatch', 'WebGPU output differed from the CPU oracle', candidate)
          return null
        }
      } catch (error) {
        startupMs = now() - startedAt
        fallBack(
          'initialization-failed',
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          candidate,
        )
        return null
      }

      if (isReleased() || lifecycle !== initializationLifecycle) {
        candidate.release()
        return null
      }
      session = candidate
      state = 'ready'
      startupMs = now() - startedAt
      fallbackReason = null
      fallbackDetail = null
      void candidate.lost.then((detail) => {
        if (session !== candidate || isReleased()) return
        fallBack('device-lost', detail, candidate)
      })
      return candidate
    })().finally(() => {
      initialization = null
    })
    return initialization
  }

  const cpuResult = (
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    reason: VideoScopeWebGpuFallbackReason,
  ): OptionalVideoScopeAnalysisResult => {
    const startedAt = now()
    const analysis = cpuAnalyze(rgba, width, height)
    return {
      analysis,
      backend: 'cpu',
      fallbackReason: reason,
      elapsedMs: now() - startedAt,
    }
  }

  return {
    analyze: async (rgba, width, height) => {
      if (isReleased()) {
        throw new DOMException('Optional video scope analyzer was released', 'AbortError')
      }
      if (!preferWebGpu) return cpuResult(rgba, width, height, 'not-requested')
      if (width !== VIDEO_SCOPE_SAMPLE_WIDTH || height !== VIDEO_SCOPE_SAMPLE_HEIGHT) {
        return cpuResult(rgba, width, height, 'unsupported-input-shape')
      }
      const analysisLifecycle = lifecycle
      const activeSession = await ensureSession()
      if (isReleased() || lifecycle !== analysisLifecycle) {
        throw new DOMException('Optional video scope analyzer was released', 'AbortError')
      }
      if (!activeSession) {
        return cpuResult(rgba, width, height, fallbackReason ?? 'initialization-failed')
      }
      const startedAt = now()
      try {
        const analysis = await activeSession.analyze(rgba, width, height)
        return {
          analysis,
          backend: 'webgpu',
          fallbackReason: null,
          elapsedMs: now() - startedAt,
        }
      } catch (error) {
        if (isReleased() || lifecycle !== analysisLifecycle) throw error
        const reason = session === activeSession ? 'execution-failed' : 'device-lost'
        fallBack(
          reason,
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          activeSession,
        )
        return cpuResult(rgba, width, height, reason)
      }
    },
    snapshot: () => {
      const sessionSnapshot = session?.snapshot()
      return {
        state,
        fallbackReason,
        fallbackDetail,
        startupMs,
        adapterInfo: sessionSnapshot?.adapterInfo ?? null,
        activeBufferBytes: sessionSnapshot?.activeBufferBytes ?? 0,
        peakBufferBytes: sessionSnapshot?.peakBufferBytes ?? 0,
      }
    },
    loseDeviceForExperiment: async () => {
      const activeSession = await ensureSession()
      if (!activeSession) return null
      return activeSession.loseForExperiment()
    },
    release: () => {
      if (isReleased()) return
      lifecycle++
      state = 'released'
      session?.release()
      session = null
    },
  }
}
