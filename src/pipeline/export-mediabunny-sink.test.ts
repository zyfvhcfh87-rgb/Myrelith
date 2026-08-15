import { describe, expect, test, vi } from 'vitest'
import {
  DECODE_BUDGET,
  SETTINGS,
  adapterTestSubject,
  audioIteratorAt,
  audioSinkAt,
  audioSourceAt,
  audioTrack,
  canvasSourceAt,
  decodedAudioSample,
  decoderChecks,
  deferred,
  encodedAudioSampleAt,
  fakeCanvases,
  inputAt,
  lensBackends,
  localDecoders,
  makeAudioClip,
  makeAudioCrossfadeDoc,
  makeAudioDoc,
  makeAudioTrack,
  makeDoc,
  makeVideoDoc,
  mb,
  outputAt,
  resolvedAsset,
  streamTargetAt,
  type FakeAudioSampleRecord,
} from './export-mediabunny.test-harness'

const {
  LOCAL_DECODER_LIMITS,
  MediaAssetRuntimeError,
  audioSampleBoundary,
  compositeFrame,
  createMediabunnyExportDeps,
  createMediabunnyExportSink,
  exportPresetById,
  updateExportProfile,
} = adapterTestSubject

describe('createMediabunnyExportSink video behavior', () => {
  test('refuses preserved future lens intent before allocating export resources', async () => {
    const doc = makeVideoDoc(
      [{ assetId: 'asset-a', sourceStart: 0 }],
      1,
    )
    doc.tracks[0].clips[0].lensCorrection = {
      version: 2,
      profile: 'future-camera-profile',
    }

    await expect(createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => resolvedAsset(new Blob(['unused'])),
    )).rejects.toThrow(/preserved future lens-correction version/i)

    expect(fakeCanvases).toHaveLength(0)
    expect(mb.outputs).toHaveLength(0)
  })

  test('wires an exact-rate MP4 canvas track without audio for a video-only document', async () => {
    const doc = makeDoc()
    const resolveAsset = vi.fn(async () => resolvedAsset(new Blob(['unused'])))
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

    expect(mb.canEncodeVideo).not.toHaveBeenCalled()
    expect(fakeCanvases).toHaveLength(1)
    expect(fakeCanvases[0]).toMatchObject({ width: 64, height: 48 })
    expect(fakeCanvases[0].getContext).toHaveBeenCalledWith(
      '2d',
      { colorSpace: 'srgb' },
    )
    expect(canvasSourceAt().canvas).toBe(fakeCanvases[0])
    expect(canvasSourceAt().encodingConfig).toEqual({
      codec: 'avc',
      bitrate: 250_000,
      bitrateMode: 'variable',
      keyFrameInterval: 2,
    })
    expect(outputAt().options).toEqual({
      format: mb.formats[0],
      target: mb.targets[0],
    })
    expect(outputAt().addVideoTrack).toHaveBeenCalledWith(canvasSourceAt(), {
      frameRate: 30_000 / 1_001,
    })
    expect(mb.canEncodeAudio).not.toHaveBeenCalled()
    expect(mb.audioSources).toHaveLength(0)
    expect(outputAt().addAudioTrack).not.toHaveBeenCalled()
    expect(outputAt().start).toHaveBeenCalledOnce()
    expect(sink.ctx).toBe(fakeCanvases[0].context)
    const transitionSurfaces = sink.transitionSurfaceProvider.get()
    expect(fakeCanvases).toHaveLength(3)
    expect(transitionSurfaces.leg.canvas).toBe(fakeCanvases[1])
    expect(transitionSurfaces.group.canvas).toBe(fakeCanvases[2])
    expect(fakeCanvases[1].getContext).toHaveBeenCalledWith(
      '2d',
      { colorSpace: 'srgb' },
    )
    expect(fakeCanvases[2].getContext).toHaveBeenCalledWith(
      '2d',
      { colorSpace: 'srgb' },
    )
    expect(sink.transitionSurfaceProvider.get()).toBe(transitionSurfaces)
    expect(fakeCanvases).toHaveLength(3)
    const deps = createMediabunnyExportDeps(resolveAsset)
    expect(deps.composite).toBe(compositeFrame)
    expect(deps.createVideoSink).toEqual(expect.any(Function))
  })

  test('awaits encoder backpressure and finalizes to the target buffer', async () => {
    const add = deferred<void>()
    const resultBuffer = new Uint8Array([8, 9, 10]).buffer
    mb.canvasSourceAddHandlers.push(async () => add.promise)
    mb.targetBuffers.push(resultBuffer)
    const doc = makeVideoDoc(
      [{ assetId: 'asset-a', sourceStart: 0 }],
      1,
    )
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => resolvedAsset(new Blob(['unused'])),
    )

    let settled = false
    const pending = sink.addFrame(1_001 / 30_000, 1_001 / 30_000)
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(canvasSourceAt().add).toHaveBeenCalledWith(
      1_001 / 30_000,
      1_001 / 30_000,
    )
    add.resolve()
    await pending

    await expect(sink.finalize()).resolves.toEqual({
      destination: 'download',
      buffer: resultBuffer,
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
      profile: SETTINGS,
    })
    expect(canvasSourceAt().close).toHaveBeenCalledOnce()
    expect(outputAt().finalize).toHaveBeenCalledOnce()
    expect(outputAt().cancel).not.toHaveBeenCalled()
  })

  test('does not reuse a stale cached capability result after fresh preflight', async () => {
    mb.canEncodeVideo.mockResolvedValue(false)

    const sink = await createMediabunnyExportSink(
      makeDoc(),
      SETTINGS,
      async () => resolvedAsset(new Blob(['unused'])),
    )

    expect(mb.canEncodeVideo).not.toHaveBeenCalled()
    expect(fakeCanvases).toHaveLength(1)
    expect(mb.outputs).toHaveLength(1)
    await sink.cancel()
  })

  test('cancels a started output exactly once without normal-closing the source', async () => {
    const sink = await createMediabunnyExportSink(
      makeDoc(),
      SETTINGS,
      async () => resolvedAsset(new Blob(['unused'])),
    )

    await sink.cancel()
    await sink.cancel()

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(canvasSourceAt().close).not.toHaveBeenCalled()
    await expect(sink.addFrame(0, 1 / 30)).rejects.toThrow(
      'Export sink is closed',
    )
  })

  test('cancels setup when output start fails and preserves the start error', async () => {
    const startError = new Error('start failed')
    mb.outputStartHandlers.push(async () => {
      throw startError
    })

    await expect(
      createMediabunnyExportSink(
        makeDoc(),
        SETTINGS,
        async () => resolvedAsset(new Blob(['unused'])),
      ),
    ).rejects.toBe(startError)

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(canvasSourceAt().close).not.toHaveBeenCalled()
  })

  test.each([
    ['add', new Error('add failed')],
    ['finalize', new Error('finalize failed')],
  ])('cancels after %s fails while preserving the primary error', async (kind, primary) => {
    if (kind === 'add') {
      mb.canvasSourceAddHandlers.push(async () => {
        throw primary
      })
    } else {
      mb.outputFinalizeHandlers.push(async () => {
        throw primary
      })
    }
    const doc =
      kind === 'add'
        ? makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1)
        : makeDoc()
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => resolvedAsset(new Blob(['unused'])),
    )

    const operation =
      kind === 'add' ? sink.addFrame(0, 1 / 30) : sink.finalize()
    await expect(operation).rejects.toBe(primary)
    await sink.cancel()

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(canvasSourceAt().close).toHaveBeenCalledTimes(
      kind === 'finalize' ? 1 : 0,
    )
  })

  test('rejects a finalized output whose target buffer is missing', async () => {
    mb.targetBuffers.push(null)
    const sink = await createMediabunnyExportSink(
      makeDoc(),
      SETTINGS,
      async () => resolvedAsset(new Blob(['unused'])),
    )

    await expect(sink.finalize()).rejects.toThrow(
      'Mediabunny finalized without an output buffer',
    )
    expect(canvasSourceAt().close).toHaveBeenCalledOnce()
    expect(outputAt().finalize).toHaveBeenCalledOnce()
  })
})

describe('createMediabunnyExportSink selected profiles', () => {
  test.each([
    ['hevc', 'mp4', 'hevc', 'video/mp4', 'mp4'],
    ['web', 'webm', 'vp9', 'video/webm', 'webm'],
    ['modern', 'webm', 'av1', 'video/webm', 'webm'],
  ] as const)(
    'writes the %s video profile through its exact format and codec',
    async (presetId, formatKind, codec, mimeType, fileExtension) => {
      const profile = updateExportProfile(exportPresetById(presetId).profile, {
        videoBitrate: 3_210_000,
        videoBitrateMode: 'constant',
        keyFrameIntervalMicroseconds: 750_000,
      })
      const doc = makeVideoDoc(
        [{ assetId: 'asset-a', sourceStart: 0 }],
        1,
      )
      const sink = await createMediabunnyExportSink(
        doc,
        profile,
        async () => resolvedAsset(new Blob(['unused'])),
      )

      expect(mb.formats.at(-1)).toMatchObject({ kind: formatKind })
      expect(canvasSourceAt().encodingConfig).toEqual({
        codec,
        bitrate: 3_210_000,
        bitrateMode: 'constant',
        keyFrameInterval: 0.75,
      })
      expect(mb.audioSources).toHaveLength(0)

      await sink.addFrame(0, 1_001 / 30_000)
      const result = await sink.finalize()
      expect(result).toMatchObject({
        destination: 'download',
        mimeType,
        fileExtension,
        profile,
      })
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.profile)).toBe(true)
    },
  )

  test('streams a direct-file profile and returns metadata without a buffer', async () => {
    const directFile = updateExportProfile(SETTINGS, { destination: 'file' })
    const write = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const abort = vi.fn(async () => undefined)
    const writable = { write, close, abort } as unknown as
      FileSystemWritableFileStream
    const createWritable = vi.fn(async () => writable)
    const handle = {
      name: 'chosen-output.mp4',
      createWritable,
    } as unknown as FileSystemFileHandle
    const takeFileHandle = vi.fn(() => handle)
    const doc = makeVideoDoc(
      [{ assetId: 'asset-a', sourceStart: 0 }],
      1,
    )
    const sink = await createMediabunnyExportSink(
      doc,
      directFile,
      async () => resolvedAsset(new Blob(['unused'])),
      new Map(),
      { fileName: 'chosen-output.mp4', takeFileHandle },
    )

    await streamTargetAt().write({
      type: 'write',
      data: Uint8Array.from([1, 2, 3]),
      position: 4,
    })
    await streamTargetAt().write({
      type: 'write',
      data: Uint8Array.from([9, 8]),
      position: 0,
    })
    await sink.addFrame(0, 1_001 / 30_000)
    const result = await sink.finalize()

    expect(result).toEqual({
      destination: 'file',
      fileName: 'chosen-output.mp4',
      byteLength: 7,
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
      profile: directFile,
    })
    expect(result).not.toHaveProperty('buffer')
    expect(result).not.toHaveProperty('handle')
    expect(takeFileHandle).toHaveBeenCalledOnce()
    expect(createWritable).toHaveBeenCalledWith({ keepExistingData: false })
    expect(write).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
    expect(abort).not.toHaveBeenCalled()
    expect(mb.targets).toHaveLength(0)
  })

  test('releases lens resources when direct-file setup rejects', async () => {
    const directFile = updateExportProfile(SETTINGS, { destination: 'file' })
    const failure = new Error('file permission was revoked')
    const doc = makeVideoDoc(
      [{ assetId: 'asset-a', sourceStart: 0 }],
      1,
    )
    doc.tracks[0].clips[0].lensCorrection = {
      version: 1,
      centerX: 0.5,
      centerY: 0.5,
      focalX: 0.5,
      focalY: 0.5,
      k1: 0.1,
      k2: 0,
      k3: 0,
      p1: 0,
      p2: 0,
      strength: 1,
      outputScale: 1.2,
    }
    const handle = {
      name: 'rejected.mp4',
      createWritable: vi.fn(async () => {
        throw failure
      }),
    } as unknown as FileSystemFileHandle

    await expect(createMediabunnyExportSink(
      doc,
      directFile,
      async () => resolvedAsset(new Blob(['unused'])),
      new Map(),
      {
        fileName: 'rejected.mp4',
        takeFileHandle: vi.fn(() => handle),
      },
    )).rejects.toBe(failure)

    expect(lensBackends).toHaveLength(1)
    expect(lensBackends[0].dispose).toHaveBeenCalledOnce()
    expect(fakeCanvases).toHaveLength(1)
    expect(fakeCanvases[0]).toMatchObject({ width: 1, height: 1 })
    expect(mb.outputs).toHaveLength(0)
  })

  test('cancels a direct-file sink exactly once without committing it', async () => {
    const directFile = updateExportProfile(SETTINGS, { destination: 'file' })
    const close = vi.fn(async () => undefined)
    const abort = vi.fn(async () => undefined)
    const writable = {
      write: vi.fn(async () => undefined),
      close,
      abort,
    } as unknown as FileSystemWritableFileStream
    const handle = {
      name: 'cancelled.mp4',
      createWritable: vi.fn(async () => writable),
    } as unknown as FileSystemFileHandle
    const sink = await createMediabunnyExportSink(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      directFile,
      async () => resolvedAsset(new Blob(['unused'])),
      new Map(),
      {
        fileName: 'cancelled.mp4',
        takeFileHandle: vi.fn(() => handle),
      },
    )

    await Promise.all([sink.cancel(), sink.cancel()])

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
  })

  test('aborts a direct file once and preserves an Output.start failure', async () => {
    const directFile = updateExportProfile(SETTINGS, { destination: 'file' })
    const failure = new Error('output start failed')
    mb.outputStartHandlers.push(async () => {
      throw failure
    })
    const close = vi.fn(async () => undefined)
    const abort = vi.fn(async () => undefined)
    const writable = {
      write: vi.fn(async () => undefined),
      close,
      abort,
    } as unknown as FileSystemWritableFileStream
    const handle = {
      name: 'failed.mp4',
      createWritable: vi.fn(async () => writable),
    } as unknown as FileSystemFileHandle

    await expect(createMediabunnyExportSink(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      directFile,
      async () => resolvedAsset(new Blob(['unused'])),
      new Map(),
      {
        fileName: 'failed.mp4',
        takeFileHandle: vi.fn(() => handle),
      },
    )).rejects.toBe(failure)

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledWith(failure)
    expect(close).not.toHaveBeenCalled()
  })

  test('configures exact-duration Opus through the patched WebM adapter', async () => {
    const audioDoc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('opus-clip', 'opus-asset', 1)),
    ])
    const profile = exportPresetById('web').profile
    const sink = await createMediabunnyExportSink(
      audioDoc,
      profile,
      async () => resolvedAsset(new Blob(['unused'])),
    )

    expect(mb.formats.at(-1)).toMatchObject({ kind: 'webm' })
    expect(audioSourceAt().encodingConfig).toEqual({
      codec: 'opus',
      bitrate: profile.audioBitrate,
      bitrateMode: profile.audioBitrateMode,
    })
    expect(fakeCanvases).toHaveLength(1)
    expect(mb.targets).toHaveLength(1)
    expect(mb.streamTargets).toHaveLength(0)
    expect(outputAt().addAudioTrack).toHaveBeenCalledWith(audioSourceAt())

    await sink.cancel()
  })
})

describe('createMediabunnyExportSink audio behavior', () => {
  test('explicit audio-off skips the mixer and output track even with audio clips', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('muted-export', 'audio-asset', 1)),
    ])
    const audioOff = updateExportProfile(SETTINGS, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })
    const resolveAsset = vi.fn(async () => resolvedAsset(new Blob(['audio'])))

    const sink = await createMediabunnyExportSink(doc, audioOff, resolveAsset)
    await sink.addFrame(0, 1_001 / 30_000)
    await sink.finalize()

    expect(resolveAsset).not.toHaveBeenCalled()
    expect(mb.audioSources).toHaveLength(0)
    expect(mb.audioSinks).toHaveLength(0)
    expect(outputAt().addAudioTrack).not.toHaveBeenCalled()
  })

  test('encodes the shared absolute equal-power crossfade plan', async () => {
    const fixture = makeAudioCrossfadeDoc()
    const decodedFrom = decodedAudioSample([
      new Float32Array(48_000).fill(1),
      new Float32Array(48_000),
    ], 48_000)
    const decodedTo = decodedAudioSample([
      new Float32Array(48_000),
      new Float32Array(48_000).fill(1),
    ], 48_000)
    mb.audioTracks.push(audioTrack(true, 2), audioTrack(true, 2))
    mb.audioSinkSampleSequences.push([decodedFrom], [decodedTo])
    const sink = await createMediabunnyExportSink(
      fixture.doc,
      SETTINGS,
      async (assetId) => resolvedAsset(new Blob([assetId])),
      fixture.sourceBounds,
    )

    const frameDuration = 1_001 / 30_000
    for (let frame = 0; frame < 6; frame++) {
      await sink.addFrame(frame * frameDuration, frameDuration)
    }
    await sink.finalize()

    const encoded = mb.encodedAudioSamples as FakeAudioSampleRecord[]
    const sampleAt = (sample: number): [number, number] => {
      const block = encoded.find((candidate) => {
        const start = Math.round(candidate.timestamp * candidate.sampleRate)
        return sample >= start && sample < start + candidate.numberOfFrames
      })
      if (!block) throw new Error(`Missing encoded sample ${sample}`)
      const start = Math.round(block.timestamp * block.sampleRate)
      const offset = (sample - start) * 2
      return [block.data[offset], block.data[offset + 1]]
    }
    const start = audioSampleBoundary(2, fixture.doc)
    const end = audioSampleBoundary(5, fixture.doc)
    const span = end - start
    for (const offset of [0, Math.floor(span / 2), span - 1]) {
      const progress = offset / span
      const [left, right] = sampleAt(start + offset)
      expect(left).toBeCloseTo(Math.cos(progress * Math.PI / 2), 5)
      expect(right).toBeCloseTo(Math.sin(progress * Math.PI / 2), 5)
    }
    expect(mb.audioSinks).toHaveLength(2)
    expect(decodedFrom.close).toHaveBeenCalledOnce()
    expect(decodedTo.close).toHaveBeenCalledOnce()
  })

  test('loads local E-AC-3 support before allocating the audio sink', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('eac3-clip', 'eac3-asset', 1)),
    ])
    const configuration: AudioDecoderConfig = {
      codec: 'ec-3',
      description: new Uint8Array([4, 5, 6]),
      numberOfChannels: 6,
      sampleRate: 48_000,
    }
    const track = audioTrack(
      () => localDecoders.ac3Registered,
      6,
      'eac3',
      configuration,
    )
    const decoded = decodedAudioSample(
      Array.from({ length: 6 }, () => new Float32Array(1_602)),
      48_000,
    )
    const registrationsBefore = localDecoders.ac3Registrations
    mb.audioTracks.push(track)
    mb.audioSinkSampleSequences.push([decoded])
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => resolvedAsset(new Blob(['eac3'])),
    )

    await sink.addFrame(0, 1_001 / 30_000)

    expect(localDecoders.ac3Registrations).toBe(registrationsBefore + 1)
    expect(track.getDecoderConfig).toHaveBeenCalledOnce()
    expect(track.canDecode).toHaveBeenCalledTimes(2)
    expect(decoderChecks.targets).toHaveLength(1)
    expect(decoderChecks.targets[0]).toMatchObject({
      codec: 'eac3',
      configuration,
      trackKind: 'audio',
      sourceId: 'eac3-asset',
      boundary: 'export-audio',
      policy: 'revalidate',
    })
    expect(decoderChecks.targets[0].configuration).toBe(configuration)
    expect(audioSinkAt().track).toBe(track)
    await sink.cancel()
  })

  test('preserves an E-AC-3 resource limit and allocates no audio sink', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('eac3-clip', 'large-eac3', 1)),
    ])
    const track = audioTrack(false, 6, 'eac3')
    const registrationsBefore = localDecoders.ac3Registrations
    mb.audioTracks.push(track)
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => ({
        blob: new Blob(['eac3']),
        kind: 'audio',
        budget: {
          ...DECODE_BUDGET,
          fileBytes: LOCAL_DECODER_LIMITS.maxFileBytes + 1,
        },
      }),
    )

    const failure = await sink.addFrame(0, 1_001 / 30_000)
      .catch((cause) => cause)

    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'large-eac3',
      failure: {
        surface: 'export',
        trackKind: 'audio',
        reason: 'resource-limit',
      },
    })
    expect(localDecoders.ac3Registrations).toBe(registrationsBefore)
    expect(mb.audioSinks).toHaveLength(0)
    expect(inputAt().dispose).toHaveBeenCalledOnce()
    await sink.cancel()
  })

  test('registers AAC, resamples mono, and writes the exact NTSC sample schedule with closed resources', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack(
        'A1',
        makeAudioClip('audio-clip', 'audio-asset', 3),
      ),
    ])
    const nativeMono = new Float32Array(3_000)
    nativeMono[1] = 1
    const decoded = decodedAudioSample([nativeMono], 24_000)
    const track = audioTrack(true, 1)
    const resolveAsset = vi.fn(async () => resolvedAsset(new Blob(['audio'])))
    mb.audioTracks.push(track)
    mb.audioSinkSampleSequences.push([decoded])

    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

    expect(mb.canEncodeAudio).not.toHaveBeenCalled()
    expect(audioSourceAt().encodingConfig).toEqual({
      codec: SETTINGS.audioCodec,
      bitrate: SETTINGS.audioBitrate,
      bitrateMode: SETTINGS.audioBitrateMode,
      onEncodedPacket: expect.any(Function),
    })
    const encodingConfig = audioSourceAt().encodingConfig as {
      onEncodedPacket(packet: { timestamp: number; duration: number }): void
    }
    const paddedPacket = {
      timestamp: 4_096 / 48_000,
      duration: 1_024 / 48_000,
    }
    encodingConfig.onEncodedPacket(paddedPacket)
    expect(paddedPacket.duration).toBe(709 / 48_000)
    expect(outputAt().addAudioTrack).toHaveBeenCalledWith(audioSourceAt())

    const frameDuration = 1_001 / 30_000
    for (let frame = 0; frame < 3; frame++) {
      await sink.addFrame(frame * frameDuration, frameDuration)
    }
    await sink.finalize()

    const encoded = mb.encodedAudioSamples as FakeAudioSampleRecord[]
    expect(encoded.map((sample) => sample.numberOfFrames)).toEqual([
      1_024,
      578,
      1_024,
      577,
      1_024,
      578,
    ])
    expect(encoded.map((sample) => sample.timestamp)).toEqual(
      [0, 1_024, 1_602, 2_626, 3_203, 4_227].map(
        (sample) => sample / 48_000,
      ),
    )
    expect(
      encoded.reduce((total, sample) => total + sample.numberOfFrames, 0),
    ).toBe(4_805)
    expect([...encodedAudioSampleAt().data.slice(0, 8)]).toEqual([
      0,
      0,
      0.5,
      0.5,
      1,
      1,
      0.5,
      0.5,
    ])

    expect(audioSinkAt().samples).toHaveBeenCalledWith(0)
    expect(decoded.copyTo).toHaveBeenCalledOnce()
    expect(decoded.copyTo.mock.calls[0][1]).toEqual({
      planeIndex: 0,
      format: 'f32-planar',
    })
    expect(decoded.close).toHaveBeenCalledOnce()
    expect(encoded.every((sample) => sample.close.mock.calls.length === 1)).toBe(
      true,
    )
    expect(audioIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
    expect(audioSourceAt().close).toHaveBeenCalledOnce()
    expect(canvasSourceAt().close).toHaveBeenCalledOnce()
    expect(outputAt().finalize).toHaveBeenCalledOnce()
    expect(outputAt().cancel).not.toHaveBeenCalled()
  })

  test('encodes a mono layout by averaging the bounded stereo mix bus', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('mono-output', 'audio-asset', 1)),
    ])
    const left = new Float32Array(2_000).fill(0.8)
    const right = new Float32Array(2_000).fill(0.2)
    const decoded = decodedAudioSample([left, right], 48_000)
    mb.audioTracks.push(audioTrack(true, 2))
    mb.audioSinkSampleSequences.push([decoded])
    const profile = updateExportProfile(SETTINGS, {
      audioChannelLayout: 'mono',
      audioBitrate: 96_000,
      audioBitrateMode: 'constant',
    })
    const sink = await createMediabunnyExportSink(
      doc,
      profile,
      async () => resolvedAsset(new Blob(['stereo-source'])),
    )

    await sink.addFrame(0, 1_001 / 30_000)
    const result = await sink.finalize()

    expect(audioSourceAt().encodingConfig).toMatchObject({
      codec: 'aac',
      bitrate: 96_000,
      bitrateMode: 'constant',
      onEncodedPacket: expect.any(Function),
    })
    const encoded = mb.encodedAudioSamples as FakeAudioSampleRecord[]
    expect(encoded).toHaveLength(2)
    expect(encoded.every((sample) => sample.numberOfChannels === 1)).toBe(true)
    expect(encoded.every((sample) => (
      [...sample.data].every((value) => Math.abs(value - 0.5) < 1e-6)
    ))).toBe(true)
    expect(result.profile.audioChannelLayout).toBe('mono')
  })

  test('downmixes 5.1 audio to the stereo export bus', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('surround', 'surround-asset', 1)),
    ])
    const values = [0.05, 0.1, 0.05, 0.02, 0.05, 0.1]
    const decoded = decodedAudioSample(
      values.map((value) => new Float32Array(2_000).fill(value)),
      48_000,
    )
    mb.audioTracks.push(audioTrack(true, 6))
    mb.audioSinkSampleSequences.push([decoded])
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => resolvedAsset(new Blob(['surround'])),
    )

    await sink.addFrame(0, 1_001 / 30_000)
    await sink.finalize()

    const data = encodedAudioSampleAt().data
    expect(data[0]).toBeCloseTo(0.05 + 0.05 * Math.SQRT1_2 + 0.01 + 0.05 * Math.SQRT1_2)
    expect(data[1]).toBeCloseTo(0.1 + 0.05 * Math.SQRT1_2 + 0.01 + 0.1 * Math.SQRT1_2)
    expect(decoded.copyTo).toHaveBeenCalledTimes(6)
    expect(decoded.close).toHaveBeenCalledOnce()
  })

  test('awaits audio backpressure and cancellation closes active decode resources exactly once', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack(
        'A1',
        makeAudioClip('long-audio', 'audio-asset', 2),
      ),
    ])
    const decoded = decodedAudioSample(
      [new Float32Array(4_000).fill(0.25)],
      48_000,
    )
    const firstAdd = deferred<void>()
    mb.audioTracks.push(audioTrack())
    mb.audioSinkSampleSequences.push([decoded])
    mb.audioSourceAddHandlers.push(async () => firstAdd.promise)
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => resolvedAsset(new Blob(['audio'])),
    )

    let settled = false
    const pending = sink.addFrame(0, 1_001 / 30_000)
    void pending.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(audioSourceAt().add).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(encodedAudioSampleAt().close).not.toHaveBeenCalled()

    firstAdd.resolve()
    await pending
    expect(audioSourceAt().add).toHaveBeenCalledTimes(2)
    expect(settled).toBe(true)

    await sink.cancel()
    await sink.cancel()
    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(audioIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
    expect(decoded.close).toHaveBeenCalledOnce()
    expect(
      (mb.encodedAudioSamples as FakeAudioSampleRecord[]).every(
        (sample) => sample.close.mock.calls.length === 1,
      ),
    ).toBe(true)
    expect(audioSourceAt().close).not.toHaveBeenCalled()
  })

  test('waits for the sibling audio write before cleaning up a failed video write', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('audio', 'audio-asset', 1)),
    ])
    const decoded = decodedAudioSample(
      [new Float32Array(2_000).fill(0.25)],
      48_000,
    )
    const audioAdd = deferred<void>()
    const primary = new Error('video write failed')
    mb.audioTracks.push(audioTrack())
    mb.audioSinkSampleSequences.push([decoded])
    mb.canvasSourceAddHandlers.push(async () => {
      throw primary
    })
    mb.audioSourceAddHandlers.push(async () => audioAdd.promise)
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => resolvedAsset(new Blob(['audio'])),
    )

    let rejected = false
    const pending = sink.addFrame(0, 1_001 / 30_000)
    void pending.catch(() => {
      rejected = true
    })
    await vi.waitFor(() => expect(audioSourceAt().add).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(rejected).toBe(false)

    audioAdd.resolve()
    await expect(pending).rejects.toBe(primary)
    expect(audioSourceAt().add).toHaveBeenCalledTimes(2)
    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(
      (mb.encodedAudioSamples as FakeAudioSampleRecord[]).every(
        (sample) => sample.close.mock.calls.length === 1,
      ),
    ).toBe(true)
    expect(audioIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })

  test('mute, solo exclusion, and zero volume avoid decoding while exact silence is still encoded', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack(
        'A-muted',
        makeAudioClip('muted', 'asset-muted', 1),
        { muted: true },
      ),
      makeAudioTrack(
        'A-nonsolo',
        makeAudioClip('nonsolo', 'asset-nonsolo', 1),
      ),
      makeAudioTrack(
        'A-solo-zero',
        makeAudioClip('solo-zero', 'asset-zero', 1, { volume: 0 }),
        { solo: true },
      ),
    ])
    const resolveAsset = vi.fn(async () => (
      resolvedAsset(new Blob(['should-not-open']))
    ))
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

    await sink.addFrame(0, 1_001 / 30_000)
    await sink.finalize()

    expect(resolveAsset).not.toHaveBeenCalled()
    expect(mb.inputs).toHaveLength(0)
    expect(mb.audioSinks).toHaveLength(0)
    expect(outputAt().addAudioTrack).toHaveBeenCalledOnce()
    const encoded = mb.encodedAudioSamples as FakeAudioSampleRecord[]
    expect(encoded.map((sample) => sample.numberOfFrames)).toEqual([
      1_024,
      578,
    ])
    expect(encoded.every((sample) => sample.data.every((value) => value === 0))).toBe(
      true,
    )
    expect(encoded.every((sample) => sample.close.mock.calls.length === 1)).toBe(
      true,
    )
    expect(audioSourceAt().close).toHaveBeenCalledOnce()
  })

  test.each([
    ['has no audio track', 'missing', 'decode-failed'],
    ['audio cannot be decoded', 'undecodable', 'unsupported-codec'],
  ])('fails when an audible asset %s and cleans up exactly once', async (
    message,
    kind,
    reason,
  ) => {
    const doc = makeAudioDoc([
      makeAudioTrack(
        'A1',
        makeAudioClip('bad-audio', 'bad-asset', 1),
      ),
    ])
    mb.audioTracks.push(kind === 'missing' ? null : audioTrack(false))
    const resolveAsset = vi.fn(async () => resolvedAsset(new Blob(['bad'])))
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

    const failure = await sink.addFrame(0, 1_001 / 30_000)
      .catch((cause) => cause)
    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'bad-asset',
      message: expect.stringContaining(message),
      failure: {
        surface: 'export',
        trackKind: 'audio',
        reason,
        detail: expect.stringContaining(message),
      },
    })
    await sink.cancel()

    expect(resolveAsset).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(audioSourceAt().add).not.toHaveBeenCalled()
    expect(audioSourceAt().close).not.toHaveBeenCalled()
    expect(mb.audioSinks).toHaveLength(0)
  })

  test('types audio Blob and decoded-sample read failures with the exact asset id', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('bad-audio', 'bad-asset', 1)),
    ])
    const unavailable = new Error('audio Blob is unavailable')
    const unavailableSink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => { throw unavailable },
    )

    const sourceFailure = await unavailableSink.addFrame(0, 1_001 / 30_000)
      .catch((cause) => cause)
    expect(sourceFailure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(sourceFailure).toMatchObject({
      assetId: 'bad-asset',
      failure: {
        surface: 'export',
        trackKind: null,
        reason: 'resource-unavailable',
        detail: unavailable.message,
      },
    })
    expect(sourceFailure.cause).toBe(unavailable)

    const decoded = decodedAudioSample([new Float32Array([0.25])], 48_000)
    const readFailure = new Error('decoded plane read failed')
    decoded.copyTo.mockImplementationOnce(() => { throw readFailure })
    mb.audioTracks.push(audioTrack())
    mb.audioSinkSampleSequences.push([decoded])
    const readSink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => resolvedAsset(new Blob(['audio'])),
    )
    const typedReadFailure = await readSink.addFrame(0, 1_001 / 30_000)
      .catch((cause) => cause)
    expect(typedReadFailure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(typedReadFailure).toMatchObject({
      assetId: 'bad-asset',
      failure: {
        surface: 'export',
        trackKind: 'audio',
        reason: 'decode-failed',
        detail: readFailure.message,
      },
    })
    expect(typedReadFailure.cause).toBe(readFailure)
    expect(decoded.close).toHaveBeenCalledOnce()
  })
})
