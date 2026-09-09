// Actual Relink DOM path; stores below are read-only diagnostic observations.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@playwright/test'

export async function relinkGestureAudio(q) {
  const { page, fixtureRoot, settled, report } = q
  const directory = join(fixtureRoot, 'playback')
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.productSource, report.productSource)
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(join(directory, name))
    assert.equal(bytes.length, expected.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256)
  }
  await q.remember('playback-relink-setup')
  const row = page.locator('[data-media-id="audio-asset"]')
  await expect(row).toHaveAttribute('data-connection', 'offline')
  await row.getByLabel(/^Relink silent-offline\.wav(?: once)?$/).setInputFiles(join(directory, 'silent-offline.wav'))
  await expect(row).toHaveAttribute('data-connection', 'online', { timeout: 30000 })
  await expect(page.getByRole('region', { name: 'Media relink status' })).toContainText('1 connected')
  await settled()
  const connected = await page.evaluate(() => {
    const q = window.__animationQA, media = q.media.getState(), asset = media.assets.get('audio-asset')
    const audioClip = q.document.getState().doc.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'ordinary-audio')
    return {
      asset: asset ? { id: asset.id, kind: asset.kind, size: asset.size, durationMicroseconds: asset.durationMicroseconds, hasAudio: asset.hasAudio, audioSampleRate: asset.audioSampleRate, audioChannels: asset.audioChannels, sourceBounds: asset.sourceBounds, localBlob: asset.objectUrl.startsWith('blob:') } : null,
      connectedAssetIds: [...media.assets.keys()].sort(),
      audioClip: { id: audioClip.id, assetId: audioClip.assetId, enabled: audioClip.audio.enabled, volume: audioClip.volume },
    }
  })
  assert.deepEqual(connected, {
    asset: { id: 'audio-asset', kind: 'audio', size: manifest.files['silent-offline.wav'].bytes, durationMicroseconds: 30000000, hasAudio: true, audioSampleRate: 48000, audioChannels: 2, sourceBounds: { video: null, audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 30000000 } }, localBlob: true },
    connectedAssetIds: ['audio-asset'],
    audioClip: { id: 'ordinary-audio', assetId: 'audio-asset', enabled: true, volume: 1 },
  })
  await q.unchanged('playback-relink-setup')
  assert.equal((await q.peek()).past, 0)
  assert.equal((await q.peek()).playing, false)
  return { qualification: 'Actual Media Pool Relink file input through setInputFiles; canonical browser inspection and connection. No direct media/document store mutation, OS picker claim, or playback/PCM oracle.', manifest, connected }
}
