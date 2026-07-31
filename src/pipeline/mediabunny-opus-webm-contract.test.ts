import {
  ALL_FORMATS,
  BufferTarget,
  BufferSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  Output,
  WebMOutputFormat,
} from 'mediabunny'
import { describe, expect, it } from 'vitest'

const OPUS_SAMPLE_RATE = 48_000
const OPUS_PRE_SKIP_SAMPLES = 312
const OPUS_PACKET_SAMPLES = 960
const OPUS_PACKET_DURATION_SECONDS = OPUS_PACKET_SAMPLES / OPUS_SAMPLE_RATE

const EBML_ID = {
  audio: 0xe1,
  blockAdditions: 0x75a1,
  blockGroup: 0xa0,
  blockMore: 0xa6,
  cluster: 0x1f43b675,
  codecPrivate: 0x63a2,
  codecDelay: 0x56aa,
  cuePoint: 0xbb,
  cueTrackPositions: 0xb7,
  cues: 0x1c53bb6b,
  discardPadding: 0x75a2,
  docTypeVersion: 0x4287,
  ebml: 0x1a45dfa3,
  info: 0x1549a966,
  seek: 0x4dbb,
  seekHead: 0x114d9b74,
  seekPreRoll: 0x56bb,
  segment: 0x18538067,
  samplingFrequency: 0xb5,
  simpleBlock: 0xa3,
  duration: 0x4489,
  trackEntry: 0xae,
  tracks: 0x1654ae6b,
  video: 0xe0,
} as const

const MASTER_ELEMENT_IDS = new Set<number>([
  EBML_ID.audio,
  EBML_ID.blockAdditions,
  EBML_ID.blockGroup,
  EBML_ID.blockMore,
  EBML_ID.cluster,
  EBML_ID.cuePoint,
  EBML_ID.cueTrackPositions,
  EBML_ID.cues,
  EBML_ID.ebml,
  EBML_ID.info,
  EBML_ID.seek,
  EBML_ID.seekHead,
  EBML_ID.segment,
  EBML_ID.trackEntry,
  EBML_ID.tracks,
  EBML_ID.video,
])

type ExactPresentationAudioSource = EncodedAudioPacketSource & {
  _exactEncodedPresentationEnd: {
    sampleIndex: number
    sampleRate: number
  } | null
}

type EbmlElement = {
  readonly id: number
  readonly dataStart: number
  readonly dataEnd: number
  readonly parentId: number | null
  readonly children: readonly EbmlElement[]
}

type Vint = {
  readonly length: number
  readonly value: number
  readonly unknown: boolean
}

function makeOpusHead(): Uint8Array {
  const header = new Uint8Array(19)
  header.set(new TextEncoder().encode('OpusHead'))

  const view = new DataView(header.buffer)
  view.setUint8(8, 1)
  view.setUint8(9, 2)
  view.setUint16(10, OPUS_PRE_SKIP_SAMPLES, true)
  view.setUint32(12, OPUS_SAMPLE_RATE, true)
  view.setInt16(16, 0, true)
  view.setUint8(18, 0)

  return header
}

function vintLength(firstByte: number): number {
  if (firstByte === 0) {
    throw new Error('Invalid EBML variable-length integer.')
  }

  let length = 1
  let marker = 0x80
  while ((firstByte & marker) === 0) {
    length += 1
    marker >>= 1
  }

  return length
}

function readElementId(bytes: Uint8Array, offset: number): Vint {
  const length = vintLength(bytes[offset] ?? 0)
  if (offset + length > bytes.length) {
    throw new Error('Truncated EBML element ID.')
  }

  let value = 0
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + bytes[offset + index]!
  }

  return { length, value, unknown: false }
}

function readElementSize(bytes: Uint8Array, offset: number): Vint {
  const firstByte = bytes[offset] ?? 0
  const length = vintLength(firstByte)
  if (offset + length > bytes.length) {
    throw new Error('Truncated EBML element size.')
  }

  const marker = 0x80 >> (length - 1)
  let value = firstByte & (marker - 1)
  let unknown = value === marker - 1

  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index]!
    value = value * 256 + byte
    unknown &&= byte === 0xff
  }

  return { length, value, unknown }
}

function parseElements(
  bytes: Uint8Array,
  start: number,
  end: number,
  parentId: number | null = null,
): EbmlElement[] {
  const elements: EbmlElement[] = []
  let offset = start

  while (offset < end) {
    const id = readElementId(bytes, offset)
    const size = readElementSize(bytes, offset + id.length)
    const dataStart = offset + id.length + size.length
    const dataEnd = size.unknown ? end : dataStart + size.value

    if (dataStart > end || dataEnd > end || dataEnd < dataStart) {
      throw new Error(`Invalid EBML element 0x${id.value.toString(16)} bounds.`)
    }

    const children = MASTER_ELEMENT_IDS.has(id.value)
      ? parseElements(bytes, dataStart, dataEnd, id.value)
      : []

    elements.push({
      id: id.value,
      dataStart,
      dataEnd,
      parentId,
      children,
    })

    offset = dataEnd
  }

  if (offset !== end) {
    throw new Error('EBML element parsing did not end on its parent boundary.')
  }

  return elements
}

function flattenElements(elements: readonly EbmlElement[]): EbmlElement[] {
  return elements.flatMap((element) => [element, ...flattenElements(element.children)])
}

function findElements(elements: readonly EbmlElement[], id: number): EbmlElement[] {
  return flattenElements(elements).filter((element) => element.id === id)
}

function readUnsignedInteger(bytes: Uint8Array, element: EbmlElement): number {
  let value = 0
  for (let offset = element.dataStart; offset < element.dataEnd; offset += 1) {
    value = value * 256 + bytes[offset]!
  }
  return value
}

function readSignedInteger(bytes: Uint8Array, element: EbmlElement): number {
  const byteLength = element.dataEnd - element.dataStart
  const unsigned = readUnsignedInteger(bytes, element)
  const firstByte = bytes[element.dataStart]!
  return (firstByte & 0x80) === 0
    ? unsigned
    : unsigned - 2 ** (byteLength * 8)
}

function readFloat(bytes: Uint8Array, element: EbmlElement): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataStart)
  const byteLength = element.dataEnd - element.dataStart

  if (byteLength === 4) {
    return view.getFloat32(0, false)
  }
  if (byteLength === 8) {
    return view.getFloat64(0, false)
  }

  throw new Error(`Unsupported EBML float width: ${byteLength}.`)
}

function onlyElement(elements: readonly EbmlElement[], id: number): EbmlElement {
  const matches = findElements(elements, id)
  expect(matches).toHaveLength(1)
  return matches[0]!
}

function packetCountForPresentationEnd(sampleIndex: number, startSampleIndex = 0): number {
  return Math.ceil(
    (sampleIndex - startSampleIndex + OPUS_PRE_SKIP_SAMPLES) / OPUS_PACKET_SAMPLES,
  )
}

function expectedDiscardPaddingNs(sampleIndex: number, startSampleIndex = 0): number {
  const packetCount = packetCountForPresentationEnd(sampleIndex, startSampleIndex)
  const finalPacketTimestamp = (
    startSampleIndex + (packetCount - 1) * OPUS_PACKET_SAMPLES
  ) / OPUS_SAMPLE_RATE
  const serializedFinalPacketTimestamp = Math.round(1000 * finalPacketTimestamp) / 1000

  return Math.round(
    1_000_000_000 * (
      serializedFinalPacketTimestamp
      + OPUS_PACKET_DURATION_SECONDS
      - OPUS_PRE_SKIP_SAMPLES / OPUS_SAMPLE_RATE
      - sampleIndex / OPUS_SAMPLE_RATE
    ),
  )
}

function expectWithinHalfNanosecond(actual: number | null, expected: number): void {
  expect(actual).not.toBeNull()
  expect(Math.abs(actual! - expected) * 1_000_000_000).toBeLessThanOrEqual(0.5)
}

async function muxOpus(sampleIndex: number, startSampleIndex = 0): Promise<Uint8Array> {
  const target = new BufferTarget()
  const output = new Output({
    format: new WebMOutputFormat(),
    target,
  })
  const source = new EncodedAudioPacketSource('opus')
  ;(source as ExactPresentationAudioSource)._exactEncodedPresentationEnd = {
    sampleIndex,
    sampleRate: OPUS_SAMPLE_RATE,
  }

  output.addAudioTrack(source)
  await output.start()

  const packetCount = packetCountForPresentationEnd(sampleIndex, startSampleIndex)
  for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
    await source.add(
      new EncodedPacket(
        new Uint8Array([0xfc, 0xff, 0xfe]),
        'key',
        (startSampleIndex + packetIndex * OPUS_PACKET_SAMPLES) / OPUS_SAMPLE_RATE,
        OPUS_PACKET_DURATION_SECONDS,
        packetIndex,
      ),
      packetIndex === 0
        ? {
            decoderConfig: {
              codec: 'opus',
              numberOfChannels: 2,
              sampleRate: OPUS_SAMPLE_RATE,
              description: makeOpusHead(),
            },
          }
        : undefined,
    )
  }

  await output.finalize()
  expect(target.buffer).not.toBeNull()
  return new Uint8Array(target.buffer!)
}

async function muxOpusWithPresentationSampleRate(presentationSampleRate: number): Promise<{
  bytes: Uint8Array
  originalHeader: Uint8Array
  suppliedHeader: Uint8Array
}> {
  const target = new BufferTarget()
  const output = new Output({
    format: new WebMOutputFormat(),
    target,
  })
  const source = new EncodedAudioPacketSource('opus')
  ;(source as ExactPresentationAudioSource)._exactEncodedPresentationEnd = {
    sampleIndex: presentationSampleRate / 50,
    sampleRate: presentationSampleRate,
  }
  const suppliedHeader = makeOpusHead()
  const originalHeader = suppliedHeader.slice()

  output.addAudioTrack(source)
  await output.start()

  for (let packetIndex = 0; packetIndex < 2; packetIndex += 1) {
    await source.add(
      new EncodedPacket(
        new Uint8Array([0xfc, 0xff, 0xfe]),
        'key',
        packetIndex * OPUS_PACKET_DURATION_SECONDS,
        OPUS_PACKET_DURATION_SECONDS,
        packetIndex,
      ),
      packetIndex === 0
        ? {
            decoderConfig: {
              codec: 'opus',
              numberOfChannels: 2,
              sampleRate: OPUS_SAMPLE_RATE,
              description: suppliedHeader,
            },
          }
        : undefined,
    )
  }

  await output.finalize()
  expect(target.buffer).not.toBeNull()

  return {
    bytes: new Uint8Array(target.buffer!),
    originalHeader,
    suppliedHeader,
  }
}

describe('Mediabunny Opus WebM exact-presentation patch contract', () => {
  it.each([1, 648, 649, 960])(
    'writes exact Opus timing metadata at the %i-sample boundary',
    async (sampleIndex) => {
      const bytes = await muxOpus(sampleIndex)
      const elements = parseElements(bytes, 0, bytes.length)

      expect(readUnsignedInteger(bytes, onlyElement(elements, EBML_ID.docTypeVersion))).toBe(4)
      expect(readUnsignedInteger(bytes, onlyElement(elements, EBML_ID.codecDelay))).toBe(6_500_000)
      expect(readUnsignedInteger(bytes, onlyElement(elements, EBML_ID.seekPreRoll))).toBe(80_000_000)

      const duration = onlyElement(elements, EBML_ID.duration)
      expect(duration.parentId).toBe(EBML_ID.info)
      expect(readFloat(bytes, duration)).toBeCloseTo(sampleIndex / 48, 10)

      const expectedPadding = expectedDiscardPaddingNs(sampleIndex)
      const paddingElements = findElements(elements, EBML_ID.discardPadding)
      if (expectedPadding === 0) {
        expect(paddingElements).toHaveLength(0)
      } else {
        expect(paddingElements).toHaveLength(1)
        const padding = paddingElements[0]!
        expect(padding.parentId).toBe(EBML_ID.blockGroup)
        expect(readSignedInteger(bytes, padding)).toBe(expectedPadding)

        const containingBlockGroup = findElements(elements, EBML_ID.blockGroup).find(
          (element) => element.dataStart <= padding.dataStart && element.dataEnd >= padding.dataEnd,
        )
        const mediaBlocks = [
          ...findElements(elements, EBML_ID.simpleBlock),
          ...findElements(elements, EBML_ID.blockGroup),
        ]
        const finalMediaBlock = mediaBlocks.reduce((latest, element) => (
          element.dataStart > latest.dataStart ? element : latest
        ))
        expect(containingBlockGroup).toBe(finalMediaBlock)
      }

      const reopened = new Input({
        source: new BufferSource(bytes),
        formats: ALL_FORMATS,
      })
      try {
        const metadataDuration = await reopened.getDurationFromMetadata()
        expectWithinHalfNanosecond(
          metadataDuration,
          sampleIndex / OPUS_SAMPLE_RATE,
        )
        expectWithinHalfNanosecond(
          await reopened.computeDuration(),
          sampleIndex / OPUS_SAMPLE_RATE,
        )
      } finally {
        reopened.dispose()
      }
    },
  )

  it('uses the serialized millisecond packet timestamp for sub-millisecond starts', async () => {
    const startSampleIndex = 29
    const sampleIndex = startSampleIndex + 960
    const bytes = await muxOpus(sampleIndex, startSampleIndex)
    const elements = parseElements(bytes, 0, bytes.length)

    const padding = onlyElement(elements, EBML_ID.discardPadding)
    expect(readSignedInteger(bytes, padding)).toBe(
      expectedDiscardPaddingNs(sampleIndex, startSampleIndex),
    )
    expect(readSignedInteger(bytes, padding)).toBe(13_895_833)

    const reopened = new Input({
      source: new BufferSource(bytes),
      formats: ALL_FORMATS,
    })
    try {
      expectWithinHalfNanosecond(
        await reopened.getDurationFromMetadata(),
        sampleIndex / OPUS_SAMPLE_RATE,
      )
      expectWithinHalfNanosecond(
        await reopened.computeDuration(),
        sampleIndex / OPUS_SAMPLE_RATE,
      )
    } finally {
      reopened.dispose()
    }
  })

  it.each([44_100, 96_000])(
    'writes the %i Hz presentation rate without mutating Chromium Opus metadata',
    async (presentationSampleRate) => {
      const { bytes, originalHeader, suppliedHeader } = await muxOpusWithPresentationSampleRate(
        presentationSampleRate,
      )
      const elements = parseElements(bytes, 0, bytes.length)
      const codecPrivate = onlyElement(elements, EBML_ID.codecPrivate)
      const muxedOpusHead = bytes.subarray(codecPrivate.dataStart, codecPrivate.dataEnd)
      const expectedSampleRateBytes = new Uint8Array(4)
      new DataView(expectedSampleRateBytes.buffer).setUint32(0, presentationSampleRate, true)

      expect(muxedOpusHead.subarray(12, 16)).toEqual(expectedSampleRateBytes)
      expect(readFloat(bytes, onlyElement(elements, EBML_ID.samplingFrequency))).toBe(
        presentationSampleRate,
      )
      expect(suppliedHeader).toEqual(originalHeader)
      expect(new DataView(suppliedHeader.buffer).getUint32(12, true)).toBe(OPUS_SAMPLE_RATE)
    },
  )

  it('keeps the longer video duration when exact Opus audio ends first', async () => {
    const target = new BufferTarget()
    const output = new Output({
      format: new WebMOutputFormat(),
      target,
    })
    const videoSource = new EncodedVideoPacketSource('vp9')
    const audioSource = new EncodedAudioPacketSource('opus')
    ;(audioSource as ExactPresentationAudioSource)._exactEncodedPresentationEnd = {
      sampleIndex: 648,
      sampleRate: OPUS_SAMPLE_RATE,
    }

    output.addVideoTrack(videoSource, { frameRate: 25 })
    output.addAudioTrack(audioSource)
    await output.start()

    await videoSource.add(
      new EncodedPacket(new Uint8Array([0x82, 0, 0]), 'key', 0, 0.04, 0),
      {
        decoderConfig: {
          codec: 'vp09.00.10.08',
          codedWidth: 2,
          codedHeight: 2,
        },
      },
    )
    await audioSource.add(
      new EncodedPacket(new Uint8Array([0xfc, 0, 0]), 'key', 0, OPUS_PACKET_DURATION_SECONDS, 0),
      {
        decoderConfig: {
          codec: 'opus',
          numberOfChannels: 2,
          sampleRate: OPUS_SAMPLE_RATE,
          description: makeOpusHead(),
        },
      },
    )

    await output.finalize()
    expect(target.buffer).not.toBeNull()

    const bytes = new Uint8Array(target.buffer!)
    const elements = parseElements(bytes, 0, bytes.length)
    expect(readFloat(bytes, onlyElement(elements, EBML_ID.duration))).toBe(40)
    expect(findElements(elements, EBML_ID.discardPadding)).toHaveLength(0)
  })
})
