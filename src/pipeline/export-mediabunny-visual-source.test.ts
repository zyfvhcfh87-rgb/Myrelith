import { describe, expect, test, vi } from 'vitest'
import type { ExportVideoSink } from './export'
import {
  DECODE_BUDGET,
  SETTINGS,
  adapterTestSubject,
  canvasIteratorAt,
  canvasSinkAt,
  createBitmap,
  createMediabunnyExportMediaSource,
  decoderChecks,
  deferred,
  fakeBitmaps,
  fakeCanvases,
  fakeTransitionSurfaceProvider,
  FakeOffscreenCanvas,
  inputAt,
  localDecoders,
  makeStillDoc,
  makeTransitionVideoDoc,
  makeVideoDoc,
  makeVisualTransitionDoc,
  mb,
  resolvedAsset,
  staticImageDecode,
  videoTrack,
  wrappedCanvas,
  type FakeBitmap,
} from './export-mediabunny.test-harness'

const {
  DEFAULT_EXPORT_PROFILE,
  LOCAL_DECODER_LIMITS,
  MediaAssetRuntimeError,
  StaticImageDecodeError,
  compositeFrame,
  exportTimeline,
} = adapterTestSubject

describe('createMediabunnyExportMediaSource', () => {
  test('decodes one retained still and closes it only with the export source', async () => {
    const doc = makeStillDoc()
    const blob = new Blob(['still'])
    const source = {
      width: 800,
      height: 600,
      close: vi.fn(),
    } as unknown as FakeBitmap
    staticImageDecode.decode.mockResolvedValue({
      source,
      sourceKind: 'image-bitmap',
      width: source.width,
      height: source.height,
      animation: { animated: false, frameCount: 1, loopCount: null },
      decoderRepetitionCount: null,
      decodePath: 'image-bitmap',
    })
    const resolveAsset = vi.fn(async () => resolvedAsset(blob, 'image'))
    const media = createMediabunnyExportMediaSource(doc, resolveAsset)
    const borrowed: Array<ImageBitmap | VideoFrame | null> = []

    for (let frame = 0; frame < 5; frame++) {
      const lease = await media.openFrame(frame)
      borrowed.push(await lease.getFrame('image-asset', 0))
      await lease.close()
      expect(source.close).not.toHaveBeenCalled()
    }
    await media.close()
    await media.close()

    expect(borrowed).toEqual([source, source, source, source, source])
    expect(resolveAsset).toHaveBeenCalledOnce()
    expect(resolveAsset).toHaveBeenCalledWith('image-asset')
    expect(staticImageDecode.decode).toHaveBeenCalledOnce()
    expect(staticImageDecode.decode).toHaveBeenCalledWith(blob, {
      signal: expect.any(AbortSignal),
    })
    expect(mb.inputs).toHaveLength(0)
    expect(mb.canvasSinks).toHaveLength(0)
    expect(createBitmap).not.toHaveBeenCalled()
    expect(source.close).toHaveBeenCalledOnce()
  })

  test.each([
    ['image-to-video', 'image', 'video', 4, 5, 1],
    ['video-to-image', 'video', 'image', 5, 4, 1],
    ['same-image-to-image', 'image', 'image', 0, 9, 0],
  ] as const)(
    'composites a %s crossfade with one retained still decode',
    async (
      _label,
      fromKind,
      toKind,
      expectedVideoCopies,
      expectedImageDraws,
      expectedVideoInputs,
    ) => {
      const doc = makeVisualTransitionDoc(fromKind, toKind)
      const source = {
        width: 320,
        height: 180,
        close: vi.fn(),
      } as unknown as FakeBitmap
      staticImageDecode.decode.mockResolvedValue({
        source,
        sourceKind: 'image-bitmap',
        width: source.width,
        height: source.height,
        animation: { animated: false, frameCount: 1, loopCount: null },
        decoderRepetitionCount: null,
        decodePath: 'image-bitmap',
      })
      if (expectedVideoInputs > 0) {
        mb.inputTracks.push(videoTrack())
        mb.canvasSinkHandlers.push(async () => wrappedCanvas())
      }
      const media = createMediabunnyExportMediaSource(
        doc,
        async (assetId) => resolvedAsset(
          new Blob([assetId]),
          assetId === 'image-asset' ? 'image' : 'video',
        ),
      )
      const canvas = new FakeOffscreenCanvas(doc.width, doc.height)
      const transitionSurfaceProvider = fakeTransitionSurfaceProvider(
        doc.width,
        doc.height,
      )
      const drawn: string[][] = []

      for (let frame = 0; frame < 6; frame++) {
        const lease = await media.openFrame(frame)
        const result = await compositeFrame(
          doc,
          lease.plan,
          canvas.context,
          lease,
          transitionSurfaceProvider,
        )
        drawn.push(result.drawn)
        await lease.close()
      }

      expect(drawn).toEqual([
        [`${fromKind}-from`],
        [`${fromKind}-from`],
        [`${fromKind}-from`, `${toKind}-to`],
        [`${fromKind}-from`, `${toKind}-to`],
        [`${fromKind}-from`, `${toKind}-to`],
        [`${toKind}-to`],
      ])
      expect(staticImageDecode.decode).toHaveBeenCalledOnce()
      expect(mb.inputs).toHaveLength(expectedVideoInputs)
      expect(createBitmap).toHaveBeenCalledTimes(expectedVideoCopies)
      expect(
        fakeCanvases.flatMap(
          (candidate) => candidate.context.drawImage.mock.calls,
        ).filter(([image]) => image === source),
      ).toHaveLength(expectedImageDraws)
      expect(source.close).not.toHaveBeenCalled()
      for (const bitmap of fakeBitmaps) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }

      await media.close()
      expect(source.close).toHaveBeenCalledOnce()
      if (expectedVideoInputs > 0) {
        expect(canvasIteratorAt().return).toHaveBeenCalledOnce()
        expect(inputAt().dispose).toHaveBeenCalledOnce()
      } else {
        expect(mb.canvasIterators).toHaveLength(0)
      }
    },
  )

  test('preserves static-image resource-limit identity at the export boundary', async () => {
    const decodeFailure = new StaticImageDecodeError('resource-limit', 'png')
    staticImageDecode.decode.mockRejectedValue(decodeFailure)
    const media = createMediabunnyExportMediaSource(
      makeStillDoc(1),
      async () => resolvedAsset(new Blob(['oversized']), 'image'),
    )
    const lease = await media.openFrame(0)

    const failure = await lease.getFrame('image-asset', 0).catch((cause) => cause)

    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'image-asset',
      failure: {
        surface: 'export',
        trackKind: null,
        reason: 'resource-limit',
      },
    })
    expect(failure.cause).toBe(decodeFailure)
    await lease.close()
    await media.close()
  })

  test('closes a still that finishes decoding after source shutdown', async () => {
    const decoded = deferred<{
      source: FakeBitmap
      sourceKind: 'image-bitmap'
      width: number
      height: number
      animation: {
        animated: false
        frameCount: 1
        loopCount: null
      }
      decoderRepetitionCount: null
      decodePath: 'image-bitmap'
    }>()
    const source = {
      width: 16,
      height: 16,
      close: vi.fn(),
    } as unknown as FakeBitmap
    staticImageDecode.decode.mockReturnValue(decoded.promise)
    const media = createMediabunnyExportMediaSource(
      makeStillDoc(1),
      async () => resolvedAsset(new Blob(['late']), 'image'),
    )
    const lease = await media.openFrame(0)
    const borrowed = lease.getFrame('image-asset', 0)
    const rejected = borrowed.catch((cause) => cause)
    await vi.waitFor(() => expect(staticImageDecode.decode).toHaveBeenCalledOnce())

    const closed = media.close()
    const decodeOptions = staticImageDecode.decode.mock.calls[0][1] as {
      signal: AbortSignal
    }
    expect(decodeOptions.signal.aborted).toBe(true)
    decoded.resolve({
      source,
      sourceKind: 'image-bitmap',
      width: source.width,
      height: source.height,
      animation: { animated: false, frameCount: 1, loopCount: null },
      decoderRepetitionCount: null,
      decodePath: 'image-bitmap',
    })

    await expect(rejected).resolves.toMatchObject({
      message: 'Export media source is closed',
    })
    await closed
    await lease.close()
    expect(source.close).toHaveBeenCalledOnce()
  })

  test('early export return cancels the sink and closes its retained still once', async () => {
    const doc = makeStillDoc(3)
    const source = {
      width: 64,
      height: 48,
      close: vi.fn(),
    } as unknown as FakeBitmap
    staticImageDecode.decode.mockResolvedValue({
      source,
      sourceKind: 'image-bitmap',
      width: source.width,
      height: source.height,
      animation: { animated: false, frameCount: 1, loopCount: null },
      decoderRepetitionCount: null,
      decodePath: 'image-bitmap',
    })
    const media = createMediabunnyExportMediaSource(
      doc,
      async () => resolvedAsset(new Blob(['still']), 'image'),
    )
    const openFrame = vi.spyOn(media, 'openFrame')
    const closeMedia = vi.spyOn(media, 'close')
    const canvas = new FakeOffscreenCanvas(doc.width, doc.height)
    const sink: ExportVideoSink = {
      ctx: canvas.context,
      transitionSurfaceProvider: fakeTransitionSurfaceProvider(
        doc.width,
        doc.height,
      ),
      addFrame: vi.fn(async () => undefined),
      finalize: vi.fn(async () => ({
        destination: 'download' as const,
        buffer: new ArrayBuffer(0),
        mimeType: 'video/mp4' as const,
        fileExtension: 'mp4' as const,
        profile: DEFAULT_EXPORT_PROFILE,
      })),
      cancel: vi.fn(async () => undefined),
    }
    const run = exportTimeline(doc, SETTINGS, media, {
      composite: compositeFrame,
      createVideoSink: async () => sink,
    })

    await expect(run.next()).resolves.toEqual({ done: false, value: 0 })
    await expect(run.next()).resolves.toEqual({ done: false, value: 1 / 4 })
    expect(source.close).not.toHaveBeenCalled()
    await expect(run.return(undefined)).resolves.toMatchObject({ done: true })

    expect(openFrame).toHaveBeenCalledOnce()
    expect(sink.addFrame).toHaveBeenCalledOnce()
    expect(sink.finalize).not.toHaveBeenCalled()
    expect(sink.cancel).toHaveBeenCalledOnce()
    expect(closeMedia).toHaveBeenCalledOnce()
    expect(source.close).toHaveBeenCalledOnce()
    const decodeOptions = staticImageDecode.decode.mock.calls[0][1] as {
      signal: AbortSignal
    }
    expect(decodeOptions.signal.aborted).toBe(true)
  })

  test('encoder failure stays primary while the retained still closes once', async () => {
    const doc = makeStillDoc(2)
    const source = {
      width: 64,
      height: 48,
      close: vi.fn(),
    } as unknown as FakeBitmap
    staticImageDecode.decode.mockResolvedValue({
      source,
      sourceKind: 'image-bitmap',
      width: source.width,
      height: source.height,
      animation: { animated: false, frameCount: 1, loopCount: null },
      decoderRepetitionCount: null,
      decodePath: 'image-bitmap',
    })
    const media = createMediabunnyExportMediaSource(
      doc,
      async () => resolvedAsset(new Blob(['still']), 'image'),
    )
    const openFrame = vi.spyOn(media, 'openFrame')
    const closeMedia = vi.spyOn(media, 'close')
    const primary = new Error('encoder failed')
    const canvas = new FakeOffscreenCanvas(doc.width, doc.height)
    const sink: ExportVideoSink = {
      ctx: canvas.context,
      transitionSurfaceProvider: fakeTransitionSurfaceProvider(
        doc.width,
        doc.height,
      ),
      addFrame: vi.fn(async () => {
        throw primary
      }),
      finalize: vi.fn(async () => ({
        destination: 'download' as const,
        buffer: new ArrayBuffer(0),
        mimeType: 'video/mp4' as const,
        fileExtension: 'mp4' as const,
        profile: DEFAULT_EXPORT_PROFILE,
      })),
      cancel: vi.fn(async () => undefined),
    }
    const run = exportTimeline(doc, SETTINGS, media, {
      composite: compositeFrame,
      createVideoSink: async () => sink,
    })

    await expect(run.next()).resolves.toEqual({ done: false, value: 0 })
    await expect(run.next()).rejects.toBe(primary)

    expect(openFrame).toHaveBeenCalledOnce()
    expect(sink.addFrame).toHaveBeenCalledOnce()
    expect(sink.finalize).not.toHaveBeenCalled()
    expect(sink.cancel).toHaveBeenCalledOnce()
    expect(closeMedia).toHaveBeenCalledOnce()
    expect(source.close).toHaveBeenCalledOnce()
    const decodeOptions = staticImageDecode.decode.mock.calls[0][1] as {
      signal: AbortSignal
    }
    expect(decodeOptions.signal.aborted).toBe(true)
  })

  test('uses the canonical crossfade plan for exact ordered decode timestamps', async () => {
    const doc = makeTransitionVideoDoc()
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    const media = createMediabunnyExportMediaSource(
      doc,
      async () => resolvedAsset(new Blob(['asset-a'])),
    )
    const ctx = new FakeOffscreenCanvas(doc.width, doc.height).context
    const transitionSurfaceProvider = fakeTransitionSurfaceProvider(
      doc.width,
      doc.height,
    )
    const drawn: string[][] = []

    for (let frame = 0; frame < 6; frame++) {
      const lease = await media.openFrame(frame)
      const result = await compositeFrame(
        doc,
        lease.plan,
        ctx,
        lease,
        transitionSurfaceProvider,
      )
      drawn.push(result.drawn)
      await lease.close()
    }
    await media.close()

    expect(drawn).toEqual([
      ['from'],
      ['from'],
      ['from', 'to'],
      ['from', 'to'],
      ['from', 'to'],
      ['to'],
    ])
    expect(mb.inputs).toHaveLength(1)
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledWith(
      [10, 11, 12, 19, 13, 20, 14, 21, 22].map(
        (frame) => (frame * 1_001) / 30_000,
      ),
    )
    expect(createBitmap).toHaveBeenCalledTimes(9)
    for (const bitmap of fakeBitmaps) {
      expect(bitmap.close).toHaveBeenCalledOnce()
    }
    expect(canvasIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })

  test('fails lease close when a scheduled render request was omitted', async () => {
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      async () => resolvedAsset(new Blob(['asset-a'])),
    )
    const lease = await media.openFrame(0)

    expect(() => lease.close()).toThrow(
      'Export document frame 0 received 0 of 1 scheduled media requests',
    )
    await media.close()
  })

  test('closes acquired bitmaps before reporting a partially omitted schedule', async () => {
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc(
        [
          { assetId: 'asset-a', sourceStart: 0 },
          { assetId: 'asset-b', sourceStart: 0 },
        ],
        1,
      ),
      async (assetId) => resolvedAsset(new Blob([assetId])),
    )
    const lease = await media.openFrame(0)

    const bitmap = await lease.getFrame('asset-a', 0)
    expect(bitmap).toBe(fakeBitmaps[0])
    expect(() => lease.close()).toThrow(
      'Export document frame 0 received 1 of 2 scheduled media requests',
    )
    expect(fakeBitmaps[0].close).toHaveBeenCalledOnce()

    await media.close()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })

  test('rejects an out-of-order request against the frame-local render plan', async () => {
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc(
        [
          { assetId: 'asset-a', sourceStart: 0 },
          { assetId: 'asset-b', sourceStart: 0 },
        ],
        1,
      ),
      async (assetId) => resolvedAsset(new Blob([assetId])),
    )
    const lease = await media.openFrame(0)

    await expect(lease.getFrame('asset-b', 0)).rejects.toThrow(
      'Export document frame 0 expected asset-a@0, got asset-b@0',
    )
    expect(() => lease.close()).toThrow(
      'Export document frame 0 received 0 of 2 scheduled media requests',
    )
    await media.close()
  })

  test('rejects an extra request after the frame-local render plan is consumed', async () => {
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      async () => resolvedAsset(new Blob(['asset-a'])),
    )
    const lease = await media.openFrame(0)

    await lease.getFrame('asset-a', 0)
    await expect(lease.getFrame('asset-a', 0)).rejects.toThrow(
      'Export document frame 0 received an extra media request',
    )
    await lease.close()
    await media.close()
  })

  test('opens one decoder per asset and leases stable bitmap copies', async () => {
    const doc = makeVideoDoc(
      [{ assetId: 'asset-a', sourceStart: 3 }],
      2,
    )
    const blob = new Blob(['asset-a'])
    const resolveAsset = vi.fn(async () => resolvedAsset(blob))
    const configuration: VideoDecoderConfig = {
      codec: 'avc1.64001f',
      codedHeight: 180,
      codedWidth: 320,
      description: new Uint8Array([1, 2, 3]),
    }
    const track = videoTrack(true, 'avc', configuration)
    const wrapped = wrappedCanvas()
    mb.inputTracks.push(track)
    mb.canvasSinkHandlers.push(async () => wrapped)
    const media = createMediabunnyExportMediaSource(doc, resolveAsset)

    const firstLease = await media.openFrame(0)
    const first = await firstLease.getFrame('asset-a', 3)
    await firstLease.close()
    const secondLease = await media.openFrame(1)
    const second = await secondLease.getFrame('asset-a', 4)
    await secondLease.close()
    await media.close()
    await media.close()

    expect(resolveAsset).toHaveBeenCalledOnce()
    expect(resolveAsset).toHaveBeenCalledWith('asset-a')
    expect(mb.blobSources).toHaveLength(1)
    expect(mb.blobSources[0].blob).toBe(blob)
    expect(mb.inputs).toHaveLength(1)
    expect(track.getDecoderConfig).toHaveBeenCalledOnce()
    expect(track.canDecode).toHaveBeenCalledOnce()
    expect(decoderChecks.targets).toHaveLength(1)
    expect(decoderChecks.targets[0]).toMatchObject({
      codec: 'avc',
      configuration,
      trackKind: 'video',
      sourceId: 'asset-a',
      boundary: 'export-video',
      policy: 'revalidate',
    })
    expect(decoderChecks.targets[0].configuration).toBe(configuration)
    expect(canvasSinkAt().track).toBe(track)
    expect(canvasSinkAt().options).toEqual({ poolSize: 1 })
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledOnce()
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledWith([
      3_003 / 30_000,
      4_004 / 30_000,
    ])
    expect(canvasSinkAt().getCanvas).not.toHaveBeenCalled()
    expect(createBitmap.mock.calls).toEqual([[wrapped.canvas], [wrapped.canvas]])
    expect(first).toBe(fakeBitmaps[0])
    expect(second).toBe(fakeBitmaps[1])
    expect(fakeBitmaps[0].close).toHaveBeenCalledOnce()
    expect(fakeBitmaps[1].close).toHaveBeenCalledOnce()
    expect(canvasIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })

  test('loads local ProRes support before allocating the export sink', async () => {
    const track = videoTrack(
      () => localDecoders.proresRegistered,
      'prores',
    )
    const registrationsBefore = localDecoders.proresRegistrations
    mb.inputTracks.push(track)
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'prores-asset', sourceStart: 0 }], 1),
      async () => resolvedAsset(new Blob(['prores'])),
    )
    const lease = await media.openFrame(0)

    const bitmap = await lease.getFrame('prores-asset', 0)

    expect(bitmap).toBe(fakeBitmaps[0])
    expect(localDecoders.proresRegistrations).toBe(registrationsBefore + 1)
    expect(track.canDecode).toHaveBeenCalledTimes(2)
    expect(canvasSinkAt().track).toBe(track)
    await lease.close()
    await media.close()
  })

  test('preserves a ProRes resource limit and allocates no export sink', async () => {
    const track = videoTrack(false, 'prores')
    const registrationsBefore = localDecoders.proresRegistrations
    mb.inputTracks.push(track)
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'large-prores', sourceStart: 0 }], 1),
      async () => ({
        blob: new Blob(['prores']),
        kind: 'video',
        budget: {
          ...DECODE_BUDGET,
          fileBytes: LOCAL_DECODER_LIMITS.maxFileBytes + 1,
        },
      }),
    )
    const lease = await media.openFrame(0)

    const failure = await lease.getFrame('large-prores', 0)
      .catch((cause) => cause)

    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'large-prores',
      failure: {
        surface: 'export',
        trackKind: 'video',
        reason: 'resource-limit',
      },
    })
    expect(localDecoders.proresRegistrations).toBe(registrationsBefore)
    expect(mb.canvasSinks).toHaveLength(0)
    await lease.close()
    await media.close()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })

  test('serializes same-asset canvas reuse until each bitmap copy is stable', async () => {
    const firstCanvas = deferred<unknown>()
    let request = 0
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => {
      request++
      if (request === 1) return firstCanvas.promise
      return wrappedCanvas(640, 360)
    })
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc(
        [
          { assetId: 'asset-a', sourceStart: 0 },
          { assetId: 'asset-a', sourceStart: 1 },
        ],
        1,
      ),
      async () => resolvedAsset(new Blob(['asset-a'])),
    )
    const lease = await media.openFrame(0)

    const first = lease.getFrame('asset-a', 0)
    const second = lease.getFrame('asset-a', 1)
    await vi.waitFor(() => expect(request).toBe(1))
    firstCanvas.resolve(wrappedCanvas(320, 180))

    const firstBitmap = await first
    const secondBitmap = await second
    expect(firstBitmap).toBe(fakeBitmaps[0])
    expect(secondBitmap).toBe(fakeBitmaps[1])
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledOnce()
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledWith([0, 1_001 / 30_000])
    expect(canvasSinkAt().getCanvas).not.toHaveBeenCalled()
    await lease.close()
    await media.close()
  })

  test('lets different asset decoders run concurrently', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    let started = 0
    mb.inputTracks.push(videoTrack(), videoTrack())
    mb.canvasSinkHandlers.push(
      async () => {
        started++
        return first.promise
      },
      async () => {
        started++
        return second.promise
      },
    )
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc(
        [
          { assetId: 'asset-a', sourceStart: 0 },
          { assetId: 'asset-b', sourceStart: 0 },
        ],
        1,
      ),
      async (assetId) => resolvedAsset(new Blob([assetId])),
    )
    const lease = await media.openFrame(0)

    const a = lease.getFrame('asset-a', 0)
    const b = lease.getFrame('asset-b', 0)
    await vi.waitFor(() => expect(started).toBe(2))
    first.resolve(wrappedCanvas())
    second.resolve(wrappedCanvas())

    await Promise.all([a, b])
    await lease.close()
    await media.close()
    expect(inputAt(0).dispose).toHaveBeenCalledOnce()
    expect(inputAt(1).dispose).toHaveBeenCalledOnce()
  })

  test.each([
    ['has no video track', null, 'decode-failed'],
    ['cannot be decoded', videoTrack(false), 'unsupported-codec'],
  ])('rejects an asset that %s and still disposes its input', async (
    message,
    track,
    reason,
  ) => {
    mb.inputTracks.push(track)
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      async () => resolvedAsset(new Blob(['bad'])),
    )
    const lease = await media.openFrame(0)

    const failure = await lease.getFrame('asset-a', 0).catch((cause) => cause)
    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'asset-a',
      message: expect.stringContaining(message),
      failure: {
        surface: 'export',
        trackKind: 'video',
        reason,
        detail: expect.stringContaining(message),
      },
    })
    await lease.close()
    await media.close()

    expect(inputAt().dispose).toHaveBeenCalledOnce()
    expect(mb.canvasSinks).toHaveLength(0)
  })

  test('types Blob resolution and decode-stream failures without typing bitmap-copy failures', async () => {
    const unavailable = new Error('captured Blob is unavailable')
    const unavailableMedia = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      async () => { throw unavailable },
    )
    const unavailableLease = await unavailableMedia.openFrame(0)

    const sourceFailure = await unavailableLease.getFrame('asset-a', 0)
      .catch((cause) => cause)
    expect(sourceFailure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(sourceFailure).toMatchObject({
      assetId: 'asset-a',
      message: unavailable.message,
      failure: {
        surface: 'export',
        trackKind: null,
        reason: 'resource-unavailable',
        detail: unavailable.message,
      },
    })
    expect(sourceFailure.cause).toBe(unavailable)
    await unavailableLease.close()
    await unavailableMedia.close()

    const decodeFailure = new Error('video cursor failed')
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => { throw decodeFailure })
    const decodeMedia = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-b', sourceStart: 0 }], 1),
      async () => resolvedAsset(new Blob(['asset-b'])),
    )
    const decodeLease = await decodeMedia.openFrame(0)
    const typedDecodeFailure = await decodeLease.getFrame('asset-b', 0)
      .catch((cause) => cause)
    expect(typedDecodeFailure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(typedDecodeFailure).toMatchObject({
      assetId: 'asset-b',
      failure: {
        surface: 'export',
        trackKind: 'video',
        reason: 'decode-failed',
        detail: decodeFailure.message,
      },
    })
    expect(typedDecodeFailure.cause).toBe(decodeFailure)
    await decodeLease.close()
    await decodeMedia.close()

    const bitmapFailure = new Error('bitmap copy failed')
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    createBitmap.mockRejectedValueOnce(bitmapFailure)
    const bitmapMedia = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-c', sourceStart: 0 }], 1),
      async () => resolvedAsset(new Blob(['asset-c'])),
    )
    const bitmapLease = await bitmapMedia.openFrame(0)
    await expect(bitmapLease.getFrame('asset-c', 0)).rejects.toBe(bitmapFailure)
    expect(bitmapFailure).not.toBeInstanceOf(MediaAssetRuntimeError)
    await bitmapLease.close()
    await bitmapMedia.close()
  })
})
