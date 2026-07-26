import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])
const STATIC_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABgEBAAAAAAAAAAAAAAAAAAAABRABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJIAuHf/2Q==',
  'base64',
)
const ORIENTABLE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABYAAEBAAAAAAAAAAAAAAAAAAAEBwEBAQAAAAAAAAAAAAAAAAAAAgcQAAEFAQAAAAAAAAAAAAAAAAAEAgWzNYMRAAEFAQAAAAAAAAAAAAAAAAYFAwC0NnX/wAARCAACAAQDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCUT2so5VMBjJ7WUcqmAy1AmHF+Gk0mYTPYEfZU7bs//9k=',
  'base64',
)
const STATIC_WEBP = Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQrsa0r/+BiOh/AAA=',
  'base64',
)
const ANIMATED_WEBP = Buffer.from(
  'UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAAEAAAEAAMgAAAJWUDhMDwAAAC8BQAAABxD1j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAEAAAEAAMgAAABWUDhMDwAAAC8BQAAABxDR//4HIqL/AQA=',
  'base64',
)
const STATIC_AVIF = Buffer.from(
  'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAZAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAACAAAAAgAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAhbWRhdAoFGAA2wCAyEBeAAABIAAAAAHlNQ2C4p4A=',
  'base64',
)

function jpegWithExifOrientation(bytes, orientation) {
  assert(bytes[0] === 0xff && bytes[1] === 0xd8)
  assert(Number.isInteger(orientation) && orientation >= 1 && orientation <= 8)

  const tiff = Buffer.alloc(26)
  tiff.write('II', 0, 'ascii')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8)
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(orientation, 18)
  tiff.writeUInt32LE(0, 22)

  const payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'binary'),
    tiff,
  ])
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([(payload.length + 2) >>> 8, (payload.length + 2) & 0xff]),
    payload,
  ])
  return Buffer.concat([bytes.subarray(0, 2), app1, bytes.subarray(2)])
}

function uint32BigEndian(value) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function uint16BigEndian(value) {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16BE(value)
  return bytes
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function adler32(bytes) {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, 'ascii')
  return Buffer.concat([
    uint32BigEndian(data.length),
    typeBytes,
    data,
    uint32BigEndian(crc32(Buffer.concat([typeBytes, data]))),
  ])
}

function pngHeader(width, height) {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = 8
  data[9] = 6
  return pngChunk('IHDR', data)
}

function storedZlibStream(data) {
  if (data.length > 0xffff) {
    throw new Error('The compact fixture encoder supports one stored block')
  }
  const header = Buffer.alloc(7)
  header[0] = 0x78
  header[1] = 0x01
  header[2] = 0x01
  header.writeUInt16LE(data.length, 3)
  header.writeUInt16LE((~data.length) & 0xffff, 5)
  return Buffer.concat([
    header,
    data,
    uint32BigEndian(adler32(data)),
  ])
}

const FIRST_PNG_SCANLINES = Buffer.from([
  0,
  0xff, 0x00, 0x00, 0xff,
  0x00, 0xff, 0x00, 0x80,
  0,
  0x00, 0x00, 0xff, 0x40,
  0xff, 0xff, 0xff, 0xff,
])

const SECOND_PNG_SCANLINES = Buffer.from([
  0,
  0x00, 0x00, 0xff, 0xff,
  0xff, 0xff, 0x00, 0x80,
  0,
  0xff, 0x00, 0xff, 0x40,
  0x00, 0xff, 0xff, 0xff,
])

function staticPng() {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngHeader(2, 2),
    pngChunk('IDAT', storedZlibStream(FIRST_PNG_SCANLINES)),
    pngChunk('IEND'),
  ])
}

function apngFrameControl(sequenceNumber) {
  return Buffer.concat([
    uint32BigEndian(sequenceNumber),
    uint32BigEndian(2),
    uint32BigEndian(2),
    uint32BigEndian(0),
    uint32BigEndian(0),
    uint16BigEndian(1),
    uint16BigEndian(5),
    Buffer.from([0, 0]),
  ])
}

function animatedPng() {
  const animationControl = Buffer.concat([
    uint32BigEndian(2),
    uint32BigEndian(0),
  ])
  return Buffer.concat([
    PNG_SIGNATURE,
    pngHeader(2, 2),
    pngChunk('acTL', animationControl),
    pngChunk('fcTL', apngFrameControl(0)),
    pngChunk('IDAT', storedZlibStream(FIRST_PNG_SCANLINES)),
    pngChunk('fcTL', apngFrameControl(1)),
    pngChunk('fdAT', Buffer.concat([
      uint32BigEndian(2),
      storedZlibStream(SECOND_PNG_SCANLINES),
    ])),
    pngChunk('IEND'),
  ])
}

function oversizedPngHeader() {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngHeader(100_000, 100_000),
    pngChunk('IEND'),
  ])
}

function corruptPngCrc(bytes) {
  const corrupt = Buffer.from(bytes)
  const ihdrCrcOffset = PNG_SIGNATURE.length + 4 + 4 + 13
  corrupt[ihdrCrcOffset] ^= 0xff
  return corrupt
}

function isoBox(type, data) {
  return Buffer.concat([
    uint32BigEndian(8 + data.length),
    Buffer.from(type, 'ascii'),
    data,
  ])
}

function avifHeader({ animated = false } = {}) {
  const majorBrand = animated ? 'avis' : 'avif'
  const compatibleBrands = animated
    ? ['avis', 'avif', 'mif1', 'miaf']
    : ['avif', 'mif1', 'miaf', 'MA1B']
  return isoBox(
    'ftyp',
    Buffer.concat([
      Buffer.from(majorBrand, 'ascii'),
      uint32BigEndian(0),
      ...compatibleBrands.map((brand) => Buffer.from(brand, 'ascii')),
    ]),
  )
}

function avifSpatialMetadata(width, height) {
  const spatialExtent = isoBox('ispe', Buffer.concat([
    Buffer.alloc(4),
    uint32BigEndian(width),
    uint32BigEndian(height),
  ]))
  return isoBox('meta', Buffer.concat([
    Buffer.alloc(4),
    isoBox('iprp', isoBox('ipco', spatialExtent)),
  ]))
}

function sniffFormat(bytes) {
  if (
    bytes.length >= PNG_SIGNATURE.length
    && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return 'png'
  }
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) {
    return 'jpeg'
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  if (
    bytes.length >= 16
    && bytes.subarray(4, 8).toString('ascii') === 'ftyp'
  ) {
    const boxSize = bytes.readUInt32BE(0)
    if (boxSize >= 16 && boxSize <= bytes.length) {
      const brands = [
        bytes.subarray(8, 12).toString('ascii'),
      ]
      for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
        brands.push(bytes.subarray(offset, offset + 4).toString('ascii'))
      }
      if (brands.includes('avif') || brands.includes('avis')) {
        return 'avif'
      }
    }
  }
  const gifSignature = bytes.subarray(0, 6).toString('ascii')
  if (gifSignature === 'GIF87a' || gifSignature === 'GIF89a') {
    return 'gif'
  }
  const textPrefix = bytes.subarray(0, 512).toString('utf8').trimStart()
  if (
    textPrefix.startsWith('<svg')
    || (
      textPrefix.startsWith('<?xml')
      && /<svg(?:\s|>)/u.test(textPrefix)
    )
  ) {
    return 'svg'
  }
  return 'unknown'
}

function inspectPng(bytes) {
  let offset = PNG_SIGNATURE.length
  let width = null
  let height = null
  let animationHint = false
  let hasImageData = false
  let hasEnd = false
  let truncated = false
  let crcMismatch = false

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      truncated = true
      break
    }
    const length = bytes.readUInt32BE(offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (chunkEnd > bytes.length) {
      truncated = true
      break
    }
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const data = bytes.subarray(dataStart, dataEnd)
    if (type === 'IHDR' && data.length === 13) {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'acTL') {
      animationHint = true
    } else if (type === 'IDAT') {
      hasImageData = true
    } else if (type === 'IEND') {
      hasEnd = true
    }
    const expectedCrc = crc32(bytes.subarray(offset + 4, dataEnd))
    if (bytes.readUInt32BE(dataEnd) !== expectedCrc) {
      crcMismatch = true
      break
    }
    offset = chunkEnd
    if (type === 'IEND') break
  }

  const status = crcMismatch
    ? 'corrupt-crc'
    : truncated || !hasEnd
      ? 'truncated'
      : hasImageData
        ? 'complete'
        : 'header-only'
  return {
    format: 'png',
    mimeType: 'image/png',
    width,
    height,
    animationHint,
    status,
  }
}

function isStartOfFrame(marker) {
  return (
    marker >= 0xc0
    && marker <= 0xcf
    && ![0xc4, 0xc8, 0xcc].includes(marker)
  )
}

function inspectJpeg(bytes) {
  let offset = 2
  let width = null
  let height = null
  let hasScan = false
  const hasEnd = (
    bytes.length >= 2
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9
  )

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    offset += 1
    if (marker === 0xda) {
      hasScan = true
      break
    }
    if (marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 2 > bytes.length) break
    const segmentLength = bytes.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break
    if (isStartOfFrame(marker) && segmentLength >= 7) {
      height = bytes.readUInt16BE(offset + 3)
      width = bytes.readUInt16BE(offset + 5)
    }
    offset += segmentLength
  }

  return {
    format: 'jpeg',
    mimeType: 'image/jpeg',
    width,
    height,
    animationHint: false,
    status: width !== null && height !== null && hasScan && hasEnd
      ? 'complete'
      : 'truncated',
  }
}

function inspectWebp(bytes) {
  let offset = 12
  let width = null
  let height = null
  let animationHint = false
  let hasStillPayload = false
  let truncated = bytes.readUInt32LE(4) + 8 !== bytes.length

  while (!truncated && offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      truncated = true
      break
    }
    const type = bytes.subarray(offset, offset + 4).toString('ascii')
    const length = bytes.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const paddedEnd = dataEnd + (length % 2)
    if (paddedEnd > bytes.length) {
      truncated = true
      break
    }
    const data = bytes.subarray(dataStart, dataEnd)
    if (type === 'VP8X' && data.length >= 10) {
      animationHint ||= (data[0] & 0x02) !== 0
      width = data.readUIntLE(4, 3) + 1
      height = data.readUIntLE(7, 3) + 1
    } else if (type === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
      width = 1 + data[1] + ((data[2] & 0x3f) << 8)
      height = 1
        + ((data[2] & 0xc0) >>> 6)
        + (data[3] << 2)
        + ((data[4] & 0x0f) << 10)
      hasStillPayload = true
    } else if (type === 'VP8 ') {
      hasStillPayload = true
    } else if (type === 'ANIM') {
      animationHint = true
    } else if (type === 'ANMF') {
      hasStillPayload = true
    }
    offset = paddedEnd
  }

  return {
    format: 'webp',
    mimeType: 'image/webp',
    width,
    height,
    animationHint,
    status: truncated
      ? 'truncated'
      : hasStillPayload
        ? 'complete'
        : 'header-only',
  }
}

function inspectAvif(bytes) {
  const boxSize = bytes.readUInt32BE(0)
  const majorBrand = bytes.subarray(8, 12).toString('ascii')
  const compatibleBrands = []
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    compatibleBrands.push(bytes.subarray(offset, offset + 4).toString('ascii'))
  }
  let width = null
  let height = null
  const ispe = bytes.indexOf(Buffer.from('ispe', 'ascii'))
  if (ispe >= 4) {
    const imageSpatialExtentsSize = bytes.readUInt32BE(ispe - 4)
    if (
      imageSpatialExtentsSize >= 20
      && ispe - 4 + imageSpatialExtentsSize <= bytes.length
    ) {
      width = bytes.readUInt32BE(ispe + 8)
      height = bytes.readUInt32BE(ispe + 12)
    }
  }
  return {
    format: 'avif',
    mimeType: 'image/avif',
    width,
    height,
    animationHint: (
      majorBrand === 'avis'
      || compatibleBrands.includes('avis')
    ),
    status: width !== null && height !== null && bytes.includes(
      Buffer.from('mdat', 'ascii'),
    )
      ? 'complete'
      : 'header-only',
    majorBrand,
    compatibleBrands,
  }
}

function inspectGif(bytes) {
  return {
    format: 'gif',
    mimeType: 'image/gif',
    width: bytes.length >= 10 ? bytes.readUInt16LE(6) : null,
    height: bytes.length >= 10 ? bytes.readUInt16LE(8) : null,
    animationHint: false,
    status: bytes[bytes.length - 1] === 0x3b ? 'complete' : 'truncated',
  }
}

function inspectFixture(bytes) {
  const format = sniffFormat(bytes)
  if (format === 'png') return inspectPng(bytes)
  if (format === 'jpeg') return inspectJpeg(bytes)
  if (format === 'webp') return inspectWebp(bytes)
  if (format === 'avif') return inspectAvif(bytes)
  if (format === 'gif') return inspectGif(bytes)
  if (format === 'svg') {
    return {
      format: 'svg',
      mimeType: 'image/svg+xml',
      width: null,
      height: null,
      animationHint: false,
      status: 'textual',
    }
  }
  return {
    format: 'unknown',
    mimeType: null,
    width: null,
    height: null,
    animationHint: false,
    status: 'unknown',
  }
}

const validPng = staticPng()
const corruptPng = corruptPngCrc(validPng)
const orientedJpeg = jpegWithExifOrientation(ORIENTABLE_JPEG, 6)
const jpegScanOffset = STATIC_JPEG.indexOf(Buffer.from([0xff, 0xda]))
if (jpegScanOffset < 0) throw new Error('Static JPEG is missing its scan marker')

const fixtures = [
  {
    name: 'valid-rgba-2x2.png',
    purpose: 'Valid compact PNG with opaque and translucent RGBA pixels.',
    declaredMimeType: 'image/png',
    expectedImportOutcome: 'ready',
    bytes: validPng,
    expectedInspection: {
      format: 'png',
      mimeType: 'image/png',
      width: 2,
      height: 2,
      animationHint: false,
      status: 'complete',
    },
  },
  {
    name: 'valid-2x2.jpg',
    purpose: 'Valid compact baseline JPEG.',
    declaredMimeType: 'image/jpeg',
    expectedImportOutcome: 'ready',
    bytes: STATIC_JPEG,
    expectedInspection: {
      format: 'jpeg',
      mimeType: 'image/jpeg',
      width: 2,
      height: 2,
      animationHint: false,
      status: 'complete',
    },
  },
  {
    name: 'exif-rotated-4x2.jpg',
    purpose: 'Asymmetric red/blue JPEG whose EXIF orientation rotates display dimensions to 2x4.',
    declaredMimeType: 'image/jpeg',
    expectedImportOutcome: 'ready-oriented-2x4',
    bytes: orientedJpeg,
    expectedInspection: {
      format: 'jpeg',
      mimeType: 'image/jpeg',
      width: 4,
      height: 2,
      animationHint: false,
      status: 'complete',
    },
  },
  {
    name: 'valid-2x2.webp',
    purpose: 'Valid compact lossless WebP.',
    declaredMimeType: 'image/webp',
    expectedImportOutcome: 'ready',
    bytes: STATIC_WEBP,
    expectedInspection: {
      format: 'webp',
      mimeType: 'image/webp',
      width: 2,
      height: 2,
      animationHint: false,
      status: 'complete',
    },
  },
  {
    name: 'valid-2x2.avif',
    purpose: 'Valid compact AVIF for conditional browser decode support.',
    declaredMimeType: 'image/avif',
    expectedImportOutcome: 'ready-where-supported',
    bytes: STATIC_AVIF,
    expectedInspection: {
      format: 'avif',
      mimeType: 'image/avif',
      width: 2,
      height: 2,
      animationHint: false,
      status: 'complete',
      majorBrand: 'avif',
      compatibleBrands: ['avif', 'mif1', 'miaf', 'MA1B'],
    },
  },
  {
    name: 'truncated-avif-header.avif',
    purpose: 'AVIF ftyp brands without image payload; content recognition must precede decode rejection.',
    declaredMimeType: 'image/avif',
    expectedImportOutcome: 'malformed-image',
    bytes: avifHeader(),
    expectedInspection: {
      format: 'avif',
      mimeType: 'image/avif',
      width: null,
      height: null,
      animationHint: false,
      status: 'header-only',
      majorBrand: 'avif',
      compatibleBrands: ['avif', 'mif1', 'miaf', 'MA1B'],
    },
  },
  {
    name: 'spoofed-png.jpg',
    purpose: 'PNG bytes under a JPEG filename and declared MIME type.',
    declaredMimeType: 'image/jpeg',
    expectedImportOutcome: 'ready-as-png',
    bytes: validPng,
    expectedInspection: {
      format: 'png',
      mimeType: 'image/png',
      width: 2,
      height: 2,
      animationHint: false,
      status: 'complete',
    },
  },
  {
    name: 'corrupt-crc.png',
    purpose: 'Recognizable PNG with a deliberately invalid IHDR CRC.',
    declaredMimeType: 'image/png',
    expectedImportOutcome: 'decode-error',
    bytes: corruptPng,
    expectedInspection: {
      format: 'png',
      mimeType: 'image/png',
      width: 2,
      height: 2,
      animationHint: false,
      status: 'corrupt-crc',
    },
  },
  {
    name: 'truncated.jpg',
    purpose: 'Recognizable JPEG truncated immediately before its scan.',
    declaredMimeType: 'image/jpeg',
    expectedImportOutcome: 'decode-error',
    bytes: STATIC_JPEG.subarray(0, jpegScanOffset),
    expectedInspection: {
      format: 'jpeg',
      mimeType: 'image/jpeg',
      width: 2,
      height: 2,
      animationHint: false,
      status: 'truncated',
    },
  },
  {
    name: 'oversize-header.png',
    purpose: 'Compact PNG header advertising a hostile 100000x100000 canvas.',
    declaredMimeType: 'image/png',
    expectedImportOutcome: 'resource-limit',
    bytes: oversizedPngHeader(),
    expectedInspection: {
      format: 'png',
      mimeType: 'image/png',
      width: 100_000,
      height: 100_000,
      animationHint: false,
      status: 'header-only',
    },
  },
  {
    name: 'unsupported.svg',
    purpose: 'Benign SVG text that must be rejected without DOM parsing or injection.',
    declaredMimeType: 'image/svg+xml',
    expectedImportOutcome: 'unsupported-svg',
    bytes: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>\n',
      'utf8',
    ),
    expectedInspection: {
      format: 'svg',
      mimeType: 'image/svg+xml',
      width: null,
      height: null,
      animationHint: false,
      status: 'textual',
    },
  },
  {
    name: 'unsupported.gif',
    purpose: 'Valid compact GIF that must be rejected by the still-image allowlist.',
    declaredMimeType: 'image/gif',
    expectedImportOutcome: 'unsupported-gif',
    bytes: Buffer.from(
      '47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b',
      'hex',
    ),
    expectedInspection: {
      format: 'gif',
      mimeType: 'image/gif',
      width: 1,
      height: 1,
      animationHint: false,
      status: 'complete',
    },
  },
  {
    name: 'animated-2x2.webp',
    purpose: 'Valid compact animated WebP with two frames.',
    declaredMimeType: 'image/webp',
    expectedImportOutcome: 'ready-first-frame',
    bytes: ANIMATED_WEBP,
    expectedInspection: {
      format: 'webp',
      mimeType: 'image/webp',
      width: 2,
      height: 2,
      animationHint: true,
      status: 'complete',
    },
  },
  {
    name: 'animated-2x2.png',
    purpose: 'Valid compact APNG with two frames and an infinite loop.',
    declaredMimeType: 'image/png',
    expectedImportOutcome: 'ready-first-frame',
    bytes: animatedPng(),
    expectedInspection: {
      format: 'png',
      mimeType: 'image/png',
      width: 2,
      height: 2,
      animationHint: true,
      status: 'complete',
    },
  },
  {
    name: 'animated-avif-header.avif',
    purpose: 'AVIF sequence ftyp brands without image payload.',
    declaredMimeType: 'image/avif',
    expectedImportOutcome: 'decode-error',
    bytes: Buffer.concat([
      avifHeader({ animated: true }),
      avifSpatialMetadata(2, 2),
    ]),
    expectedInspection: {
      format: 'avif',
      mimeType: 'image/avif',
      width: 2,
      height: 2,
      animationHint: true,
      status: 'header-only',
      majorBrand: 'avis',
      compatibleBrands: ['avis', 'avif', 'mif1', 'miaf'],
    },
  },
]

const arguments_ = process.argv.slice(2)
const validateOnly = arguments_.includes('--validate-only')
const outputArguments = arguments_.filter((argument) => argument !== '--validate-only')
if (outputArguments.length > 1) {
  throw new Error('Usage: generate-fixtures.mjs [--validate-only] [output-directory]')
}
const outputDirectory = resolve(
  outputArguments[0] ?? '.tmp/issue-18-image-fixtures',
)
const usesDefaultOutputDirectory = outputArguments.length === 0
const expectedOutputNames = new Set([
  ...fixtures.map((fixture) => fixture.name),
  'manifest.json',
])

if (!validateOnly) {
  mkdirSync(outputDirectory, { recursive: true })
  for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
    if (expectedOutputNames.has(entry.name)) continue
    assert(
      usesDefaultOutputDirectory && entry.isFile(),
      `Refusing to remove unexpected output entry ${entry.name}`,
    )
    unlinkSync(resolve(outputDirectory, entry.name))
  }
  for (const fixture of fixtures) {
    writeFileSync(resolve(outputDirectory, fixture.name), fixture.bytes)
  }
}

const manifestEntries = fixtures.map((fixture) => {
  const fixturePath = resolve(outputDirectory, fixture.name)
  const bytes = readFileSync(fixturePath)
  assert.deepStrictEqual(
    bytes,
    fixture.bytes,
    `${fixture.name}: generated bytes drifted from the deterministic definition`,
  )
  const inspection = inspectFixture(bytes)
  assert.deepStrictEqual(
    inspection,
    fixture.expectedInspection,
    `${fixture.name}: structural inspection did not match the matrix`,
  )
  return {
    name: fixture.name,
    purpose: fixture.purpose,
    declaredMimeType: fixture.declaredMimeType,
    expectedImportOutcome: fixture.expectedImportOutcome,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    inspection,
  }
})

const manifest = {
  schemaVersion: 1,
  generator: 'scripts/issue18/generate-fixtures.mjs',
  fixtures: manifestEntries,
}
const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
const manifestPath = resolve(outputDirectory, 'manifest.json')
if (validateOnly) {
  assert.equal(
    readFileSync(manifestPath, 'utf8'),
    manifestJson,
    'manifest.json drifted from the deterministic fixture matrix',
  )
} else {
  writeFileSync(manifestPath, manifestJson)
}

const outputEntries = readdirSync(outputDirectory, { withFileTypes: true })
for (const entry of outputEntries) {
  assert(entry.isFile(), `Unexpected non-file output entry ${entry.name}`)
}
assert.deepStrictEqual(
  outputEntries.map((entry) => entry.name).sort(),
  [...expectedOutputNames].sort(),
  'Fixture directory contains missing or unexpected entries',
)

console.log(
  `${validateOnly ? 'Validated' : 'Generated and validated'} ${fixtures.length} Issue #18 fixtures in ${outputDirectory}`,
)
for (const entry of manifestEntries) {
  console.log(
    `${entry.name.padEnd(30)} ${String(entry.bytes).padStart(5)} bytes  ${entry.inspection.status.padEnd(11)} ${entry.expectedImportOutcome}`,
  )
}
