/**
 * Browser-free recovery scan for a fragmented MP4 cut off mid-write.
 *
 * A capture writes `ftyp`, `moov` (with `mvex`), then `moof`+`mdat` pairs. A
 * crash can leave a torn trailing box or a `moof` without its `mdat`. The
 * valid prefix ends after the last complete `mdat` that follows a complete
 * `moof`. Only box headers are read (bounded), never the media payload.
 */

export interface Mp4ByteReader {
  readonly size: number
  /** Read exactly `length` bytes at `at`, or fewer only at end of file. */
  read(at: number, length: number): Uint8Array
}

export interface Mp4TopLevelBox {
  readonly type: string
  readonly start: number
  readonly size: number
}

export type FragmentedMp4Scan =
  | { readonly status: 'recoverable'; readonly validBytes: number; readonly fragments: number;
    readonly boxes: readonly Mp4TopLevelBox[]; readonly discardedBytes: number }
  | { readonly status: 'unrecoverable'; readonly reason: string; readonly boxes: readonly Mp4TopLevelBox[] }

const MAX_BOXES = 1_000_000

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

/** Enumerate complete top-level boxes; stops at the first torn or invalid one. */
export function scanMp4TopLevelBoxes(reader: Mp4ByteReader): { boxes: Mp4TopLevelBox[]; tornAt: number | null } {
  const boxes: Mp4TopLevelBox[] = []
  let at = 0
  while (at < reader.size) {
    if (boxes.length >= MAX_BOXES) return { boxes, tornAt: at }
    if (reader.size - at < 8) return { boxes, tornAt: at }
    const header = reader.read(at, 16)
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    let size = view.getUint32(0)
    const type = fourcc(header, 4)
    if (!/^[\x20-\x7e]{4}$/.test(type)) return { boxes, tornAt: at }
    let headerBytes = 8
    if (size === 1) {
      if (header.length < 16) return { boxes, tornAt: at }
      const large = view.getBigUint64(8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return { boxes, tornAt: at }
      size = Number(large)
      headerBytes = 16
    } else if (size === 0) {
      // "Extends to end of file": only trustworthy for a closed file; treat as torn.
      return { boxes, tornAt: at }
    }
    if (size < headerBytes || at + size > reader.size) return { boxes, tornAt: at }
    boxes.push({ type, start: at, size })
    at += size
  }
  return { boxes, tornAt: null }
}

/** Find the longest playable prefix of a fragmented MP4. */
export function scanFragmentedMp4(reader: Mp4ByteReader): FragmentedMp4Scan {
  const { boxes } = scanMp4TopLevelBoxes(reader)
  const ftyp = boxes.findIndex((box) => box.type === 'ftyp')
  const moov = boxes.findIndex((box) => box.type === 'moov')
  if (ftyp !== 0) return { status: 'unrecoverable', reason: 'The capture has no file header', boxes }
  if (moov < 0) return { status: 'unrecoverable', reason: 'The capture has no track header', boxes }
  let validBytes = 0
  let fragments = 0
  let pendingMoof = false
  for (let index = moov + 1; index < boxes.length; index++) {
    const box = boxes[index]!
    if (box.type === 'moof') pendingMoof = true
    else if (box.type === 'mdat' && pendingMoof) {
      pendingMoof = false
      fragments++
      validBytes = box.start + box.size
    } else if (box.type === 'mfra') {
      // A finished file: its random-access index is valid too.
      validBytes = box.start + box.size
    }
  }
  if (fragments === 0) return { status: 'unrecoverable', reason: 'No complete media fragment was written', boxes }
  return { status: 'recoverable', validBytes, fragments, boxes, discardedBytes: reader.size - validBytes }
}
