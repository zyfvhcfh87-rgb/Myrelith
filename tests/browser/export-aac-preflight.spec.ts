import { expect, test } from '@playwright/test'

test('fresh preflight and real AAC export support a 60 fps timeline', async ({
  page,
}) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const capabilitiesPath =
      '/src/pipeline/export-mediabunny-capabilities.ts'
    const sinkPath = '/src/pipeline/export-mediabunny-sink.ts'
    const profilePath = '/src/domain/exportProfile.ts'
    const { runFreshMediabunnyExportProbe } = await import(capabilitiesPath)
    const { createMediabunnyExportSink } = await import(sinkPath)
    const { DEFAULT_EXPORT_PROFILE } = await import(profilePath)
    const durationFrames = 3
    const clip = {
      id: 'audio-clip',
      assetId: 'audio-asset',
      name: 'audio.wav',
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames },
      timelineRange: { startFrame: 0, durationFrames },
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
      },
      opacity: 1,
      volume: 1,
      effects: [],
    }
    const doc = {
      schemaVersion: 17,
      id: 'aac-60-fps-probe',
      name: 'AAC 60 fps probe',
      frameRate: { num: 60, den: 1 },
      width: 64,
      height: 48,
      audioSampleRate: 48_000,
      tracks: [{
        id: 'A1',
        kind: 'audio',
        name: 'A1',
        clips: [clip],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      }],
    }

    const wavSampleCount = 4_800
    const wav = new ArrayBuffer(44 + wavSampleCount * 2)
    const view = new DataView(wav)
    const writeAscii = (offset: number, value: string): void => {
      for (let index = 0; index < value.length; index++) {
        view.setUint8(offset + index, value.charCodeAt(index))
      }
    }
    writeAscii(0, 'RIFF')
    view.setUint32(4, wav.byteLength - 8, true)
    writeAscii(8, 'WAVE')
    writeAscii(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 48_000, true)
    view.setUint32(28, 96_000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeAscii(36, 'data')
    view.setUint32(40, wavSampleCount * 2, true)
    const blob = new Blob([wav], { type: 'audio/wav' })

    try {
      await runFreshMediabunnyExportProbe(
        doc,
        DEFAULT_EXPORT_PROFILE,
        true,
      )
      const sink = await createMediabunnyExportSink(
        doc,
        DEFAULT_EXPORT_PROFILE,
        async () => ({
          blob,
          kind: 'audio',
          budget: {
            fileBytes: blob.size,
            durationMicroseconds: 100_000,
            sampleRate: 48_000,
            channels: 1,
          },
        }),
      )
      for (let frame = 0; frame < durationFrames; frame++) {
        await sink.addFrame(frame / 60, 1 / 60)
      }
      const exported = await sink.finalize()
      return {
        supported: true,
        exported: exported.destination === 'download'
          && exported.buffer.byteLength > 0,
        error: null,
      }
    } catch (error) {
      return {
        supported: false,
        exported: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  expect(result).toEqual({ supported: true, exported: true, error: null })
})
