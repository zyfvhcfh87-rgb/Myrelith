import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const outputDirectory = resolve(
  process.argv[2] ?? '.tmp/issue-19-codec-fixtures',
)
mkdirSync(outputDirectory, { recursive: true })

const videoSource = 'color=c=0x315b7d:s=320x180:r=30:d=2'
const audioSource = 'sine=frequency=880:sample_rate=48000:duration=2'
const commonInput = [
  '-f', 'lavfi', '-i', videoSource,
  '-f', 'lavfi', '-i', audioSource,
  '-shortest', '-threads', '2',
]

function path(name) {
  return resolve(outputDirectory, name)
}

function spawn(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    throw new Error(`${program} could not start: ${result.error.message}`)
  }
  if (result.status === null) {
    throw new Error(`${program} exited without a status`)
  }
  return result
}

function run(program, args) {
  const result = spawn(program, args)
  if (result.status !== 0) {
    throw new Error(
      `${program} failed (${result.status ?? 'no status'}):\n${result.stderr}`,
    )
  }
  return result.stdout
}

function ffmpeg(name, outputArgs) {
  run('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...commonInput,
    ...outputArgs,
    path(name),
  ])
}

function findAscii(buffer, value, from = 0) {
  return buffer.indexOf(Buffer.from(value, 'ascii'), from)
}

function replaceAscii(buffer, offset, expected, replacement) {
  const actual = buffer.subarray(offset, offset + expected.length).toString('ascii')
  if (actual !== expected || expected.length !== replacement.length) {
    throw new Error(`Expected ${expected} at byte ${offset}, found ${actual}`)
  }
  buffer.write(replacement, offset, 'ascii')
}

ffmpeg('avc-aac.mp4', [
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
])
ffmpeg('avc-aac-tail-moov.mp4', [
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k',
])
ffmpeg('vp9-opus.webm', [
  '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
  '-b:v', '300k', '-c:a', 'libopus', '-b:a', '64k',
])
ffmpeg('avc-ac3.mkv', [
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'ac3', '-b:a', '192k',
])
ffmpeg('avc-eac3.mkv', [
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'eac3', '-b:a', '192k',
])
ffmpeg('hevc-aac.mp4', [
  '-c:v', 'libx265', '-preset', 'ultrafast',
  '-x265-params', 'log-level=error:pools=1:frame-threads=1',
  '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
])
ffmpeg('av1-opus.webm', [
  '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '40', '-b:v', '0',
  '-c:a', 'libopus', '-b:a', '64k',
])

copyFileSync(path('vp9-opus.webm'), path('spoofed-vp9.mp4'))

const faststart = readFileSync(path('avc-aac.mp4'))
const firstAvc1 = findAscii(faststart, 'avc1')
const sampleEntryAvc1 = findAscii(faststart, 'avc1', firstAvc1 + 4)
if (firstAvc1 < 0 || sampleEntryAvc1 < 0) {
  throw new Error('Could not locate both AVC brand and sample-entry tags')
}
const unknownCodec = Buffer.from(faststart)
replaceAscii(unknownCodec, sampleEntryAvc1, 'avc1', 'zzzz')
writeFileSync(path('unknown-codec.mp4'), unknownCodec)

const avcConfig = findAscii(faststart, 'avcC')
if (avcConfig < 0) throw new Error('Could not locate the AVC configuration box')
const malformedConfig = Buffer.from(faststart)
replaceAscii(malformedConfig, avcConfig, 'avcC', 'zzzz')
writeFileSync(path('malformed-avc-config.mp4'), malformedConfig)

writeFileSync(
  path('truncated-faststart.mp4'),
  faststart.subarray(0, Math.floor(faststart.length / 2)),
)
const tailMoov = readFileSync(path('avc-aac-tail-moov.mp4'))
const tailMoovTag = findAscii(tailMoov, 'moov')
if (tailMoovTag < 4) throw new Error('Could not locate the tail moov box')
writeFileSync(
  path('truncated-before-moov.mp4'),
  tailMoov.subarray(0, tailMoovTag - 4),
)
rmSync(path('avc-aac-tail-moov.mp4'))
writeFileSync(path('empty.mp4'), Buffer.alloc(0))
writeFileSync(
  path('random-bytes.mp4'),
  Buffer.from('WebCut issue 19: deliberately not a media container.\n', 'utf8'),
)

const fixtureMatrix = [
  {
    name: 'avc-aac.mp4',
    format: 'mov',
    streams: [
      { kind: 'video', codec: 'h264', tag: 'avc1' },
      { kind: 'audio', codec: 'aac', tag: 'mp4a' },
    ],
  },
  {
    name: 'vp9-opus.webm',
    format: 'matroska',
    streams: [
      { kind: 'video', codec: 'vp9' },
      { kind: 'audio', codec: 'opus' },
    ],
  },
  {
    name: 'avc-ac3.mkv',
    format: 'matroska',
    streams: [
      { kind: 'video', codec: 'h264' },
      { kind: 'audio', codec: 'ac3' },
    ],
  },
  {
    name: 'avc-eac3.mkv',
    format: 'matroska',
    streams: [
      { kind: 'video', codec: 'h264' },
      { kind: 'audio', codec: 'eac3' },
    ],
  },
  {
    name: 'hevc-aac.mp4',
    format: 'mov',
    streams: [
      { kind: 'video', codec: 'hevc', tag: 'hvc1' },
      { kind: 'audio', codec: 'aac', tag: 'mp4a' },
    ],
  },
  {
    name: 'av1-opus.webm',
    format: 'matroska',
    streams: [
      { kind: 'video', codec: 'av1' },
      { kind: 'audio', codec: 'opus' },
    ],
  },
  {
    name: 'spoofed-vp9.mp4',
    format: 'matroska',
    streams: [
      { kind: 'video', codec: 'vp9' },
      { kind: 'audio', codec: 'opus' },
    ],
  },
  {
    name: 'unknown-codec.mp4',
    format: 'mov',
    streams: [
      { kind: 'video', codec: null, tag: 'zzzz' },
      { kind: 'audio', codec: 'aac', tag: 'mp4a' },
    ],
  },
  { name: 'malformed-avc-config.mp4', expectProbeFailure: true },
  {
    name: 'truncated-faststart.mp4',
    format: 'mov',
    streams: [
      { kind: 'video', codec: 'h264', tag: 'avc1' },
      { kind: 'audio', codec: 'aac', tag: 'mp4a' },
    ],
  },
  { name: 'truncated-before-moov.mp4', expectProbeFailure: true },
  { name: 'empty.mp4', expectProbeFailure: true },
  { name: 'random-bytes.mp4', expectProbeFailure: true },
]

function assertStream(name, actual, expected, index) {
  if (!actual) throw new Error(`${name}: missing stream ${index}`)
  if (actual.codec_type !== expected.kind) {
    throw new Error(
      `${name}: stream ${index} is ${actual.codec_type}, expected ${expected.kind}`,
    )
  }
  if ((actual.codec_name ?? null) !== expected.codec) {
    throw new Error(
      `${name}: ${expected.kind} codec is ${actual.codec_name ?? 'unknown'}, expected ${expected.codec ?? 'unknown'}`,
    )
  }
  if (expected.tag && actual.codec_tag_string !== expected.tag) {
    throw new Error(
      `${name}: ${expected.kind} tag is ${actual.codec_tag_string ?? 'missing'}, expected ${expected.tag}`,
    )
  }
  if (expected.kind === 'video') {
    if (
      actual.width !== 320
      || actual.height !== 180
      || actual.r_frame_rate !== '30/1'
    ) {
      throw new Error(
        `${name}: video geometry/rate is ${actual.width}x${actual.height} at ${actual.r_frame_rate}, expected 320x180 at 30/1`,
      )
    }
  } else if (actual.sample_rate !== '48000' || actual.channels !== 1) {
    throw new Error(
      `${name}: audio is ${actual.sample_rate} Hz/${actual.channels} channels, expected 48000 Hz/1 channel`,
    )
  }
}

function validateProbe(expectation, result) {
  if (expectation.expectProbeFailure) {
    if (result.status === 0) {
      throw new Error(
        `${expectation.name}: ffprobe unexpectedly accepted a deliberately damaged fixture`,
      )
    }
    return undefined
  }
  if (result.status !== 0) {
    throw new Error(
      `${expectation.name}: ffprobe failed (${result.status}):\n${result.stderr}`,
    )
  }

  let probe
  try {
    probe = JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(
      `${expectation.name}: ffprobe returned invalid JSON`,
      { cause },
    )
  }
  const formats = String(probe.format?.format_name ?? '').split(',')
  if (!formats.includes(expectation.format)) {
    throw new Error(
      `${expectation.name}: container is ${formats.join(',') || 'unknown'}, expected ${expectation.format}`,
    )
  }
  const streams = probe.streams ?? []
  if (streams.length !== expectation.streams.length) {
    throw new Error(
      `${expectation.name}: found ${streams.length} streams, expected ${expectation.streams.length}`,
    )
  }
  expectation.streams.forEach((expected, index) => {
    assertStream(expectation.name, streams[index], expected, index)
  })
  return probe
}

const probeEntries = fixtureMatrix.map((expectation) => {
  const bytes = readFileSync(path(expectation.name))
  const result = spawn('ffprobe', [
    '-v', 'error',
    '-show_entries',
    'format=format_name,duration,size:stream=index,codec_type,codec_name,codec_tag_string,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json',
    path(expectation.name),
  ])
  const probe = validateProbe(expectation, result)
  return {
    name: expectation.name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ffprobeStatus: result.status,
    ffprobe: probe,
    ffprobeError: result.status === 0 ? undefined : result.stderr.trim(),
  }
})
const ffmpegVersion = run('ffmpeg', ['-version']).split(/\r?\n/, 1)[0]
writeFileSync(
  path('manifest.json'),
  `${JSON.stringify({ ffmpegVersion, fixtures: probeEntries }, null, 2)}\n`,
)

console.log(`Generated and validated ${fixtureMatrix.length} fixtures in ${outputDirectory}`)
for (const entry of probeEntries) {
  console.log(`${entry.name.padEnd(30)} ${String(entry.bytes).padStart(8)} bytes  ${entry.ffprobeStatus === 0 ? 'probe-ok' : 'probe-failed-as-designed'}`)
}
