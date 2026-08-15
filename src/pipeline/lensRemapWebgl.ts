import {
  createValidatedLensCorrectionMap,
  isManualLensCorrectionModel,
  sameManualLensCorrectionModel,
  type ValidatedLensCorrectionMap,
  type ManualLensCorrectionModel,
} from '../domain/lensCorrection'
import type { TimelineDoc } from '../domain/schema'
import {
  lensRemapSurfaceBudget,
  RENDER_SURFACE_BYTES_PER_PIXEL,
} from '../domain/renderSurfaceBudget'
import {
  LensRemapUnavailableError,
  type LensRemapProvider,
} from './lensRemap'

const VERTEX_SHADER = `#version 300 es
precision highp float;
void main() {
  vec2 position = vec2(
    gl_VertexID == 1 ? 3.0 : -1.0,
    gl_VertexID == 2 ? 3.0 : -1.0
  );
  gl_Position = vec4(position, 0.0, 1.0);
}`

const MODEL_GLSL = `
uniform vec2 uCenter;
uniform vec2 uFocal;
uniform vec3 uRadial;
uniform vec2 uTangential;
uniform float uStrength;
uniform float uOutputScale;

vec2 mapLensPoint(vec2 outputPoint) {
  vec2 unscaled = uCenter + (outputPoint - uCenter) / uOutputScale;
  vec2 camera = (unscaled - uCenter) / uFocal;
  float radius2 = dot(camera, camera);
  float radius4 = radius2 * radius2;
  float radius6 = radius4 * radius2;
  float radial = 1.0 + uRadial.x * radius2 + uRadial.y * radius4 + uRadial.z * radius6;
  float xy = camera.x * camera.y;
  vec2 distorted = vec2(
    camera.x * radial + 2.0 * uTangential.x * xy + uTangential.y * (radius2 + 2.0 * camera.x * camera.x),
    camera.y * radial + uTangential.x * (radius2 + 2.0 * camera.y * camera.y) + 2.0 * uTangential.y * xy
  );
  vec2 blended = camera + (distorted - camera) * uStrength;
  return uCenter + blended * uFocal;
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSource;
uniform ivec2 uSize;
${MODEL_GLSL}
out vec4 outputColor;

vec4 transparentFetch(ivec2 topPoint) {
  if (topPoint.x < 0 || topPoint.y < 0 || topPoint.x >= uSize.x || topPoint.y >= uSize.y) {
    return vec4(0.0);
  }
  return texelFetch(uSource, topPoint, 0);
}

void main() {
  vec2 topOutput = vec2(gl_FragCoord.x, float(uSize.y) - gl_FragCoord.y);
  vec2 normalizedOutput = topOutput / vec2(uSize);
  vec2 source = mapLensPoint(normalizedOutput) * vec2(uSize) - vec2(0.5);
  ivec2 origin = ivec2(floor(source));
  vec2 fraction = fract(source);
  vec4 top = mix(transparentFetch(origin), transparentFetch(origin + ivec2(1, 0)), fraction.x);
  vec4 bottom = mix(transparentFetch(origin + ivec2(0, 1)), transparentFetch(origin + ivec2(1, 1)), fraction.x);
  outputColor = mix(top, bottom, fraction.y);
}`

const GEOMETRY_VERTEX_SHADER = `#version 300 es
precision highp float;
${MODEL_GLSL}
in vec2 aOutputPoint;
out vec2 vMappedPoint;
void main() {
  vMappedPoint = mapLensPoint(aOutputPoint);
  gl_Position = vec4(0.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('WebGL2 could not allocate a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) ?? 'unknown shader error'
    gl.deleteShader(shader)
    throw new Error(`Lens-remap shader compilation failed: ${detail}`)
  }
  return shader
}

function link(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  transformFeedbackVarying?: string,
): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new Error('WebGL2 could not allocate a program')
  }
  try {
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    if (transformFeedbackVarying) {
      gl.transformFeedbackVaryings(program, [transformFeedbackVarying], gl.INTERLEAVED_ATTRIBS)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Lens-remap program link failed: ${gl.getProgramInfoLog(program) ?? 'unknown link error'}`)
    }
    return program
  } catch (error) {
    gl.deleteProgram(program)
    throw error
  } finally {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
  }
}

function uniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name)
  if (location === null) throw new Error(`Lens-remap uniform ${name} is unavailable`)
  return location
}

function applyModel(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  model: Readonly<ManualLensCorrectionModel>,
): void {
  gl.uniform2f(uniform(gl, program, 'uCenter'), model.centerX, model.centerY)
  gl.uniform2f(uniform(gl, program, 'uFocal'), model.focalX, model.focalY)
  gl.uniform3f(uniform(gl, program, 'uRadial'), model.k1, model.k2, model.k3)
  gl.uniform2f(uniform(gl, program, 'uTangential'), model.p1, model.p2)
  gl.uniform1f(uniform(gl, program, 'uStrength'), model.strength)
  gl.uniform1f(uniform(gl, program, 'uOutputScale'), model.outputScale)
}

function flipReadbackInPlace(
  rows: Uint8Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const pixels = new Uint32Array(rows.buffer, rows.byteOffset, rows.byteLength / 4)
  for (let y = 0; y < Math.floor(height / 2); y++) {
    const oppositeY = height - 1 - y
    for (let x = 0; x < width; x++) {
      const top = y * width + x
      const bottom = oppositeY * width + x
      const swap = pixels[top]!
      pixels[top] = pixels[bottom]!
      pixels[bottom] = swap
    }
  }
  return new Uint8ClampedArray(rows.buffer, rows.byteOffset, rows.byteLength)
}

export class WebGl2LensRemapBackend {
  readonly maximumTextureSize: number
  readonly contextLossExtension: WEBGL_lose_context | null
  private readonly canvas: OffscreenCanvas
  private readonly gl: WebGL2RenderingContext
  private readonly renderProgram: WebGLProgram
  private readonly geometryProgram: WebGLProgram
  private readonly texture: WebGLTexture
  private readonly vertexArray: WebGLVertexArrayObject
  private disposed = false
  private width = 0
  private height = 0

  constructor() {
    if (typeof OffscreenCanvas !== 'function') throw new Error('OffscreenCanvas is unavailable')
    this.canvas = new OffscreenCanvas(1, 1)
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      desynchronized: false,
      failIfMajorPerformanceCaveat: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      stencil: false,
    })
    if (!gl) throw new Error('WebGL2 is unavailable or a major performance caveat')
    this.gl = gl
    const channelBits = [gl.RED_BITS, gl.GREEN_BITS, gl.BLUE_BITS, gl.ALPHA_BITS]
      .map((parameter) => gl.getParameter(parameter) as number)
    if (channelBits.some((bits) => bits !== 8)) {
      throw new Error(`WebGL2 default framebuffer is not RGBA8 (${channelBits.join('/')})`)
    }
    if (
      gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) !== gl.RGBA
      || gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) !== gl.UNSIGNED_BYTE
    ) throw new Error('WebGL2 does not expose required RGBA8/UNSIGNED_BYTE readback')
    this.maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    this.contextLossExtension = gl.getExtension('WEBGL_lose_context')
    let renderProgram: WebGLProgram | null = null
    let geometryProgram: WebGLProgram | null = null
    let texture: WebGLTexture | null = null
    let vertexArray: WebGLVertexArrayObject | null = null
    try {
      renderProgram = link(gl, VERTEX_SHADER, FRAGMENT_SHADER)
      geometryProgram = link(
        gl,
        GEOMETRY_VERTEX_SHADER,
        `#version 300 es\nprecision highp float;\nout vec4 outputColor;\nvoid main(){ outputColor=vec4(0.0); }`,
        'vMappedPoint',
      )
      texture = gl.createTexture()
      vertexArray = gl.createVertexArray()
      if (!texture || !vertexArray) {
        throw new Error('WebGL2 could not allocate lens-remap resources')
      }
    } catch (error) {
      if (texture) gl.deleteTexture(texture)
      if (vertexArray) gl.deleteVertexArray(vertexArray)
      if (renderProgram) gl.deleteProgram(renderProgram)
      if (geometryProgram) gl.deleteProgram(geometryProgram)
      this.canvas.width = 1
      this.canvas.height = 1
      throw error
    }
    this.renderProgram = renderProgram
    this.geometryProgram = geometryProgram
    this.texture = texture
    this.vertexArray = vertexArray
    gl.bindVertexArray(vertexArray)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.DITHER)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.STENCIL_TEST)
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Lens-remap backend is disposed')
    if (this.gl.isContextLost()) {
      throw new LensRemapUnavailableError(
        'Lens-remap WebGL2 context was lost; retry requires a fresh render owner.',
        true,
      )
    }
  }

  private renderPrepared(
    input: Uint8Array | Uint8ClampedArray | CanvasImageSource,
    width: number,
    height: number,
    modelMap: ValidatedLensCorrectionMap,
    readback: boolean,
  ): Uint8ClampedArray | null {
    this.assertUsable()
    const byteInput = input instanceof Uint8Array || input instanceof Uint8ClampedArray
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0
      || width > this.maximumTextureSize
      || height > this.maximumTextureSize
      || (
        byteInput
        && input.byteLength !== width * height * RENDER_SURFACE_BYTES_PER_PIXEL
      )
    ) throw new RangeError('Lens-remap frame is outside the WebGL2 texture envelope')
    if (
      byteInput
      && (input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength)
    ) {
      throw new RangeError('Lens-remap WebGL2 input must own its complete backing buffer')
    }
    const gl = this.gl
    this.canvas.width = width
    this.canvas.height = height
    this.width = width
    this.height = height
    gl.viewport(0, 0, width, height)
    gl.bindVertexArray(this.vertexArray)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    if (byteInput) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        input,
      )
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        input as TexImageSource,
      )
    }
    gl.useProgram(this.renderProgram)
    applyModel(gl, this.renderProgram, modelMap.model)
    gl.uniform1i(uniform(gl, this.renderProgram, 'uSource'), 0)
    gl.uniform2i(uniform(gl, this.renderProgram, 'uSize'), width, height)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.finish()
    const error = gl.getError()
    if (gl.isContextLost() || error === gl.CONTEXT_LOST_WEBGL) {
      throw new LensRemapUnavailableError(
        'Lens-remap WebGL2 context was lost; retry requires a fresh render owner.',
        true,
      )
    }
    if (error !== gl.NO_ERROR) {
      throw new LensRemapUnavailableError(
        `Lens-remap WebGL2 render failed with error ${error}.`,
        true,
      )
    }
    return readback ? this.readCurrent() : null
  }

  render(
    input: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    model: ManualLensCorrectionModel,
    readback: boolean,
  ): Uint8ClampedArray | null {
    const modelMap = createValidatedLensCorrectionMap(model)
    return this.renderPrepared(input, width, height, modelMap, readback)
  }

  renderSource(
    input: CanvasImageSource,
    width: number,
    height: number,
    modelMap: ValidatedLensCorrectionMap,
  ): OffscreenCanvas {
    this.renderPrepared(input, width, height, modelMap, false)
    return this.canvas
  }

  readCurrent(): Uint8ClampedArray {
    this.assertUsable()
    if (this.width <= 0 || this.height <= 0) throw new Error('Lens-remap backend has no rendered frame')
    const rows = new Uint8Array(this.width * this.height * RENDER_SURFACE_BYTES_PER_PIXEL)
    this.gl.readPixels(0, 0, this.width, this.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, rows)
    const error = this.gl.getError()
    if (error !== this.gl.NO_ERROR) throw new Error(`Lens-remap RGBA8 readback failed with error ${error}`)
    return flipReadbackInPlace(rows, this.width, this.height)
  }

  maximumGeometryDeltaPixels(
    model: ManualLensCorrectionModel,
    width: number,
    height: number,
  ): number {
    this.assertUsable()
    const mapper = createValidatedLensCorrectionMap(model)
    const points = new Float32Array(33 * 33 * 2)
    let offset = 0
    for (let row = 0; row < 33; row++) {
      for (let column = 0; column < 33; column++) {
        points[offset++] = column / 32
        points[offset++] = row / 32
      }
    }
    const gl = this.gl
    const inputBuffer = gl.createBuffer()
    const outputBuffer = gl.createBuffer()
    const transformFeedback = gl.createTransformFeedback()
    const vao = gl.createVertexArray()
    if (!inputBuffer || !outputBuffer || !transformFeedback || !vao) {
      if (inputBuffer) gl.deleteBuffer(inputBuffer)
      if (outputBuffer) gl.deleteBuffer(outputBuffer)
      if (transformFeedback) gl.deleteTransformFeedback(transformFeedback)
      if (vao) gl.deleteVertexArray(vao)
      throw new Error('WebGL2 could not allocate geometry-audit resources')
    }
    try {
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, inputBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW)
      const location = gl.getAttribLocation(this.geometryProgram, 'aOutputPoint')
      if (location < 0) throw new Error('Lens-remap geometry input is unavailable')
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, outputBuffer)
      gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, points.byteLength, gl.STREAM_READ)
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, transformFeedback)
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, outputBuffer)
      gl.useProgram(this.geometryProgram)
      applyModel(gl, this.geometryProgram, mapper.model)
      gl.enable(gl.RASTERIZER_DISCARD)
      gl.beginTransformFeedback(gl.POINTS)
      gl.drawArrays(gl.POINTS, 0, points.length / 2)
      gl.endTransformFeedback()
      gl.disable(gl.RASTERIZER_DISCARD)
      gl.finish()
      const actual = new Float32Array(points.length)
      gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, actual)
      const error = gl.getError()
      if (error !== gl.NO_ERROR) {
        throw new Error(`Lens-remap geometry audit failed with error ${error}`)
      }
      let maximum = 0
      for (let index = 0; index < points.length; index += 2) {
        const expected = mapper.map({ x: points[index]!, y: points[index + 1]! })
        maximum = Math.max(maximum, Math.hypot(
          (actual[index]! - expected.x) * width,
          (actual[index + 1]! - expected.y) * height,
        ))
      }
      return maximum
    } finally {
      gl.disable(gl.RASTERIZER_DISCARD)
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      gl.deleteTransformFeedback(transformFeedback)
      gl.deleteBuffer(inputBuffer)
      gl.deleteBuffer(outputBuffer)
      gl.deleteVertexArray(vao)
      gl.bindVertexArray(this.vertexArray)
    }
  }

  retainedBytes(): number {
    return this.disposed ? 0 : this.width * this.height * RENDER_SURFACE_BYTES_PER_PIXEL * 2
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    if (!gl.isContextLost()) {
      gl.deleteTexture(this.texture)
      gl.deleteProgram(this.renderProgram)
      gl.deleteProgram(this.geometryProgram)
      gl.deleteVertexArray(this.vertexArray)
    }
    this.canvas.width = 1
    this.canvas.height = 1
    this.width = 0
    this.height = 0
  }
}

function sourceDimensions(source: CanvasImageSource): {
  readonly width: number
  readonly height: number
} {
  const value = source as unknown as {
    readonly displayWidth?: number
    readonly displayHeight?: number
    readonly width?: number
    readonly height?: number
    readonly videoWidth?: number
    readonly videoHeight?: number
    readonly naturalWidth?: number
    readonly naturalHeight?: number
  }
  const width = value.displayWidth
    ?? value.videoWidth
    ?? value.naturalWidth
    ?? value.width
  const height = value.displayHeight
    ?? value.videoHeight
    ?? value.naturalHeight
    ?? value.height
  if (
    typeof width !== 'number'
    || typeof height !== 'number'
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
  ) {
    throw new LensRemapUnavailableError(
      'Lens-remap source dimensions are unavailable.',
    )
  }
  return { width, height }
}

type PreparedModel =
  | { readonly status: 'supported'; readonly map: ValidatedLensCorrectionMap }
  | { readonly status: 'unsupported'; readonly version: number }

/** True when a document contains any authored lens intent, supported or not. */
export function documentHasLensCorrection(doc: TimelineDoc): boolean {
  return doc.tracks.some((track) =>
    track.clips.some((clip) => (clip.lensCorrection ?? null) !== null),
  )
}

/** True when the document needs the current v1 WebGL2 backend. */
export function documentHasSupportedLensCorrection(doc: TimelineDoc): boolean {
  return doc.tracks.some((track) =>
    track.clips.some((clip) => isManualLensCorrectionModel(clip.lensCorrection)),
  )
}

export function documentHasUnsupportedLensCorrection(doc: TimelineDoc): boolean {
  return doc.tracks.some((track) =>
    track.clips.some((clip) => {
      const intent = clip.lensCorrection ?? null
      return intent !== null && !isManualLensCorrectionModel(intent)
    }),
  )
}

/**
 * Validate every authored model once for one immutable document snapshot.
 * The provider then performs only bounded model lookup and GPU work per frame.
 */
export function createDocumentLensRemapProvider(
  doc: TimelineDoc,
  backend: WebGl2LensRemapBackend | null,
  outputWidth: number,
  outputHeight: number,
  includeExportReadback: boolean,
): LensRemapProvider | null {
  let activeOutputWidth = outputWidth
  let activeOutputHeight = outputHeight
  let activeIncludeExportReadback = includeExportReadback
  const prepared = new Map<string, PreparedModel>()
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const intent = clip.lensCorrection ?? null
      if (intent === null) continue
      if (isManualLensCorrectionModel(intent)) {
        prepared.set(clip.id, {
          status: 'supported',
          map: createValidatedLensCorrectionMap(intent),
        })
      } else {
        prepared.set(clip.id, { status: 'unsupported', version: intent.version })
      }
    }
  }
  if (prepared.size === 0) return null

  return {
    remap: (clip, source) => {
      const current = clip.lensCorrection ?? null
      if (current === null) return source
      const model = prepared.get(clip.id)
      if (!model) {
        throw new LensRemapUnavailableError(
          'Lens-remap plan does not match the prepared document snapshot.',
        )
      }
      if (model.status === 'unsupported' || !isManualLensCorrectionModel(current)) {
        throw new LensRemapUnavailableError(
          `Manual lens-correction version ${model.status === 'unsupported' ? model.version : current.version} is preserved but unsupported.`,
        )
      }
      if (!sameManualLensCorrectionModel(model.map.model, current)) {
        throw new LensRemapUnavailableError(
          'Lens-remap plan changed after the document snapshot was prepared.',
        )
      }
      if (!backend) {
        throw new LensRemapUnavailableError('WebGL2 lens remapping is unavailable.')
      }
      const { width, height } = sourceDimensions(source)
      if (width > backend.maximumTextureSize || height > backend.maximumTextureSize) {
        throw new LensRemapUnavailableError(
          `Lens-remap source ${width}×${height} exceeds this renderer's ${backend.maximumTextureSize}-pixel texture limit.`,
        )
      }
      const budget = lensRemapSurfaceBudget(
        activeOutputWidth,
        activeOutputHeight,
        width,
        height,
        activeIncludeExportReadback,
      )
      if (!budget.allowed) {
        throw new LensRemapUnavailableError(
          budget.reason ?? 'Lens remap exceeds the render surface budget.',
        )
      }
      return backend.renderSource(source, width, height, model.map)
    },
    setOutputSurface: (width, height, readback) => {
      activeOutputWidth = width
      activeOutputHeight = height
      activeIncludeExportReadback = readback
    },
  }
}
