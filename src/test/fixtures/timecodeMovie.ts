/** Minimal ISO-BMFF metadata fixture; synthetic bytes are not a decoded-video acceptance claim. */
export interface TimecodeFixtureOptions {
  frameCount?: number; flags?: number; referenceId?: number; sampleOffset?: number; identityEdit?: boolean;
  mediaTime?: number; videoDelta?: number; external?: boolean; sampleCount?: number; compositionOffset?: boolean; handlerVersion?: number;
}
export function makeTimecodeMovie(options: TimecodeFixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
    const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
    let offset = 0
    for (const part of parts) { result.set(part, offset); offset += part.length }
    return result
  }
  const words = (...values: number[]) => {
    const result = new Uint8Array(values.length * 4), view = new DataView(result.buffer)
    values.forEach((value, i) => view.setUint32(i * 4, value))
    return result
  }
  const atom = (type: string, ...parts: Uint8Array[]) => {
    const data = join(...parts)
    return join(words(data.length + 8), new TextEncoder().encode(type), data)
  }
  const duration = 9000
  const track = (kind: 'vide' | 'tmcd', id: number) => {
    const tc = kind === 'tmcd'
    const stbl = atom('stbl',
      atom('stts', words(0, 1, tc ? options.sampleCount ?? 1 : 270, tc ? duration : options.videoDelta ?? 1000)),
      ...(tc ? [
        atom('stsd', words(0, 1), atom('tmcd', words(0, 1, 0, options.flags ?? 0, 30000, 1000), new Uint8Array([30, 0, 0, 0]))),
        atom('stsc', words(0, 1, 1, 1, 1)), atom('stsz', words(0, 4, 1)),
        atom('stco', words(0, 1, options.sampleOffset ?? 8)),
      ] : options.compositionOffset ? [atom('ctts', words(0, 1, 270, 1))] : []))
    return atom('trak', atom('tkhd', words(3, 0, 0, id, 0, duration)),
      ...(!tc ? [atom('tref', atom('tmcd', words(options.referenceId ?? 2)))] : []),
      ...(options.identityEdit ? [atom('edts', atom('elst', words(0, 1, duration, options.mediaTime ?? 0, 0x10000)))] : []),
      atom('mdia', atom('mdhd', words(0, 0, 0, tc ? 1000 : 30000, tc ? duration : 270000)),
        atom('hdlr', words((options.handlerVersion ?? 0) * 0x1000000, 0), new TextEncoder().encode(kind)),
        atom('minf', atom('dinf', atom('dref', words(0, 1), atom('url ', words(options.external ? 0 : 1)))), stbl)))
  }
  return join(atom('mdat', words(options.frameCount ?? 108000)),
    atom('moov', atom('mvhd', words(0, 0, 0, 1000, duration)), track('vide', 1), track('tmcd', 2)))
}
