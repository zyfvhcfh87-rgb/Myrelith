import { expect, test, type Page } from '@playwright/test'

async function create(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Delivery products')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
}

test('PNG sequence, WAV audio-only, sidecar JSON, and classic MP4 stay honest', async ({ page }) => {
  test.setTimeout(180000)
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  await create(page)
  const result = await page.evaluate(async () => {
    const dp = '/src/state/documentStore.ts'
    const mp = '/src/state/mediaStore.ts'
    const ip = '/src/app/mediaImportController.ts'
    const op = '/src/domain/operations.ts'
    const store = (await import(dp)).useDocumentStore
    const media = (await import(mp)).useMediaStore
    const importMedia = (await import(ip)).importMedia
    const clipFromAssetRange = (await import(op)).clipFromAssetRange
    for (const [index, color] of ['#ff0000', '#00ff00', '#0000ff'].entries()) {
      const canvas = new OffscreenCanvas(320, 180)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 320, 180)
      const imported = await importMedia(new File(
        [await canvas.convertToBlob({ type: 'image/png' })],
        `plate${index}.png`,
        { type: 'image/png' },
      ))
      canvas.width = canvas.height = 0
      if (imported.status !== 'imported') throw new Error('Fixture import failed')
      const clip = clipFromAssetRange(media.getState().assets.get(imported.assetId), index * 2, 0, 2)
      store.getState().insertClips([{ trackId: store.getState().doc.tracks[0].id, clip }])
    }
    const bytes = new ArrayBuffer(44 + 48000 * 2)
    const view = new DataView(bytes)
    const text = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    text(36, 'data'); view.setUint32(40, 96000, true)
    const audio = await importMedia(new File([bytes], 'tone.wav', { type: 'audio/wav' }))
    if (audio.status !== 'imported') throw new Error('Audio import failed')
    const audioClip = clipFromAssetRange(media.getState().assets.get(audio.assetId), 0, 0, 6)
    store.getState().insertClips([{
      trackId: store.getState().doc.tracks.find((track: { kind: string }) => track.kind === 'audio').id,
      clip: audioClip,
    }])
    const project = structuredClone(store.getState().project)
    project.sequences[0].markers = [
      { id: 'in', frame: 2, label: 'Mid', color: 'blue' },
      { id: 'late', frame: 5, label: 'Late', color: 'red' },
    ]
    store.getState().setProject(project)

    const ep = '/src/app/exportController.ts'
    const products = '/src/domain/deliveryProduct.ts'
    const zip = '/src/pipeline/zipStore.ts'
    const profiles = '/src/domain/exportProfile.ts'
    const caps = '/src/app/exportCapabilitiesController.ts'
    const mb = '/node_modules/.vite/deps/mediabunny.js'
    const { startExport } = await import(ep)
    const { DEFAULT_IMAGE_SEQUENCE_PROFILE, DEFAULT_AUDIO_ONLY_PROFILE, DEFAULT_ALPHA_VIDEO_PROFILE } = await import(products)
    const { unzipStore } = await import(zip)
    const { exportPresetById } = await import(profiles)
    const png = await startExport(
      { ...DEFAULT_IMAGE_SEQUENCE_PROFILE, chapters: { mode: 'sidecar' } },
      { range: { startFrame: 2, endFrame: 5 } },
    )
    if (!png || png.destination !== 'download' || !('kind' in png)) throw new Error('PNG zip missing')
    const pngUnzipped = unzipStore(new Uint8Array(png.buffer))
    const pngEntries = pngUnzipped.map((entry: { name: string }) => entry.name)
    const sidecar = pngUnzipped.find((entry: { name: string }) => entry.name.endsWith('.chapters.json'))
    const sidecarJson = sidecar ? JSON.parse(new TextDecoder().decode(sidecar.data)) : null

    const wav = await startExport(DEFAULT_AUDIO_ONLY_PROFILE, { range: { startFrame: 1, endFrame: 3 } })
    if (!wav || wav.destination !== 'download') throw new Error('WAV missing')
    const wavBytes = new Uint8Array(wav.buffer)
    const sampleRate = new DataView(wav.buffer).getUint32(24, true)
    const channels = new DataView(wav.buffer).getUint16(22, true)
    const { Input, BlobSource, ALL_FORMATS } = await import(mb)
    let wavVideoTrack = false
    try {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([wav.buffer])) })
      try {
        wavVideoTrack = Boolean(await input.getPrimaryVideoTrack())
      } finally {
        input.dispose()
      }
    } catch {
      wavVideoTrack = false
    }

    // Headless Chromium in this gate often cannot encode the Compatibility AAC
    // pair. Use the same MP4/AVC profile with audio explicitly off so the
    // classic video path is proven without substituting another codec.
    const classicProfile = {
      ...exportPresetById('compatibility').profile,
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    }
    const classic = await startExport(classicProfile, { range: { startFrame: 0, endFrame: 2 } })
    if (!classic || classic.destination !== 'download' || !('profile' in classic)) throw new Error('Classic MP4 missing')
    const classicInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([classic.buffer])) })
    let classicHasVideo = false
    try {
      classicHasVideo = Boolean(await classicInput.getPrimaryVideoTrack())
    } finally {
      classicInput.dispose()
    }

    const alpha = await (await import(caps)).checkCurrentExportSettings({
      ...DEFAULT_ALPHA_VIDEO_PROFILE,
    })

    return {
      pngKind: png.kind,
      pngCompletion: png.completion,
      pngEntries,
      sidecarFrames: sidecarJson?.chapters?.map((chapter: { frame: number }) => chapter.frame) ?? null,
      sidecarSupport: sidecarJson?.containerChapterSupport ?? null,
      wavHeader: String.fromCharCode(wavBytes[0]!, wavBytes[1]!, wavBytes[2]!, wavBytes[3]!),
      wavMime: wav.mimeType,
      sampleRate,
      channels,
      wavVideoTrack,
      classicContainer: classic.profile.container,
      classicHasVideo,
      alphaSupported: alpha.supported,
      alphaReason: alpha.reason,
    }
  })
  expect(result.pngKind).toBe('image-sequence')
  expect(result.pngCompletion).toBe('complete')
  expect(result.pngEntries).toEqual([
    'frame_00002.png',
    'frame_00003.png',
    'frame_00004.png',
    'frame.chapters.json',
  ])
  expect(result.sidecarFrames).toEqual([2])
  expect(result.sidecarSupport).toBe('unsupported')
  expect(result.wavHeader).toBe('RIFF')
  expect(result.wavMime).toBe('audio/wav')
  expect(result.sampleRate).toBe(48000)
  expect(result.channels).toBe(2)
  expect(result.wavVideoTrack).toBe(false)
  expect(result.classicContainer).toBe('mp4')
  expect(result.classicHasVideo).toBe(true)
  expect(result.alphaSupported === true || typeof result.alphaReason === 'string').toBe(true)
  expect(problems).toEqual([])
})

test('export dialog offers PNG and audio-only without substituting codecs', async ({ page }) => {
  test.setTimeout(60000)
  await create(page)
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export video' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'PNG image sequence' })).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'Audio only' })).toBeVisible()
  await dialog.getByRole('radio', { name: 'PNG image sequence' }).check()
  await expect(dialog.getByLabel('PNG file prefix')).toHaveValue('frame')
  await expect(dialog.getByLabel('Include chapter sidecar JSON')).toBeVisible()
  await dialog.getByRole('radio', { name: 'Audio only' }).check()
  await expect(dialog.getByLabel('Audio-only format')).toHaveValue('wav')
})
