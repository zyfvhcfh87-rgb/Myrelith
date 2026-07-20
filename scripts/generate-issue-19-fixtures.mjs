import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
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

function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
writeFileSync(path('empty.mp4'), Buffer.alloc(0))
writeFileSync(
  path('random-bytes.mp4'),
  Buffer.from('WebCut issue 19: deliberately not a media container.\n', 'utf8'),
)

const fixtureNames = [
  'avc-aac.mp4',
  'vp9-opus.webm',
  'avc-ac3.mkv',
  'avc-eac3.mkv',
  'hevc-aac.mp4',
  'av1-opus.webm',
  'spoofed-vp9.mp4',
  'unknown-codec.mp4',
  'malformed-avc-config.mp4',
  'truncated-faststart.mp4',
  'truncated-before-moov.mp4',
  'empty.mp4',
  'random-bytes.mp4',
]
const probeEntries = fixtureNames.map((name) => {
  const bytes = readFileSync(path(name))
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries',
    'format=format_name,duration,size:stream=index,codec_type,codec_name,codec_tag_string,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json',
    path(name),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ffprobeStatus: result.status,
    ffprobe: result.status === 0 ? JSON.parse(result.stdout) : undefined,
    ffprobeError: result.status === 0 ? undefined : result.stderr.trim(),
  }
})
const ffmpegVersion = run('ffmpeg', ['-version']).split(/\r?\n/, 1)[0]
writeFileSync(
  path('manifest.json'),
  `${JSON.stringify({ ffmpegVersion, fixtures: probeEntries }, null, 2)}\n`,
)

console.log(`Generated ${fixtureNames.length} fixtures in ${outputDirectory}`)
for (const entry of probeEntries) {
  console.log(`${entry.name.padEnd(30)} ${String(entry.bytes).padStart(8)} bytes  ${entry.ffprobeStatus === 0 ? 'probe-ok' : 'probe-failed-as-designed'}`)
}
