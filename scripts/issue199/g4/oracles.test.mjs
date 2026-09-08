import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SAMPLE_FRAMES, verifyEncoded, verifyDrained } from './oracles.mjs'
const emptyAdmission = () => ({ essentialOwners: 0, monitorOwners: 0, decoderSlots: 0, surfaceBytes: 0, blockers: [] })
test('final drain accepts zero reservations and blockers', () => verifyDrained(emptyAdmission()))
for (const field of ['essentialOwners', 'monitorOwners', 'decoderSlots', 'surfaceBytes', 'blockers']) test(`final drain rejects retained ${field}`, () => {
  const snapshot = emptyAdmission(); snapshot[field] = field === 'blockers' ? ['export'] : 1
  assert.throws(() => verifyDrained(snapshot))
})
function passing() { return { size: 2000, width: 1280, height: 720, duration: 1, videoDuration: 1, videoCodec: 'vp9', audioCodec: 'opus', videoPackets: { packetCount: 30, averagePacketRate: 30 }, packetTimeline: Array.from({ length: 30 }, (_, i) => ({ timestamp: i / 30, duration: 1 / 30 })),
  frames: SAMPLE_FRAMES.map((frame) => ({ frame, timestamp: frame / 30, rgbMeanError: 1, rgbP95Error: 4, rawGlyph: { count: frame === 0 || frame === 29 ? 0 : 500, x: 1200 - frame * 35, y: 360 }, decodedGlyph: { count: frame === 0 || frame === 29 ? 0 : 500, x: 1200 - frame * 35, y: 360 } })),
  pcm: { through: 48000, early: [0.02, 0.0001], late: [0.0001, 0.06] } } }
test('mixed oracle accepts its declared lossy envelope', () => verifyEncoded(passing()))
for (const fault of ['missing glyph', 'stationary crawl', 'wrong gain', 'wrong pan', 'missing PCM', 'wrong fps', 'duplicate packet', 'missing packet', 'RGB mismatch']) test(`mixed oracle rejects ${fault}`, () => {
  const r = passing()
  if (fault === 'missing glyph') r.frames[2].decodedGlyph.count = 0
  if (fault === 'stationary crawl') r.frames[4].decodedGlyph.x = r.frames[1].decodedGlyph.x
  if (fault === 'wrong gain') r.pcm.late[1] = 0.02
  if (fault === 'wrong pan') r.pcm.early[1] = 0.02
  if (fault === 'missing PCM') r.pcm.through = 47000
  if (fault === 'wrong fps') r.packetTimeline.forEach((p, i) => { p.timestamp = i / 29.9 })
  if (fault === 'duplicate packet') r.packetTimeline[14].timestamp = r.packetTimeline[13].timestamp
  if (fault === 'missing packet') r.packetTimeline.pop()
  if (fault === 'RGB mismatch') r.frames[0].rgbMeanError = 9
  assert.throws(() => verifyEncoded(r))
})
test('30 fps cadence accepts the recorded millisecond WebM timestamps despite the packet-extent rate estimate', () => {
  const r = passing()
  r.packetTimeline.forEach((p) => { p.timestamp = Math.round(p.timestamp * 1000) / 1000 })
  r.packetTimeline.at(-1).duration = 0.033333333
  r.videoPackets.averagePacketRate = 30 / (r.packetTimeline.at(-1).timestamp + r.packetTimeline.at(-1).duration)
  assert.ok(Math.abs(r.videoPackets.averagePacketRate - 30) > 0.001)
  verifyEncoded(r)
})
