import assert from 'node:assert/strict'
export const SAMPLE_FRAMES = [0, 7, 14, 15, 22, 29]
export const LIMITS = Object.freeze({ rgbMean: 8, rgbP95: 20, glyphCentroidPixels: 3, glyphCoverageFraction: 0.15, silenceRms: 0.002, gainRatioRelative: 0.08 })
export function verifyDrained(admission) {
  for (const field of ['essentialOwners', 'monitorOwners', 'decoderSlots', 'surfaceBytes']) assert.equal(admission[field], 0, `Final media admission retains ${field}`)
  assert.deepEqual(admission.blockers, [], 'Final media admission retains blockers')
}
export function verifyEncoded(result) {
  assert.ok(result.size > 1000); assert.equal(result.width, 1280); assert.equal(result.height, 720)
  assert.ok(Math.abs(result.duration - 1) <= 0.03); assert.ok(Math.abs(result.videoDuration - 1) <= 1 / 30000)
  assert.equal(result.videoCodec, 'vp9'); assert.equal(result.audioCodec, 'opus')
  assert.equal(result.videoPackets.packetCount, 30); assert.equal(result.packetTimeline.length, 30)
  for (const [frame, packet] of result.packetTimeline.entries()) {
    assert.ok(Math.abs(packet.timestamp - frame / 30) <= 0.001, `Packet ${frame} differs from the 30 fps cadence`)
    assert.ok(Number.isFinite(packet.duration) && packet.duration > 0, 'Invalid packet duration')
  }
  assert.deepEqual(result.frames.map((f) => f.frame), SAMPLE_FRAMES)
  for (const row of result.frames) {
    assert.ok(Math.abs(row.timestamp - row.frame / 30) <= 0.001, 'Decoded timestamp differs from selected frame')
    assert.ok(row.rgbMeanError <= LIMITS.rgbMean, `frame ${row.frame}: RGB mean ${row.rgbMeanError}`)
    assert.ok(row.rgbP95Error <= LIMITS.rgbP95, `frame ${row.frame}: RGB p95 ${row.rgbP95Error}`)
    if (row.frame === 0 || row.frame === 29) {
      assert.equal(row.rawGlyph.count, 0, 'Generated crawl boundary should be outside the canvas')
      assert.equal(row.decodedGlyph.count, 0, 'Encoded crawl boundary unexpectedly has white glyph pixels')
    } else {
      assert.ok(row.rawGlyph.count > 40 && row.decodedGlyph.count > 40, 'Interior glyph absent')
      assert.ok(Math.abs(row.decodedGlyph.count / row.rawGlyph.count - 1) <= LIMITS.glyphCoverageFraction, 'Encoded glyph coverage differs')
      for (const axis of ['x', 'y']) assert.ok(Math.abs(row.rawGlyph[axis] - row.decodedGlyph[axis]) <= LIMITS.glyphCentroidPixels, `Encoded glyph ${axis} placement differs`)
    }
  }
  assert.ok(result.frames[1].decodedGlyph.x - result.frames[4].decodedGlyph.x > 100, 'Crawl did not move left across interior frames')
  assert.equal(result.pcm.through, 48000, 'Encoded PCM coverage is incomplete')
  assert.ok(result.pcm.early[1] <= LIMITS.silenceRms && result.pcm.late[0] <= LIMITS.silenceRms, 'Held balance did not silence the opposite channel')
  const early = result.pcm.early[0], late = result.pcm.late[1]
  assert.ok(early > 0.005 && late < 0.15, 'PCM active channel missing or excessive')
  assert.ok(Math.abs(late / early / 3 - 1) <= LIMITS.gainRatioRelative, `PCM gain ratio ${late / early}`)
}
