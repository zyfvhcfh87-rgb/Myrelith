/** Pure RGBA8 channel tables. Hosts own the returned buffers and their lifetime. */
export type Rgb = readonly [number, number, number]
export type ChannelTables = readonly [Uint8Array, Uint8Array, Uint8Array]
export const clampColorUnit = (value: number): number => Math.min(1, Math.max(0, value))
export const colorByte = (value: number): number => Math.round(255 * clampColorUnit(value))

export function materializeChannels(evaluate: (value: number, channel: number) => number): ChannelTables {
  const tables: ChannelTables = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)]
  for (let channel = 0; channel < 3; channel++) {
    for (let value = 0; value < 256; value++) tables[channel][value] = colorByte(evaluate(value / 255, channel))
  }
  return tables
}

export function colorPixelRange(rgba: Uint8ClampedArray, start: number, count: number): void {
  if (rgba.length % 4 || !Number.isSafeInteger(start) || !Number.isSafeInteger(count)
    || start < 0 || count < 0 || start + count > rgba.length / 4) throw new RangeError('Invalid grading pixel range.')
}

/** Independent channel operations preserve alpha and invisible RGB exactly. */
export function applyChannelTables(rgba: Uint8ClampedArray, tables: ChannelTables, start = 0, count = rgba.length / 4): void {
  colorPixelRange(rgba, start, count)
  for (let i = start * 4, end = (start + count) * 4; i < end; i += 4) {
    if (rgba[i + 3] === 0) continue
    rgba[i] = tables[0][rgba[i]]
    rgba[i + 1] = tables[1][rgba[i + 1]]
    rgba[i + 2] = tables[2][rgba[i + 2]]
  }
}

export function finiteColorNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}
