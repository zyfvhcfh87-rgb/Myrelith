import { describe, expect, test, vi } from 'vitest'
import type { MediaAsset } from '../domain/schema'
import type { TimelineAudioPlaybackWarning } from '../pipeline/playback-audio'
import {
  PlaybackTasks,
  createPlaybackAssetResolver,
  playbackAudioWarningMessage,
} from './playbackAudioShared'

const mediaWarning = (stage: 'source-open' | 'decode' | 'decoded-timing'): TimelineAudioPlaybackWarning => ({
  scope: 'media', stage, clipId: 'c1', assetId: 'a1', trackKind: 'audio', reason: 'decode-failed', cause: null,
})
const globalWarning = (stage: 'output-schedule' | 'pump' | 'cleanup'): TimelineAudioPlaybackWarning => ({
  scope: 'global', stage, cause: null,
})

describe('playbackAudioShared', () => {
  test('keeps each owner warning text exact', () => {
    const warnings = [
      mediaWarning('source-open'), mediaWarning('decoded-timing'), mediaWarning('decode'),
      globalWarning('output-schedule'), globalWarning('pump'), globalWarning('cleanup'),
    ]
    expect(warnings.map((warning) => playbackAudioWarningMessage(warning))).toEqual([
      'audio clip "c1" source open failed',
      'audio clip "c1" produced invalid decoded timing',
      'audio clip "c1" decode failed',
      'audio output scheduling failed',
      'audio refill failed',
      'audio cleanup failed',
    ])
    expect(warnings.map((warning) => playbackAudioWarningMessage(warning, 'source '))).toEqual([
      'source audio clip "c1" source open failed',
      'source audio clip "c1" produced invalid decoded timing',
      'source audio clip "c1" decode failed',
      'source audio output scheduling failed',
      'source audio refill failed',
      'source audio cleanup failed',
    ])
  })

  test('resolves only connected audio sources from its snapshot', async () => {
    const blob = new Blob(['pcm'])
    const asset = { id: 'a1', fileName: 'take.wav', objectUrl: 'blob:a1', hasAudio: true } as MediaAsset
    const silent = { ...asset, id: 'a2', fileName: 'still.png', hasAudio: false }
    const fetchBlob = vi.fn(async () => blob)
    const resolve = createPlaybackAssetResolver(
      new Map([[asset.id, asset], [silent.id, silent]]),
      fetchBlob,
      'Source playback',
    )
    expect(() => resolve('gone')).toThrow(
      'Source playback media asset "gone" is missing from the media pool',
    )
    expect(() => resolve('a2')).toThrow(
      'Source playback media asset "still.png" has no imported audio track',
    )
    await expect(resolve('a1')).resolves.toMatchObject({ blob })
    expect(fetchBlob).toHaveBeenCalledWith('blob:a1')
  })

  test('drains snapshot playback work and every later cleanup', async () => {
    const tasks = new PlaybackTasks()
    let finishStartup!: () => void
    tasks.track(new Promise<void>((resolve) => { finishStartup = resolve }))
    const failure = vi.fn()
    let failCleanup!: (cause: unknown) => void
    void tasks.trackCleanup(new Promise((_, reject) => { failCleanup = reject }), failure)
    expect(tasks.hasWork()).toBe(true)

    let drained = false
    const drain = tasks.drain().then(() => { drained = true })
    finishStartup()
    await Promise.resolve()
    expect(drained).toBe(false)
    failCleanup(new Error('stop failed'))
    await drain
    expect(failure).toHaveBeenCalledWith(new Error('stop failed'))
    expect(tasks.hasWork()).toBe(false)
  })
})
