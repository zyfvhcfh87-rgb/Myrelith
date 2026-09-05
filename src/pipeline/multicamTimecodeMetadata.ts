/** Narrow QuickTime tmcd profile. No creation dates, text tags, rate guesses or edit offsets. */
import { alignmentRateIsSupported } from '../domain/multicamAlignment'
import { parseTimecode, type TimecodeEvidence } from '../domain/multicamTimecode'
import type { FrameRate } from '../domain/schema'

export const TIMECODE_METADATA_LIMITS = Object.freeze({ moovBytes: 4 * 1024 * 1024, boxes: 4096, tracks: 16 })
interface Box { type: string; start: number; data: number; end: number }
function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4))
}
function refuse(detail: string): never { throw new Error(detail) }
function exactRate(num: number, den: number): FrameRate {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num < 1 || den < 1) refuse('Unknown timecode rate')
  let a = num, b = den
  while (b) [a, b] = [b, a % b]
  const rate = { num: num / a, den: den / a }
  if (!alignmentRateIsSupported(rate)) refuse('Unsupported timecode rate')
  return rate
}

/** All I/O is bounded slices. The caller owns cancellation and exact source currentness. */
export async function readMulticamTimecode(blob: Blob, projectRate: FrameRate, commonClockAndDay: boolean, signal: AbortSignal): Promise<TimecodeEvidence> {
  if (!commonClockAndDay) refuse('Confirm that these recordings share a timecode clock and calendar day, without crossing midnight')
  let reads = 0
  const read = async (start: number, size: number): Promise<DataView> => {
    signal.throwIfAborted()
    if (++reads > TIMECODE_METADATA_LIMITS.boxes + 4 || !Number.isSafeInteger(start + size)
      || start < 0 || size < 1 || size > TIMECODE_METADATA_LIMITS.moovBytes || start + size > blob.size) {
      refuse('Timecode metadata exceeds the bounded read profile')
    }
    const buffer = await blob.slice(start, start + size).arrayBuffer()
    signal.throwIfAborted()
    if (buffer.byteLength !== size) refuse('Incomplete timecode metadata')
    return new DataView(buffer)
  }
  let moov: Box | null = null
  const media: Box[] = []
  for (let offset = 0; offset < blob.size;) {
    const head = await read(offset, 8)
    const size32 = head.getUint32(0)
    const type = fourcc(head, 4)
    const size = size32 === 1 ? Number((await read(offset + 8, 8)).getBigUint64(0))
      : size32 === 0 ? blob.size - offset : size32
    const data = offset + (size32 === 1 ? 16 : 8)
    if (!Number.isSafeInteger(offset + size) || size < data - offset || offset + size > blob.size) refuse('Invalid movie atom length')
    const box = { type, start: offset, data, end: offset + size }
    if (type === 'moof') refuse('Fragmented timecode mapping is unsupported')
    if (type === 'moov') {
      if (moov) refuse('Multiple movie headers are unsupported')
      moov = box
    }
    if (type === 'mdat') {
      if (media.length >= 16) refuse('Too many media extents')
      media.push(box)
    }
    offset += size
  }
  if (!moov) refuse('This source has no supported QuickTime timecode track')
  const view = await read(moov.data, moov.end - moov.data)
  let boxes = 0
  const children = (start: number, end: number): Box[] => {
    const result: Box[] = []
    while (start < end) {
      if (++boxes > TIMECODE_METADATA_LIMITS.boxes || start + 8 > end) refuse('Invalid or oversized timecode atom table')
      const size = view.getUint32(start)
      if (size < 8 || start + size > end) refuse('Extended or malformed nested timecode atoms are unsupported')
      result.push({ type: fourcc(view, start + 4), start, data: start + 8, end: start + size })
      start += size
    }
    return result
  }
  const one = (items: Box[], type: string): Box => {
    const matches = items.filter((box) => box.type === type)
    if (matches.length !== 1) refuse(`Timecode needs exactly one ${type} atom`)
    return matches[0]
  }
  const uint = (box: Box, relative: number): number => {
    if (relative < 0 || box.data + relative + 4 > box.end) refuse('Truncated timecode atom')
    return view.getUint32(box.data + relative)
  }
  const versionZero = (box: Box) => { if (uint(box, 0) !== 0) refuse(`Unsupported ${box.type} version or flags`) }
  const root = children(0, view.byteLength)
  if (root.some((box) => box.type === 'mvex')) refuse('Fragmented timecode mapping is unsupported')
  const mvhd = one(root, 'mvhd')
  versionZero(mvhd)
  const movieScale = uint(mvhd, 12)
  if (!movieScale) refuse('Unknown movie time scale')
  const tracks = root.filter((box) => box.type === 'trak')
  if (tracks.length > TIMECODE_METADATA_LIMITS.tracks) refuse('Too many tracks for bounded timecode analysis')
  const parsed = tracks.map((box) => {
    const atoms = children(box.data, box.end)
    const tkhd = one(atoms, 'tkhd')
    if ((uint(tkhd, 0) >>> 24) !== 0) refuse('Unsupported track timing version')
    const mdia = one(atoms, 'mdia')
    const mdiaAtoms = children(mdia.data, mdia.end)
    const hdlr = one(mdiaAtoms, 'hdlr')
    versionZero(hdlr)
    uint(hdlr, 8)
    return { atoms, tkhd, mdiaAtoms, id: uint(tkhd, 12), kind: fourcc(view, hdlr.data + 8) }
  })
  const videoTracks = parsed.filter((track) => track.kind === 'vide')
  if (videoTracks.length !== 1) refuse('Timecode requires one unambiguous video track')
  const video = videoTracks[0]
  if ((uint(video.tkhd, 0) & 1) === 0) refuse('The associated video track is disabled')
  const tref = one(video.atoms, 'tref')
  const ref = one(children(tref.data, tref.end), 'tmcd')
  if (ref.end - ref.data !== 4) refuse('Multiple timecode references are unsupported')
  const timecodeTracks = parsed.filter((track) => track.kind === 'tmcd' && track.id === uint(ref, 0))
  if (timecodeTracks.length !== 1 || new Set(parsed.map((track) => track.id)).size !== parsed.length) refuse('The timecode track reference is ambiguous')
  const tc = timecodeTracks[0]
  const timing = (track: typeof video) => {
    const mdhd = one(track.mdiaAtoms, 'mdhd')
    versionZero(mdhd)
    const scale = uint(mdhd, 12), duration = uint(mdhd, 16)
    if (!scale || !duration || BigInt(duration) * BigInt(movieScale) !== BigInt(uint(track.tkhd, 20)) * BigInt(scale)) refuse('Unknown track duration mapping')
    const edits = track.atoms.filter((box) => box.type === 'edts')
    if (edits.length > 1) refuse('Ambiguous track edits')
    if (edits.length) {
      const elst = one(children(edits[0].data, edits[0].end), 'elst')
      versionZero(elst)
      if (elst.end - elst.data !== 20 || uint(elst, 4) !== 1 || uint(elst, 8) !== uint(track.tkhd, 20)
        || uint(elst, 12) !== 0 || uint(elst, 16) !== 0x00010000) refuse('Timecode supports only an identity edit starting at presentation zero')
    }
    const minf = one(track.mdiaAtoms, 'minf')
    const minfAtoms = children(minf.data, minf.end)
    const stbl = one(minfAtoms, 'stbl')
    const table = children(stbl.data, stbl.end)
    if (table.some((box) => ['ctts', 'cslg'].includes(box.type))) refuse('Composition timestamp offsets are unsupported for timecode')
    const stts = one(table, 'stts')
    versionZero(stts)
    if (stts.end - stts.data !== 16 || uint(stts, 4) !== 1 || !uint(stts, 8) || !uint(stts, 12)
      || BigInt(uint(stts, 8)) * BigInt(uint(stts, 12)) !== BigInt(duration)) refuse('Timecode requires a continuous constant-rate sample table')
    return { scale, duration, count: uint(stts, 8), delta: uint(stts, 12), table, minfAtoms }
  }
  const vt = timing(video), tt = timing(tc)
  if (tt.count !== 1 || BigInt(vt.duration) * BigInt(tt.scale) !== BigInt(tt.duration) * BigInt(vt.scale)) refuse('Timecode must cover the complete video with one continuous sample')
  const sourceRate = exactRate(vt.scale, vt.delta)
  const stsd = one(tt.table, 'stsd')
  versionZero(stsd)
  if (uint(stsd, 4) !== 1) refuse('Timecode format changes are unsupported')
  const description = one(children(stsd.data + 8, stsd.end), 'tmcd')
  // Sample-entry header: reserved[6], data-reference[2], reserved[4], flags, scale, duration, quanta.
  if (description.end - description.start !== 36 || uint(description, 0) !== 0 || uint(description, 4) !== 1 || uint(description, 8) !== 0) refuse('Unsupported timecode sample description')
  const flags = uint(description, 12)
  if (flags !== 0 && flags !== 2) refuse('Drop-frame, negative, counter and unknown timecode flags are unsupported')
  const rate = exactRate(uint(description, 16), uint(description, 20))
  const nominal = Math.ceil(rate.num / rate.den)
  if (view.getUint8(description.data + 24) !== nominal || view.getUint8(description.data + 25) !== 0
    || view.getUint16(description.data + 26) !== 0
    || [sourceRate, projectRate].some((other) => other.num !== rate.num || other.den !== rate.den)) refuse('Timecode, source and project rates must match exactly')
  const dinf = one(tt.minfAtoms, 'dinf')
  const dref = one(children(dinf.data, dinf.end), 'dref')
  versionZero(dref)
  if (uint(dref, 4) !== 1) refuse('External timecode data is unsupported')
  const url = one(children(dref.data + 8, dref.end), 'url ')
  if (url.end - url.data !== 4 || uint(url, 0) !== 1) refuse('External timecode data is unsupported')
  const stsc = one(tt.table, 'stsc'), stsz = one(tt.table, 'stsz')
  versionZero(stsc); versionZero(stsz)
  if (stsc.end - stsc.data !== 20 || uint(stsc, 4) !== 1 || [8, 12, 16].some((offset) => uint(stsc, offset) !== 1)
    || stsz.end - stsz.data !== 12 || uint(stsz, 4) !== 4 || uint(stsz, 8) !== 1) refuse('Timecode sample layout is unsupported')
  const offsets = tt.table.filter((box) => box.type === 'stco' || box.type === 'co64')
  if (offsets.length !== 1) refuse('Ambiguous timecode sample offset')
  const offsetBox = offsets[0]
  versionZero(offsetBox)
  if (uint(offsetBox, 4) !== 1 || offsetBox.end - offsetBox.data !== (offsetBox.type === 'stco' ? 12 : 16)) refuse('Timecode needs one sample offset')
  const offset = offsetBox.type === 'stco' ? uint(offsetBox, 8) : Number(view.getBigUint64(offsetBox.data + 8))
  if (!Number.isSafeInteger(offset) || !media.some((box) => offset >= box.data && offset + 4 <= box.end)) refuse('Timecode sample lies outside local media data')
  const frameCount = (await read(offset, 4)).getInt32(0)
  if (frameCount < 0 || frameCount + vt.count >= nominal * 86400) refuse('Negative or midnight-crossing timecode is unsupported')
  const seconds = Math.floor(frameCount / nominal)
  const label = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, frameCount % nominal]
    .map((part) => String(part).padStart(2, '0')).join(':')
  const result = parseTimecode({ format: 'normalized-timecode-v1', label, rate, counting: 'non-drop',
    origin: 'presentation-frame-zero', continuity: 'continuous', dayOffset: 0, clockDomain: 'user-confirmed-common-clock-same-day' })
  if (result.state !== 'valid') refuse('Timecode evidence failed validation')
  return result.evidence
}
