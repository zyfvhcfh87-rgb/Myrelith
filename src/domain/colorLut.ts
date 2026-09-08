/** Bounded local Cube profile and exact portable binary64 data. No browser APIs. */
import { clampColorUnit, colorByte, colorPixelRange, finiteColorNumber, type Rgb } from './colorChannels'

export const COLOR_LUT_TYPE = 'builtin.cube-lut'
export const COLOR_LUT_ENCODING = 'rgb-f64le-base64-v1'
export const COLOR_LUT_LIMITS = Object.freeze({
  fileBytes: 4 * 1024 * 1024, lineBytes: 250, tokenBytes: 32, lines: 100_000,
  oneDimensionalSize: 4096, threeDimensionalSize: 33, magnitude: 16, minimumDomainSpan: 0.000001,
  nameCharacters: 240, records: 16, decodedBytes: 4 * 1024 * 1024,
  catalogBytes: 6 * 1024 * 1024, retainedBytes: 64 * 1024 * 1024,
  runtimeBytes: 2 * 1024 * 1024, runtimeEntries: 256, pixelStageVisits: 134_217_728,
})
export interface ColorLutShape {
  readonly kind: '1d' | '3d'
  readonly size: number
  readonly domainMin: Rgb
  readonly domainMax: Rgb
}
export interface ParsedColorLut extends ColorLutShape { readonly title: string; readonly samples: Float64Array }
export interface PortableColorLutV1 extends ColorLutShape {
  readonly version: 1
  readonly id: string
  readonly name: string
  readonly encoding: typeof COLOR_LUT_ENCODING
  readonly data: string
}
export interface DecodedColorLut extends ColorLutShape { readonly samples: Float64Array; readonly identity: boolean }

export class ColorLutError extends Error {
  readonly line: number | null
  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `Line ${line}: ${message}`)
    this.name = 'ColorLutError'
    this.line = line
  }
}
export function colorLutSampleCount(kind: '1d' | '3d', size: number): number {
  if (!Number.isSafeInteger(size) || size < 2 || size > (kind === '1d' ? COLOR_LUT_LIMITS.oneDimensionalSize : COLOR_LUT_LIMITS.threeDimensionalSize)) throw new ColorLutError('Unsupported LUT size: use 1D 2–4,096 or 3D 2–33.')
  return (kind === '1d' ? size : size ** 3) * 3
}
function checkedRgb(value: unknown): value is Rgb {
  return Array.isArray(value) && value.length === 3 && value.every((v) => finiteColorNumber(v, -16, 16))
}
function domainError(min: unknown, max: unknown): string | null {
  if (!checkedRgb(min) || !checkedRgb(max)) return 'LUT domains need three finite values from -16 to 16.'
  return min.some((value, i) => max[i] - value < COLOR_LUT_LIMITS.minimumDomainSpan) ? 'Every LUT domain span must be at least 0.000001.' : null
}
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u
function sampleNumber(token: string, line: number): number {
  if (token.length > COLOR_LUT_LIMITS.tokenBytes || !DECIMAL.test(token)) throw new ColorLutError('Expected a bounded decimal number.', line)
  const value = Number(token)
  if (!finiteColorNumber(value, -16, 16)) throw new ColorLutError('LUT numbers must be finite and between -16 and 16.', line)
  return value === 0 ? 0 : value
}
function rgbTokens(tokens: readonly string[], line: number): Rgb {
  if (tokens.length !== 3) throw new ColorLutError('Expected exactly three RGB numbers.', line)
  return [sampleNumber(tokens[0], line), sampleNumber(tokens[1], line), sampleNumber(tokens[2], line)]
}

/** Scan bounded lines before tokenizing; never split the complete untrusted input. */
export function parseCube(input: string): ParsedColorLut {
  if (typeof input !== 'string' || input.length > COLOR_LUT_LIMITS.fileBytes) throw new ColorLutError('LUT file exceeds 4 MiB.')
  const bom = input.charCodeAt(0) === 0xfeff
  if (input.length + (bom ? 2 : 0) > COLOR_LUT_LIMITS.fileBytes) throw new ColorLutError('LUT file exceeds 4 MiB.')
  let start = bom ? 1 : 0, lineNumber = 0, rows = 0
  let shape: { kind: '1d' | '3d'; size: number } | null = null
  let samples: Float64Array | null = null
  let title = '', domainMin: Rgb = [0, 0, 0], domainMax: Rgb = [1, 1, 1]
  const headers = new Set<string>()
  for (let end = start; end <= input.length; end++) {
    const code = end < input.length ? input.charCodeAt(end) : 10
    if (code !== 10) {
      if (end - start > COLOR_LUT_LIMITS.lineBytes || (code !== 9 && code !== 13 && (code < 32 || code > 126))) throw new ColorLutError('Unsupported character or line longer than 250 bytes.', lineNumber + 1)
      if (code === 13 && input.charCodeAt(end + 1) !== 10) throw new ColorLutError('Use LF or CRLF line endings.', lineNumber + 1)
      continue
    }
    if (++lineNumber > COLOR_LUT_LIMITS.lines) throw new ColorLutError('LUT exceeds 100,000 lines.')
    const contentEnd = input.charCodeAt(end - 1) === 13 ? end - 1 : end
    if (contentEnd - start > COLOR_LUT_LIMITS.lineBytes) throw new ColorLutError('Line exceeds 250 bytes.', lineNumber)
    const line = input.slice(start, contentEnd).trim()
    start = end + 1
    if (!line || line.startsWith('#')) continue
    const tokens = line.split(/[ \t]+/u)
    if (/^[A-Za-z_]/u.test(tokens[0])) {
      if (rows > 0) throw new ColorLutError('LUT headers must precede all sample rows.', lineNumber)
      const header = tokens[0]
      if (headers.has(header)) throw new ColorLutError(`Repeated ${header} header.`, lineNumber)
      headers.add(header)
      if (header === 'TITLE') {
        const match = /^TITLE[ \t]+"([^"\r\n]*)"$/u.exec(line)
        if (!match || match[1].length > COLOR_LUT_LIMITS.nameCharacters) throw new ColorLutError('Invalid quoted LUT title.', lineNumber)
        title = match[1]
      } else if (header === 'DOMAIN_MIN' || header === 'DOMAIN_MAX') {
        const rgb = rgbTokens(tokens.slice(1), lineNumber)
        if (header === 'DOMAIN_MIN') domainMin = rgb
        else domainMax = rgb
      } else if (header === 'LUT_1D_SIZE' || header === 'LUT_3D_SIZE') {
        if (shape) throw new ColorLutError('Combined 1D/3D LUTs are unsupported.', lineNumber)
        if (tokens.length !== 2 || !/^\d{1,5}$/u.test(tokens[1])) throw new ColorLutError('LUT size must be one integer.', lineNumber)
        shape = { kind: header === 'LUT_1D_SIZE' ? '1d' : '3d', size: Number(tokens[1]) }
        samples = new Float64Array(colorLutSampleCount(shape.kind, shape.size))
      } else throw new ColorLutError(`Unsupported header ${header}.`, lineNumber)
    } else {
      if (!shape || !samples) throw new ColorLutError('Declare a LUT size before sample rows.', lineNumber)
      if ((rows + 1) * 3 > samples.length) throw new ColorLutError('Too many LUT sample rows.', lineNumber)
      samples.set(rgbTokens(tokens, lineNumber), rows++ * 3)
    }
  }
  if (!shape || !samples || rows * 3 !== samples.length) throw new ColorLutError('Missing or incomplete LUT table.')
  const error = domainError(domainMin, domainMax)
  if (error) throw new ColorLutError(error)
  return { ...shape, title, domainMin, domainMax, samples }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function encodeSamples(samples: Float64Array): string {
  const bytes = new Uint8Array(samples.length * 8)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) view.setFloat64(i * 8, samples[i] === 0 ? 0 : samples[i], true)
  const blocks: string[] = []
  let block = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const value = bytes[i] * 65536 + (bytes[i + 1] ?? 0) * 256 + (bytes[i + 2] ?? 0)
    block += BASE64[value >>> 18] + BASE64[(value >>> 12) & 63]
      + (i + 1 < bytes.length ? BASE64[(value >>> 6) & 63] : '=')
      + (i + 2 < bytes.length ? BASE64[value & 63] : '=')
    if (block.length >= 4096) { blocks.push(block); block = '' }
  }
  blocks.push(block)
  return blocks.join('')
}

function decodedSamples(data: string, count: number): Float64Array {
  const byteLength = count * 8
  if (data.length !== Math.ceil(byteLength / 3) * 4) throw new ColorLutError('LUT encoding length does not match its size.')
  const remainder = byteLength % 3
  const padding = remainder === 0 ? 0 : 3 - remainder
  const meaningful = data.length - padding
  for (let i = 0; i < data.length; i++) {
    if (i < meaningful ? BASE64.indexOf(data[i]) < 0 : data[i] !== '=') throw new ColorLutError('LUT data must use canonical padded base64.')
  }
  if (padding && (BASE64.indexOf(data[meaningful - 1]) & (padding === 2 ? 15 : 3))) throw new ColorLutError('Noncanonical LUT padding bits.')
  const samples = new Float64Array(count)
  const bytes = new Uint8Array(samples.buffer)
  let offset = 0
  for (let i = 0; i < data.length; i += 4) {
    const value = (BASE64.indexOf(data[i]) << 18) | (BASE64.indexOf(data[i + 1]) << 12)
      | (Math.max(0, BASE64.indexOf(data[i + 2])) << 6) | Math.max(0, BASE64.indexOf(data[i + 3]))
    bytes[offset++] = value >>> 16
    if (offset < bytes.length) bytes[offset++] = value >>> 8
    if (offset < bytes.length) bytes[offset++] = value
  }
  const view = new DataView(samples.buffer)
  for (let i = 0; i < count; i++) {
    const value = view.getFloat64(i * 8, true)
    if (!finiteColorNumber(value, -16, 16) || Object.is(value, -0)) throw new ColorLutError('LUT payload has invalid sample values.')
    samples[i] = value
  }
  return samples
}

export function portableColorLut(id: string, name: string, parsed: ParsedColorLut): PortableColorLutV1 {
  if (parsed.samples.length !== colorLutSampleCount(parsed.kind, parsed.size)
    || !parsed.samples.every((v) => finiteColorNumber(v, -16, 16))) throw new ColorLutError('Invalid LUT samples.')
  const result: PortableColorLutV1 = { version: 1, id, name, kind: parsed.kind, size: parsed.size,
    domainMin: [...parsed.domainMin], domainMax: [...parsed.domainMax], encoding: COLOR_LUT_ENCODING, data: encodeSamples(parsed.samples) }
  const error = colorLutMetadataError(result)
  if (error) throw new ColorLutError(error)
  return result
}

export function colorLutMetadataError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'LUT must be a data record.'
  const raw = value as Record<string, unknown>
  const keys = ['version', 'id', 'name', 'kind', 'size', 'domainMin', 'domainMax', 'encoding', 'data']
  if (Object.keys(raw).length !== keys.length || !keys.every((key) => Object.hasOwn(raw, key))) return 'Unexpected LUT record fields.'
  if (raw.version !== 1 || raw.encoding !== COLOR_LUT_ENCODING) return 'Unsupported LUT record version or encoding.'
  if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/u.test(raw.id)) return 'Invalid LUT identity.'
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > COLOR_LUT_LIMITS.nameCharacters
    || [...raw.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return 'Invalid LUT display name.'
  if (raw.kind !== '1d' && raw.kind !== '3d') return 'Unsupported LUT dimension.'
  try {
    const count = colorLutSampleCount(raw.kind, raw.size as number)
    if (typeof raw.data !== 'string' || raw.data.length !== Math.ceil(count * 8 / 3) * 4) return 'LUT encoding length does not match its size.'
  } catch (error) { return (error as Error).message }
  return domainError(raw.domainMin, raw.domainMax)
}

export function decodeColorLut(record: PortableColorLutV1): DecodedColorLut {
  const error = colorLutMetadataError(record)
  if (error) throw new ColorLutError(error)
  const samples = decodedSamples(record.data, colorLutSampleCount(record.kind, record.size))
  let identity = record.domainMin.every((v) => v === 0) && record.domainMax.every((v) => v === 1)
  if (identity) {
    for (let i = 0; i < samples.length; i++) {
      const row = Math.floor(i / 3), channel = i % 3
      const coordinate = record.kind === '1d' ? row : Math.floor(row / record.size ** channel) % record.size
      if (samples[i] !== coordinate / (record.size - 1)) { identity = false; break }
    }
  }
  return { kind: record.kind, size: record.size, domainMin: [...record.domainMin], domainMax: [...record.domainMax], samples, identity }
}

/** Write into caller-owned output; tetrahedral ties use R before G before B. */
export function sampleColorLut(lut: DecodedColorLut, red: number, green: number, blue: number, output: Float64Array): void {
  const n = lut.size, last = n - 1
  const r = clampColorUnit((red - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0])) * last
  const g = clampColorUnit((green - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1])) * last
  const b = clampColorUnit((blue - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2])) * last
  const ri = Math.min(last - 1, Math.floor(r)), gi = Math.min(last - 1, Math.floor(g)), bi = Math.min(last - 1, Math.floor(b))
  const rf = r - ri, gf = g - gi, bf = b - bi
  const data = lut.samples
  if (lut.kind === '1d') {
    output[0] = data[ri * 3] + rf * (data[(ri + 1) * 3] - data[ri * 3])
    output[1] = data[gi * 3 + 1] + gf * (data[(gi + 1) * 3 + 1] - data[gi * 3 + 1])
    output[2] = data[bi * 3 + 2] + bf * (data[(bi + 1) * 3 + 2] - data[bi * 3 + 2])
    return
  }
  const first = (ri + n * gi + n * n * bi) * 3
  const rs = 3, gs = n * 3, bs = n * n * 3
  let a: number, c: number, f1: number, f2: number, f3: number
  if (rf >= gf) {
    if (gf >= bf) { a = rs; c = rs + gs; f1 = rf; f2 = gf; f3 = bf }
    else if (rf >= bf) { a = rs; c = rs + bs; f1 = rf; f2 = bf; f3 = gf }
    else { a = bs; c = bs + rs; f1 = bf; f2 = rf; f3 = gf }
  } else if (rf >= bf) { a = gs; c = gs + rs; f1 = gf; f2 = rf; f3 = bf }
  else if (gf >= bf) { a = gs; c = gs + bs; f1 = gf; f2 = bf; f3 = rf }
  else { a = bs; c = bs + gs; f1 = bf; f2 = gf; f3 = rf }
  for (let channel = 0; channel < 3; channel++) {
    const index = first + channel
    output[channel] = data[index] * (1 - f1) + data[index + a] * (f1 - f2)
      + data[index + c] * (f2 - f3) + data[index + rs + gs + bs] * f3
  }
}

export function applyColorLut(rgba: Uint8ClampedArray, lut: DecodedColorLut, strength: number, start = 0, count = rgba.length / 4): void {
  colorPixelRange(rgba, start, count)
  if (!finiteColorNumber(strength, 0, 1)) throw new ColorLutError('LUT strength must be between 0 and 1.')
  if (strength === 0 || lut.identity) return
  const mapped = new Float64Array(3)
  for (let i = start * 4, end = (start + count) * 4; i < end; i += 4) {
    if (rgba[i + 3] === 0) continue
    const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255
    sampleColorLut(lut, r, g, b, mapped)
    rgba[i] = colorByte(r + strength * (mapped[0] - r))
    rgba[i + 1] = colorByte(g + strength * (mapped[1] - g))
    rgba[i + 2] = colorByte(b + strength * (mapped[2] - b))
  }
}
