import { expect, test, type Page } from '@playwright/test'

function collectPageProblems(page: Page, problems: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`)
  })
}

test('ramped speech and music share real playback/export ownership', async ({ page }) => {
  const pageProblems: string[] = []
  collectPageProblems(page, pageProblems)
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const playbackPath = '/src/pipeline/playback-audio.ts'
    const sinkPath = '/src/pipeline/export-mediabunny-sink.ts'
    const profilePath = '/src/domain/exportProfile.ts'
    const effectsPath = '/src/domain/audioEffectStack.ts'
    const adjustmentsPath = '/src/domain/adjustmentItems.ts'
    const mixPlanPath = '/src/domain/audioMixPlan.ts'
    const mediabunnyPath = '/node_modules/.vite/deps/mediabunny.js'
    const {
      audioPlaybackAssetIds,
      createMediabunnyPlaybackAudioSource,
      startTimelineAudioPlayback,
    } = await import(playbackPath)
    const { createMediabunnyExportSink } = await import(sinkPath)
    const { DEFAULT_EXPORT_PROFILE } = await import(profilePath)
    const { createLimiterEffect } = await import(effectsPath)
    const { createAdjustmentItem } = await import(adjustmentsPath)
    const { createTimelineAudioMixPlan } = await import(mixPlanPath)
    const {
      ALL_FORMATS,
      AudioBufferSink,
      BlobSource,
      Input,
    } = await import(mediabunnyPath)

    const sampleRate = 48_000
    const durationFrames = 30
    const frameRate = { num: 30_000, den: 1_001 }
    const frameDuration = frameRate.den / frameRate.num
    const expectedDuration = durationFrames * frameDuration
    const sampleBoundary = (frame: number): number => Math.round(
      frame * frameRate.den * sampleRate / frameRate.num,
    )
    const sourceSeconds = 3
    const makeWav = (kind: 'speech' | 'music'): Blob => {
      const sampleCount = sampleRate * sourceSeconds
      const wav = new ArrayBuffer(44 + sampleCount * 2)
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
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(36, 'data')
      view.setUint32(40, sampleCount * 2, true)
      for (let sample = 0; sample < sampleCount; sample++) {
        const time = sample / sampleRate
        let value: number
        if (kind === 'speech') {
          const syllable = 0.35 + 0.65 * Math.max(0, Math.sin(2 * Math.PI * 3.2 * time))
          value = syllable * (
            0.45 * Math.sin(2 * Math.PI * 172 * time)
            + 0.18 * Math.sin(2 * Math.PI * 344 * time)
            + 0.08 * Math.sin(2 * Math.PI * 516 * time)
          )
        } else {
          const pulse = 0.65 + 0.35 * Math.sin(2 * Math.PI * 2 * time) ** 2
          value = pulse * (
            0.22 * Math.sin(2 * Math.PI * 220 * time)
            + 0.18 * Math.sin(2 * Math.PI * 277.18 * time)
            + 0.16 * Math.sin(2 * Math.PI * 329.63 * time)
          )
        }
        view.setInt16(44 + sample * 2, Math.round(
          Math.max(-1, Math.min(1, value)) * 32_767,
        ), true)
      }
      return new Blob([wav], { type: 'audio/wav' })
    }

    const speech = makeWav('speech')
    const music = makeWav('music')
    const blobs = new Map([
      ['speech-slow', speech],
      ['speech-fast', speech],
      ['music-ramp', music],
      ['music-freeze', music],
    ])
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    }
    const clip = (
      id: string,
      sourceDurationTicks: number,
      sourceDurationFrames: number,
      rate: { numerator: number; denominator: number },
      speedCurve?: object,
    ) => ({
      id,
      assetId: id,
      name: `${id}.wav`,
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: sourceDurationFrames },
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks,
        rate,
        ...(speedCurve ? { speedCurve } : {}),
      },
      timelineRange: { startFrame: 0, durationFrames },
      transform,
      opacity: 1,
      volume: 0.2,
      effects: [],
    })
    const slow = clip('speech-slow', 15_000_000, 15, {
      numerator: 1,
      denominator: 2,
    })
    const fast = clip('speech-fast', 60_000_000, 60, {
      numerator: 2,
      denominator: 1,
    })
    const ramp = {
      ...clip('music-ramp', 41_250_000, 42, { numerator: 1, denominator: 1 }, {
        originFrame: 0,
        points: [
          { frame: 0, rate: { numerator: 1, denominator: 2 }, easing: 'linear' },
          { frame: 15, rate: { numerator: 2, denominator: 1 }, easing: 'smooth' },
          { frame: 30, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
        ],
      }),
      animation: {
        tracks: [{
          property: 'volume',
          keyframes: [
            { frame: 0, value: 0.15, easing: { type: 'linear' } },
            { frame: 30, value: 0.3, easing: { type: 'linear' } },
          ],
        }],
        effectTracks: [],
      },
      audioEffects: [createLimiterEffect('ramp-limiter')],
    }
    const freeze = clip(
      'music-freeze',
      20_000_000,
      20,
      { numerator: 1, denominator: 1 },
      {
        originFrame: 0,
        points: [
          { frame: 0, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
          { frame: 10, rate: { numerator: 0, denominator: 1 }, easing: 'hold' },
          { frame: 20, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
          { frame: 30, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
        ],
      },
    )
    const track = (id: string, item: object) => ({
      id,
      kind: 'audio',
      name: id,
      clips: [item],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    })
    const doc = {
      schemaVersion: 18,
      id: 'issue-188-browser',
      name: 'Issue 188 browser acceptance',
      frameRate,
      width: 64,
      height: 48,
      audioSampleRate: sampleRate,
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          name: 'Adjustment compatibility',
          clips: [],
          adjustments: [createAdjustmentItem(0, durationFrames, 'Compatibility look')],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        },
        track('A1', slow),
        track('A2', fast),
        track('A3', ramp),
        track('A4', freeze),
      ],
    }
    const resolveAsset = async (assetId: string) => {
      const blob = blobs.get(assetId)
      if (!blob) throw new Error(`Missing browser fixture ${assetId}`)
      return {
        blob,
        kind: 'audio' as const,
        budget: {
          fileBytes: blob.size,
          durationMicroseconds: sourceSeconds * 1_000_000,
          sampleRate,
          channels: 1,
        },
      }
    }

    const mixPlan = createTimelineAudioMixPlan(doc)
    const playbackAssets = audioPlaybackAssetIds(doc, 0)
    const warnings: string[] = []
    const activeLifecycle: Array<{
      decoders: number
      pending: number
      nodes: number
      scheduledThrough: number
    }> = []
    const lifecycle: Array<{
      decoders: number
      pending: number
      nodes: number
    }> = []
    const context = new AudioContext({ sampleRate })
    try {
      for (const fromFrame of [0, 15, 0, 15, 0, 15]) {
        const session = await startTimelineAudioPlayback(
          context,
          doc,
          fromFrame,
          resolveAsset,
          {
            onWarning: (warning: unknown) => warnings.push(JSON.stringify(warning)),
          },
        )
        const active = session.diagnostics()
        activeLifecycle.push({
          decoders: active.activeDecoderCount,
          pending: active.pendingBufferCount,
          nodes: active.activeNodeCount,
          scheduledThrough: active.scheduledThroughTimelineTime,
        })
        await session.stop()
        // Web Audio owns a 5 ms stop fade and a 50 ms fallback cleanup.
        await new Promise((resolve) => globalThis.setTimeout(resolve, 75))
        const diagnostics = session.diagnostics()
        lifecycle.push({
          decoders: diagnostics.activeDecoderCount,
          pending: diagnostics.pendingBufferCount,
          nodes: diagnostics.activeNodeCount,
        })
      }

      const freezeDoc = {
        ...doc,
        id: 'issue-188-live-freeze-probe',
        tracks: doc.tracks.filter((item: { id: string }) =>
          item.id === 'V1' || item.id === 'A4'),
      }
      const captured: Array<{
        timelineStartTime: number
        samples: Float32Array
      }> = []
      const captureSession = await startTimelineAudioPlayback(
        context,
        freezeDoc,
        0,
        resolveAsset,
        {},
        {
          createMediaSource: createMediabunnyPlaybackAudioSource,
          createOutput: () => ({
            currentTime: () => context.currentTime,
            schedule: (request: {
              timelineStartTime: number
              buffer: AudioBuffer
            }) => captured.push({
              timelineStartTime: request.timelineStartTime,
              samples: request.buffer.getChannelData(0).slice(),
            }),
            stop: () => undefined,
            diagnostics: () => ({
              contextTime: context.currentTime,
              activeNodeCount: captured.length,
              rms: 0,
              peakLeft: 0,
              peakRight: 0,
              peakMaster: 0,
              meterSampleSize: 256,
            }),
          }),
          schedulePump: (callback: () => void, delayMs: number) =>
            globalThis.setTimeout(callback, delayMs),
          cancelPump: (id: number) => globalThis.clearTimeout(id),
          lookaheadSeconds: 2,
          startLeadSeconds: 0,
          pumpIntervalMs: 100,
        },
      )
      const livePcm = new Float32Array(sampleBoundary(durationFrames))
      for (const event of captured) {
        livePcm.set(
          event.samples.subarray(0, livePcm.length),
          Math.round(event.timelineStartTime * sampleRate),
        )
      }
      await captureSession.stop()
      const freezeStartSample = sampleBoundary(10)
      const freezeEndSample = sampleBoundary(20)
      const liveContent = {
        sampleCount: livePcm.length,
        audibleBefore: livePcm.subarray(0, freezeStartSample - 200)
          .some((sample) => sample !== 0),
        exactFreezeSilence: livePcm.subarray(freezeStartSample, freezeEndSample)
          .every((sample) => sample === 0),
        audibleAfter: livePcm.subarray(freezeEndSample + 200)
          .some((sample) => sample !== 0),
      }

      const rms = (
        samples: Float32Array,
        startSeconds = 0,
        endSeconds = expectedDuration,
      ): number => {
        const start = Math.max(0, Math.round(startSeconds * sampleRate))
        const end = Math.min(samples.length, Math.round(endSeconds * sampleRate))
        let sum = 0
        for (let index = start; index < end; index++) sum += samples[index]! ** 2
        return Math.sqrt(sum / Math.max(1, end - start))
      }
      const magnitude = (
        samples: Float32Array,
        frequency: number,
        startSeconds = 0.15,
        endSeconds = 0.85,
      ): number => {
        const start = Math.max(0, Math.round(startSeconds * sampleRate))
        const end = Math.min(samples.length, Math.round(endSeconds * sampleRate))
        let real = 0
        let imaginary = 0
        const length = Math.max(1, end - start)
        for (let index = start; index < end; index++) {
          const phase = 2 * Math.PI * frequency * (index - start) / sampleRate
          const window = 0.5 - 0.5 * Math.cos(
            2 * Math.PI * (index - start) / Math.max(1, length - 1),
          )
          const value = samples[index]! * window
          real += value * Math.cos(phase)
          imaginary -= value * Math.sin(phase)
        }
        return Math.hypot(real, imaginary) / length
      }

      const exportAndDecode = async (targetDoc: typeof doc) => {
        const targetSink = await createMediabunnyExportSink(
          targetDoc,
          DEFAULT_EXPORT_PROFILE,
          resolveAsset,
        )
        for (let frame = 0; frame < durationFrames; frame++) {
          await targetSink.addFrame(frame * frameDuration, frameDuration)
        }
        const targetExport = await targetSink.finalize()
        if (targetExport.destination !== 'download') {
          throw new Error('Browser acceptance expected a buffered download')
        }
        const input = new Input({
          source: new BlobSource(new Blob([targetExport.buffer])),
          formats: ALL_FORMATS,
        })
        const pcm = new Float32Array(sampleBoundary(durationFrames))
        let decodedThroughSample = 0
        let duration = 0
        let videoDuration = 0
        let audioDuration = 0
        try {
          const [videoTrack, audioTrack] = await Promise.all([
            input.getPrimaryVideoTrack(),
            input.getPrimaryAudioTrack(),
          ])
          if (!audioTrack) throw new Error('Exported acceptance media has no audio')
          const audioSink = new AudioBufferSink(audioTrack)
          for await (const wrapped of audioSink.buffers(0, expectedDuration)) {
            const start = Math.round(wrapped.timestamp * sampleRate)
            const source = wrapped.buffer.getChannelData(0)
            const sourceStart = Math.max(0, -start)
            const targetStart = Math.max(0, start)
            const count = Math.min(
              source.length - sourceStart,
              pcm.length - targetStart,
            )
            if (count > 0) {
              pcm.set(source.subarray(sourceStart, sourceStart + count), targetStart)
              decodedThroughSample = Math.max(decodedThroughSample, targetStart + count)
            }
          }
          duration = await input.computeDuration()
          videoDuration = videoTrack ? await videoTrack.computeDuration() : 0
          audioDuration = await audioTrack.computeDuration()
        } finally {
          input.dispose()
        }
        return {
          bytes: targetExport.buffer.byteLength,
          pcm,
          decodedThroughSample,
          duration,
          videoDuration,
          audioDuration,
        }
      }

      const isolatedDoc = (trackId: string) => ({
        ...doc,
        id: `issue-188-${trackId}`,
        tracks: doc.tracks.filter((item: { id: string }) =>
          item.id === 'V1' || item.id === trackId),
      })
      const combined = await exportAndDecode(doc)
      const slowExport = await exportAndDecode(isolatedDoc('A1'))
      const fastExport = await exportAndDecode(isolatedDoc('A2'))
      const rampExport = await exportAndDecode(isolatedDoc('A3'))

      const speechMetrics = (samples: Float32Array) => ({
        rms: rms(samples),
        fundamental: magnitude(samples, 172),
        halfPitch: magnitude(samples, 86),
        doublePitch: magnitude(samples, 344),
      })
      const musicMetrics = {
        rms: rms(rampExport.pcm),
        authored: [220, 277.18, 329.63].reduce(
          (sum, frequency) => sum + magnitude(rampExport.pcm, frequency),
          0,
        ),
        halfPitch: [110, 138.59, 164.815].reduce(
          (sum, frequency) => sum + magnitude(rampExport.pcm, frequency),
          0,
        ),
        doublePitch: [440, 554.36, 659.26].reduce(
          (sum, frequency) => sum + magnitude(rampExport.pcm, frequency),
          0,
        ),
      }

      const cancelled = await createMediabunnyExportSink(
        doc,
        DEFAULT_EXPORT_PROFILE,
        resolveAsset,
      )
      await cancelled.addFrame(0, frameDuration)
      const firstCancel = cancelled.cancel(new Error('Issue 188 cancellation probe'))
      const secondCancel = cancelled.cancel(new Error('ignored duplicate'))
      await Promise.all([firstCancel, secondCancel])

      return {
        planKinds: mixPlan.clips.map((item: { stretch?: object; ramp?: object }) =>
          item.ramp ? 'ramp' : item.stretch ? 'constant' : 'direct'),
        playbackAssets,
        warnings,
        activeLifecycle,
        lifecycle,
        liveContent,
        exportBytes: combined.bytes,
        duration: combined.duration,
        videoDuration: combined.videoDuration,
        audioDuration: combined.audioDuration,
        decodedThroughSample: combined.decodedThroughSample,
        combinedRms: rms(combined.pcm),
        slowSpeech: speechMetrics(slowExport.pcm),
        fastSpeech: speechMetrics(fastExport.pcm),
        rampMusic: musicMetrics,
        expectedDuration,
        expectedSamples: sampleBoundary(durationFrames),
        cancelled: true,
      }
    } finally {
      await context.close()
    }
  })

  expect(result.planKinds.sort()).toEqual([
    'constant',
    'constant',
    'ramp',
    'ramp',
  ])
  expect(result.playbackAssets.sort()).toEqual([
    'music-freeze',
    'music-ramp',
    'speech-fast',
    'speech-slow',
  ])
  expect(result.warnings).toEqual([])
  expect(result.activeLifecycle).toHaveLength(6)
  expect(result.activeLifecycle.every((item) => item.nodes > 0)).toBe(true)
  expect(result.activeLifecycle.every((item) => item.scheduledThrough > 0)).toBe(true)
  expect(result.lifecycle).toEqual(Array.from({ length: 6 }, () => ({
    decoders: 0,
    pending: 0,
    nodes: 0,
  })))
  expect(result.liveContent).toEqual({
    sampleCount: result.expectedSamples,
    audibleBefore: true,
    exactFreezeSilence: true,
    audibleAfter: true,
  })
  expect(result.exportBytes).toBeGreaterThan(1_000)
  expect(result.duration).toBeCloseTo(result.expectedDuration, 3)
  expect(result.videoDuration).toBeCloseTo(result.expectedDuration, 3)
  expect(result.audioDuration).toBeCloseTo(result.expectedDuration, 3)
  expect(result.decodedThroughSample).toBe(result.expectedSamples)
  expect(result.combinedRms).toBeGreaterThan(0.01)
  for (const speech of [result.slowSpeech, result.fastSpeech]) {
    expect(speech.rms).toBeGreaterThan(0.01)
    expect(speech.fundamental).toBeGreaterThan(speech.halfPitch * 2)
    expect(speech.fundamental).toBeGreaterThan(speech.doublePitch * 1.5)
  }
  expect(result.rampMusic.rms).toBeGreaterThan(0.01)
  expect(result.rampMusic.authored).toBeGreaterThan(result.rampMusic.halfPitch * 2)
  expect(result.rampMusic.authored).toBeGreaterThan(result.rampMusic.doublePitch * 2)
  expect(result.cancelled).toBe(true)
  expect(pageProblems).toEqual([])
})
