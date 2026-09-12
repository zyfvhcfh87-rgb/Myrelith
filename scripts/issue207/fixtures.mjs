/** Deterministic Issue #207 fixtures. Bytes stay under .tmp; git stores hashes only. */

import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const VIDEO = 'color=c=0x315b7d:s=320x180:r=30:d=1'
const AUDIO = 'anullsrc=channel_layout=mono:sample_rate=48000'

export function fixtureDirectory(root = process.cwd()) {
  return resolve(root, '.tmp/issue207/fixtures')
}

function spawn(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    throw new Error(`${program} could not start: ${result.error.message}`)
  }
  return result
}

function run(program, args) {
  const result = spawn(program, args)
  if (result.status !== 0) {
    throw new Error(`${program} failed (${result.status}):\n${result.stderr}`)
  }
  return result.stdout
}

function ffmpeg(output, args) {
  run('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...args,
    output,
  ])
}

function commonAv(output, extra) {
  ffmpeg(output, [
    '-f', 'lavfi', '-i', VIDEO,
    '-f', 'lavfi', '-i', AUDIO,
    '-t', '1', '-shortest', '-threads', '2',
    ...extra,
  ])
}

function audioOnly(output, extra) {
  ffmpeg(output, [
    '-f', 'lavfi', '-i', AUDIO,
    '-t', '1',
    ...extra,
  ])
}

export function generateFixtures(outputDirectory = fixtureDirectory()) {
  mkdirSync(outputDirectory, { recursive: true })
  const path = (name) => resolve(outputDirectory, name)

  audioOnly(path('pcm-s16.wav'), ['-c:a', 'pcm_s16le'])
  audioOnly(path('mp3.mp3'), ['-c:a', 'libmp3lame', '-b:a', '64k'])
  audioOnly(path('flac.flac'), ['-c:a', 'flac'])
  audioOnly(path('vorbis.ogg'), ['-c:a', 'libvorbis', '-b:a', '64k'])

  commonAv(path('avc-aac.mp4'), [
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
  ])
  commonAv(path('avc-aac.mov'), [
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k',
  ])
  commonAv(path('avc-aac.ts'), [
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-f', 'mpegts',
  ])
  commonAv(path('vp9-opus.webm'), [
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k',
    '-c:a', 'libopus', '-b:a', '48k',
  ])
  commonAv(path('vp8-opus.webm'), [
    '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k',
    '-c:a', 'libopus', '-b:a', '48k',
  ])
  commonAv(path('av1-opus.webm'), [
    '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '40', '-b:v', '0',
    '-c:a', 'libopus', '-b:a', '48k',
  ])
  commonAv(path('hevc-aac.mp4'), [
    '-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'log-level=error:pools=1:frame-threads=1',
    '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
  ])
  commonAv(path('avc-ac3.mkv'), [
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', '-b:a', '96k',
  ])
  commonAv(path('prores.mov'), [
    '-c:v', 'prores_ks', '-profile:v', '0',
    '-c:a', 'pcm_s16le',
  ])
  commonAv(path('mpeg2-aac.ts'), [
    '-c:v', 'mpeg2video', '-q:v', '8',
    '-c:a', 'aac', '-b:a', '64k', '-f', 'mpegts',
  ])

  const dts = spawn('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', VIDEO,
    '-f', 'lavfi', '-i', AUDIO,
    '-t', '1', '-shortest', '-threads', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'dca', '-strict', '-2', '-b:a', '192k',
    path('avc-dts.mkv'),
  ])
  if (dts.status !== 0) {
    throw new Error(`DTS fixture failed:\n${dts.stderr}`)
  }

  const mxfArgs = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x315b7d:s=1920x1080:r=30:d=1',
    '-c:v', 'dnxhd', '-b:v', '36M', '-pix_fmt', 'yuv422p',
    path('dnx-or-mpeg2.mxf'),
  ]
  let mxf = spawn('ffmpeg', mxfArgs)
  if (mxf.status !== 0) {
    mxf = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', VIDEO,
      '-t', '1',
      '-c:v', 'mpeg2video', '-q:v', '8',
      '-f', 'mxf',
      path('dnx-or-mpeg2.mxf'),
    ])
  }
  if (mxf.status !== 0) {
    throw new Error(`MXF fixture failed:\n${mxf.stderr}`)
  }

  writeFileSync(
    path('playlist.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nsegment.ts\n#EXT-X-ENDLIST\n',
  )
  writeFileSync(
    path('not-media.braw'),
    Buffer.from('Myrelith issue 207: not a Blackmagic RAW container.\n', 'utf8'),
  )

  const names = [
    'pcm-s16.wav', 'mp3.mp3', 'flac.flac', 'vorbis.ogg',
    'avc-aac.mp4', 'avc-aac.mov', 'avc-aac.ts',
    'vp9-opus.webm', 'vp8-opus.webm', 'av1-opus.webm',
    'hevc-aac.mp4', 'avc-ac3.mkv', 'prores.mov',
    'mpeg2-aac.ts', 'avc-dts.mkv', 'dnx-or-mpeg2.mxf',
    'playlist.m3u8', 'not-media.braw',
  ]
  const ffmpegVersion = run('ffmpeg', ['-version']).split(/\r?\n/, 1)[0]
  const fixtures = names.map((name) => {
    const bytes = readFileSync(path(name))
    return {
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })
  const manifest = { ffmpegVersion, fixtures }
  writeFileSync(path('manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { outputDirectory, ffmpegVersion, fixtures }
}
