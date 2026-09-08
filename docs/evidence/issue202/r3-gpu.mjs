// Disposable Float32 shader candidate; expected values/oracle are not imported.
import {convert} from './candidate.mjs';
import {imagePlan} from './r3-ledger.mjs';

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const COMPOSITE = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D sourceA;
uniform highp sampler2D sourceB;
uniform int frameIndex;
out vec4 pixel;
void main() {
  ivec2 point = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(sourceA, point, 0);
  vec4 b = texelFetch(sourceB, point, 0);
  float weight = float(frameIndex) / 119.0;
  pixel = a * (1.0 - weight) + b * weight;
}`;
const VIEW = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D workingImage;
uniform mat3 to709;
out vec4 pixel;
float encodeSrgb(float value) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}
void main() {
  vec3 rgb = texelFetch(workingImage, ivec2(gl_FragCoord.xy), 0).rgb;
  float y = dot(rgb, vec3(0.2627, 0.6780, 0.0593));
  if (y <= 0.0) { pixel = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float mapped = y <= 0.75 ? y : 0.75 + 0.25 * (y - 0.75) / (y - 0.5);
  vec3 display = clamp(to709 * (rgb * (mapped / y)), 0.0, 1.0);
  pixel = vec4(encodeSrgb(display.r), encodeSrgb(display.g), encodeSrgb(display.b), 1.0);
}`;

export class GpuOwner {
  constructor(ledger, width, height, phase) {
    this.ledger = ledger;
    this.width = width;
    this.height = height;
    this.phase = phase;
    this.plan = imagePlan('candidate', width, height, phase);
    this.allocations = new Map();
    this.closed = false;
    this.lost = false;
  }
  allocate(id, bytes, kind, create, destroy) {
    this.ledger.reserve(id, bytes, kind);
    try {
      const value = create();
      if (!value) throw new Error(`Resource unavailable: ${id}`);
      this.allocations.set(id, {value, destroy});
      return value;
    } catch (error) { this.ledger.release(id); throw error; }
  }
  release(id) {
    const entry = this.allocations.get(id);
    if (!entry) return;
    entry.destroy(entry.value);
    entry.value = null;
    this.allocations.delete(id);
    this.ledger.release(id);
  }
  check() {
    if (this.closed || this.lost || this.gl?.isContextLost()) throw new Error('Managed prototype context unavailable');
  }
  checkError(label) {
    this.check();
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR) throw new Error(`${label}: WebGL error ${error}`);
  }
  makeProgram(id, fragment) {
    const gl = this.gl;
    const shader = (suffix, type, source) => {
      const value = this.allocate(`${id}.${suffix}`, 0, 'shader', () => gl.createShader(type), v => gl.deleteShader(v));
      gl.shaderSource(value, source); gl.compileShader(value);
      if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
      return value;
    };
    const vertex = shader('vertex', gl.VERTEX_SHADER, VERTEX);
    const pixel = shader('fragment', gl.FRAGMENT_SHADER, fragment);
    const program = this.allocate(id, 0, 'program', () => gl.createProgram(), v => gl.deleteProgram(v));
    gl.attachShader(program, vertex); gl.attachShader(program, pixel); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  }
  texture(id) {
    const gl = this.gl;
    const value = this.allocate(id, this.width * this.height * 8, 'rgba16f-texture', () => gl.createTexture(), v => gl.deleteTexture(v));
    gl.bindTexture(gl.TEXTURE_2D, value);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, this.width, this.height);
    this.checkError(id);
    return value;
  }
  attach(texture) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete RGBA16F framebuffer');
  }
  async init(fixture) {
    if (!this.plan.allowed) throw new Error('Prototype image plan rejected before allocation');
    const started = performance.now();
    const pixels = this.width * this.height;
    this.canvas = this.allocate('gpu.output', pixels * 4, 'rgba8-canvas',
      () => new OffscreenCanvas(this.width, this.height), canvas => { canvas.width = 0; canvas.height = 0; });
    const requested = {alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: true};
    this.gl = this.allocate('gpu.context', 0, 'context', () => this.canvas.getContext('webgl2', requested),
      gl => gl.getExtension('WEBGL_lose_context')?.loseContext());
    const gl = this.gl;
    this.canvas.addEventListener('webglcontextlost', () => { this.lost = true; });
    const attrs = gl.getContextAttributes();
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    this.support = {requested, returned: attrs, highFloat: precision ? {rangeMin: precision.rangeMin, rangeMax: precision.rangeMax, precision: precision.precision} : null,
      maximumTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE)};
    if (!attrs || attrs.depth || attrs.stencil || attrs.antialias || attrs.alpha || !attrs.preserveDrawingBuffer) throw new Error('Unreviewed framebuffer attributes');
    if (!precision || precision.precision < 23 || precision.rangeMax < 127) throw new Error('Float32 highp not qualified');
    if (!gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('WEBGL_lose_context')) throw new Error('Required float/context-loss capability unavailable');
    if (this.support.maximumTextureSize < Math.max(this.width, this.height)) throw new Error('Texture dimensions unsupported');
    gl.drawingBufferColorSpace = 'srgb';
    this.support.drawingBufferColorSpace = gl.drawingBufferColorSpace;
    if (gl.drawingBufferColorSpace !== 'srgb') throw new Error('SDR output color space not confirmed');
    gl.disable(gl.BLEND); gl.disable(gl.DITHER); gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.framebuffer = this.allocate('gpu.framebuffer', 0, 'framebuffer', () => gl.createFramebuffer(), v => gl.deleteFramebuffer(v));
    this.vao = this.allocate('gpu.vao', 0, 'vertex-array', () => gl.createVertexArray(), v => gl.deleteVertexArray(v));
    gl.bindVertexArray(this.vao);
    this.composite = this.makeProgram('gpu.composite', COMPOSITE);
    this.view = this.makeProgram('gpu.view', VIEW);
    this.a = this.texture('gpu.inputA'); this.b = this.texture('gpu.inputB'); this.working = this.texture('gpu.working');
    this.matrix = this.allocate('gpu.matrix', 36, 'uniform-buffer',
      () => new Float32Array([[1,0,0],[0,1,0],[0,0,1]].flatMap(axis => convert(axis, '2020', '709'))), () => {});
    const rows = Math.min(16, this.height);
    let tile = this.allocate('gpu.upload', this.width * rows * 16, 'float32-upload-tile',
      () => new Float32Array(this.width * rows * 4), () => {});
    for (const [texture, rawPalette] of [[this.a, fixture.associatedA], [this.b, fixture.associatedB]]) {
      const palette = rawPalette.map(pixel => pixel.map(Number));
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (let y = 0; y < this.height; y += rows) {
        const count = Math.min(rows, this.height - y);
        for (let localY = 0; localY < count; localY++) for (let x = 0; x < this.width; x++) {
          const logicalY = this.height - 1 - y - localY;
          const index = this.phase === 'qualification' ? x : (Math.floor(x / 64) + Math.floor(logicalY / 64)) % 8;
          tile.set(palette[index], (localY * this.width + x) * 4);
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, this.width, count, gl.RGBA, gl.FLOAT, tile);
      }
    }
    gl.finish(); this.checkError('upload');
    tile = null; this.release('gpu.upload');
    if (this.phase === 'qualification') {
      this.qualifyView = this.texture('gpu.qualificationView');
      this.readback = this.allocate('gpu.readback', pixels * 16, 'float32-readback', () => new Float32Array(pixels * 4), () => {});
    } else if (this.phase === 'export') {
      this.readback = this.allocate('gpu.readback', pixels * 4, 'rgba8-readback', () => new Uint8Array(pixels * 4), () => {});
    }
    this.setupMs = performance.now() - started;
  }
  drawWorking(frame) {
    this.check();
    if (!Number.isInteger(frame) || frame < 0 || frame > 119) throw new Error('Invalid frame index');
    const gl = this.gl;
    this.attach(this.working); gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.composite);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.a);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.b);
    gl.uniform1i(gl.getUniformLocation(this.composite, 'sourceA'), 0);
    gl.uniform1i(gl.getUniformLocation(this.composite, 'sourceB'), 1);
    gl.uniform1i(gl.getUniformLocation(this.composite, 'frameIndex'), frame);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  drawView(qualification = false) {
    const gl = this.gl;
    if (qualification) this.attach(this.qualifyView); else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.view);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.working);
    gl.uniform1i(gl.getUniformLocation(this.view, 'workingImage'), 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.view, 'to709'), false, this.matrix);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  async render(frame) {
    const start = performance.now(); this.drawWorking(frame);
    const submittedComposite = performance.now(); this.drawView();
    const submittedView = performance.now();
    if (this.phase === 'export') this.gl.readPixels(0, 0, this.width, this.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.readback);
    else this.gl.finish();
    this.checkError('frame');
    return {submitCompositeMs: submittedComposite - start, submitViewMs: submittedView - submittedComposite,
      completionAndReadbackMs: performance.now() - submittedView};
  }
  qualify(frame) {
    this.drawWorking(frame);
    const gl = this.gl;
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, this.readback);
    const working = Array.from({length: 8}, (_, i) => Array.from(this.readback.subarray(i * 4, i * 4 + 4)));
    this.drawView(true);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, this.readback);
    const view = Array.from({length: 8}, (_, i) => Array.from(this.readback.subarray(i * 4, i * 4 + 3)));
    this.checkError('qualification');
    return {working, view};
  }
  loseForTest() { this.gl.getExtension('WEBGL_lose_context').loseContext(); }
  dispose() {
    if (this.closed) return;
    const failures = [];
    for (const id of [...this.allocations.keys()].reverse()) {
      try { this.release(id); } catch (error) { failures.push(String(error)); }
    }
    this.matrix = this.readback = null;
    this.closed = true;
    if (failures.length) throw new Error(`Incomplete GPU cleanup: ${failures.join('; ')}`);
  }
}
