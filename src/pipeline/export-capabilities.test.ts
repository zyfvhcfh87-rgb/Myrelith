import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  exportPresetById,
  updateExportProfile,
  type ExportProfile,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import {
  checkExportProfileSupport,
  exportAudioChannelCount,
  exportProfileIncludesAudio,
  verifyExportProfileSupportFresh,
  type ExportCapabilityProbe,
  type ExportFormatCapabilities,
} from './export-capabilities'

function makeDoc(includeAudio = true): TimelineDoc {
  return {
    schemaVersion: 19,
    id: 'capability-doc',
    name: 'Capability fixture',
    frameRate: { num: 30_000, den: 1_001 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: includeAudio
      ? [{
          id: 'A1',
          kind: 'audio',
          name: 'A1',
          clips: [{
            id: 'audio-clip',
            assetId: 'audio-asset',
            name: 'audio.wav',
            sourceMode: 'timed',
            sourceRange: { startFrame: 0, durationFrames: 30 },
            timelineRange: { startFrame: 0, durationFrames: 30 },
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
          }],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        }]
      : [],
  }
}

function formatFor(profile: ExportProfile): ExportFormatCapabilities {
  return {
    fileExtension: `.${profile.fileExtension}`,
    mimeType: profile.mimeType,
    getSupportedVideoCodecs: () => [profile.videoCodec],
    getSupportedAudioCodecs: () => profile.audioCodec ? [profile.audioCodec] : [],
  }
}

interface ProbeHarness {
  probe: ExportCapabilityProbe
  createFormat: ReturnType<typeof vi.fn>
  getImplementationUnavailableReason: ReturnType<typeof vi.fn>
  canEncodeVideo: ReturnType<typeof vi.fn>
  canEncodeAudio: ReturnType<typeof vi.fn>
  freshEncode: ReturnType<typeof vi.fn>
}

function makeProbe(profile: ExportProfile = DEFAULT_EXPORT_PROFILE): ProbeHarness {
  const createFormat = vi.fn(() => formatFor(profile))
  const getImplementationUnavailableReason = vi.fn(() => null)
  const canEncodeVideo = vi.fn(async () => true)
  const canEncodeAudio = vi.fn(async () => true)
  const freshEncode = vi.fn(async () => undefined)
  return {
    probe: {
      createFormat,
      getImplementationUnavailableReason,
      canEncodeVideo,
      canEncodeAudio,
      freshEncode,
    },
    createFormat,
    getImplementationUnavailableReason,
    canEncodeVideo,
    canEncodeAudio,
    freshEncode,
  }
}

describe('checkExportProfileSupport', () => {
  test('checks containment then probes the exact project and profile fields', async () => {
    const doc = makeDoc()
    const harness = makeProbe()

    const result = await checkExportProfileSupport(
      doc,
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
    )

    expect(result).toEqual({
      profile: DEFAULT_EXPORT_PROFILE,
      supported: true,
      reason: null,
    })
    expect(result.profile).not.toBe(DEFAULT_EXPORT_PROFILE)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.profile)).toBe(true)
    expect(harness.createFormat).toHaveBeenCalledWith('mp4')
    expect(harness.canEncodeVideo).toHaveBeenCalledWith('avc', {
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      bitrateMode: 'variable',
    })
    expect(harness.canEncodeAudio).toHaveBeenCalledWith('aac', {
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 192_000,
      bitrateMode: 'variable',
    })
    expect(harness.freshEncode).not.toHaveBeenCalled()
  })

  test('fails containment before probing encoders', async () => {
    const harness = makeProbe()
    harness.createFormat.mockReturnValue({
      fileExtension: '.mp4',
      mimeType: 'video/mp4',
      getSupportedVideoCodecs: () => [],
      getSupportedAudioCodecs: () => ['aac'],
    })

    const result = await checkExportProfileSupport(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
    )

    expect(result.supported).toBe(false)
    expect(result.reason).toMatch(/MP4 cannot contain AVC/)
    expect(harness.canEncodeVideo).not.toHaveBeenCalled()
    expect(harness.canEncodeAudio).not.toHaveBeenCalled()
  })

  test('never reports a native capability before the production sink is wired', async () => {
    const harness = makeProbe()
    const reason = 'The selected profile is not wired into the production sink.'
    harness.getImplementationUnavailableReason.mockReturnValue(reason)

    await expect(checkExportProfileSupport(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
    )).resolves.toMatchObject({ supported: false, reason })
    await expect(verifyExportProfileSupportFresh(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
    )).resolves.toMatchObject({ supported: false, reason })

    expect(harness.canEncodeVideo).not.toHaveBeenCalled()
    expect(harness.canEncodeAudio).not.toHaveBeenCalled()
    expect(harness.freshEncode).not.toHaveBeenCalled()
  })

  test('rejects package metadata disagreement before encoder probes', async () => {
    const harness = makeProbe()
    harness.createFormat.mockReturnValue({
      ...formatFor(DEFAULT_EXPORT_PROFILE),
      mimeType: 'video/not-mp4',
    })

    const result = await checkExportProfileSupport(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
    )

    expect(result.supported).toBe(false)
    expect(result.reason).toMatch(/adapter reports/)
    expect(harness.canEncodeVideo).not.toHaveBeenCalled()
  })

  test('turns a container capability query failure into a readable result', async () => {
    const harness = makeProbe()
    harness.createFormat.mockReturnValue({
      fileExtension: '.mp4',
      mimeType: 'video/mp4',
      getSupportedVideoCodecs: () => {
        throw new Error('format query failed')
      },
      getSupportedAudioCodecs: () => ['aac'],
    })

    const result = await checkExportProfileSupport(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
    )

    expect(result).toMatchObject({
      supported: false,
      reason: 'Could not inspect MP4 container support: format query failed',
    })
    expect(harness.canEncodeVideo).not.toHaveBeenCalled()
  })

  test('reports unsupported and thrown video probes without trying audio', async () => {
    const unsupportedHarness = makeProbe()
    unsupportedHarness.canEncodeVideo.mockResolvedValue(false)
    const unsupported = await checkExportProfileSupport(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      unsupportedHarness.probe,
    )
    expect(unsupported.reason).toBe(
      'This browser cannot encode AVC video at 1920 x 1080 and 8000000 bps.',
    )
    expect(unsupportedHarness.canEncodeAudio).not.toHaveBeenCalled()

    const thrownHarness = makeProbe()
    thrownHarness.canEncodeVideo.mockRejectedValue(new Error('encoder vanished'))
    const thrown = await checkExportProfileSupport(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      thrownHarness.probe,
    )
    expect(thrown.reason).toBe(
      'Could not check AVC video support: encoder vanished',
    )
    expect(thrownHarness.canEncodeAudio).not.toHaveBeenCalled()
  })

  test('reports unsupported and thrown audio probes after video succeeds', async () => {
    const unsupportedHarness = makeProbe()
    unsupportedHarness.canEncodeAudio.mockResolvedValue(false)
    const unsupported = await checkExportProfileSupport(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      unsupportedHarness.probe,
    )
    expect(unsupported.reason).toBe(
      'This browser cannot encode AAC stereo audio at 48000 Hz and 192000 bps.',
    )

    const highRateDoc = { ...makeDoc(), audioSampleRate: 96_000 }
    const highRateHarness = makeProbe()
    await checkExportProfileSupport(
      highRateDoc,
      DEFAULT_EXPORT_PROFILE,
      highRateHarness.probe,
    )
    expect(highRateHarness.canEncodeAudio).toHaveBeenCalledWith('aac', {
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 192_000,
      bitrateMode: 'variable',
    })

    const thrownHarness = makeProbe()
    thrownHarness.canEncodeAudio.mockRejectedValue('audio probe failed')
    const thrown = await checkExportProfileSupport(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      thrownHarness.probe,
    )
    expect(thrown.reason).toBe(
      'Could not check AAC audio support: audio probe failed',
    )
  })

  test('does not probe an encoder for explicitly disabled or absent timeline audio', async () => {
    const off = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })
    const offHarness = makeProbe(off)
    expect((await checkExportProfileSupport(
      makeDoc(),
      off,
      offHarness.probe,
    )).supported).toBe(true)
    expect(offHarness.canEncodeAudio).not.toHaveBeenCalled()

    const absentHarness = makeProbe()
    expect((await checkExportProfileSupport(
      makeDoc(false),
      DEFAULT_EXPORT_PROFILE,
      absentHarness.probe,
    )).supported).toBe(true)
    expect(absentHarness.canEncodeAudio).not.toHaveBeenCalled()
  })

  test('maps mono to one exact output channel', async () => {
    const mono = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioChannelLayout: 'mono',
    })
    const harness = makeProbe(mono)

    expect((await checkExportProfileSupport(
      makeDoc(),
      mono,
      harness.probe,
    )).supported).toBe(true)
    expect(harness.canEncodeAudio).toHaveBeenCalledWith('aac', expect.objectContaining({
      numberOfChannels: 1,
    }))
    expect(exportAudioChannelCount(mono)).toBe(1)
  })

  test('probes WebM Opus audio after exact muxer tail metadata is available', async () => {
    const web = exportPresetById('web').profile
    const harness = makeProbe(web)

    const result = await checkExportProfileSupport(makeDoc(), web, harness.probe)

    expect(result.supported).toBe(true)
    expect(harness.canEncodeVideo).toHaveBeenCalledWith('vp9', expect.any(Object))
    expect(harness.canEncodeAudio).toHaveBeenCalledWith(
      'opus',
      expect.objectContaining({
        bitrate: web.audioBitrate,
        bitrateMode: web.audioBitrateMode,
        numberOfChannels: 2,
        sampleRate: 48_000,
      }),
    )
  })

  test('allows WebM video probing when the exact project needs no audio track', async () => {
    const web = exportPresetById('web').profile
    const harness = makeProbe(web)

    const result = await checkExportProfileSupport(
      makeDoc(false),
      web,
      harness.probe,
    )

    expect(result.supported).toBe(true)
    expect(harness.canEncodeVideo).toHaveBeenCalledWith('vp9', expect.any(Object))
    expect(harness.canEncodeAudio).not.toHaveBeenCalled()
  })

  test('validates profile and project inputs before probing', async () => {
    const harness = makeProbe()
    await expect(checkExportProfileSupport(
      { ...makeDoc(), width: 0 },
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
    )).rejects.toThrow(/width/)
    await expect(checkExportProfileSupport(
      makeDoc(),
      { ...DEFAULT_EXPORT_PROFILE, videoBitrate: -1 },
      harness.probe,
    )).rejects.toThrow(/video bitrate/)
    expect(harness.createFormat).not.toHaveBeenCalled()
  })
})

describe('verifyExportProfileSupportFresh', () => {
  test('bypasses memoized hints and invokes only a fresh exact encode', async () => {
    const doc = makeDoc()
    const harness = makeProbe()

    const result = await verifyExportProfileSupportFresh(
      doc,
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
    )

    expect(result.supported).toBe(true)
    expect(harness.canEncodeVideo).not.toHaveBeenCalled()
    expect(harness.canEncodeAudio).not.toHaveBeenCalled()
    expect(harness.freshEncode).toHaveBeenCalledWith(
      doc,
      expect.objectContaining({ container: 'mp4', videoCodec: 'avc' }),
      true,
      undefined,
    )
  })

  test('reports changed support and never substitutes another profile', async () => {
    const harness = makeProbe()
    harness.freshEncode.mockRejectedValue(new Error('hardware resources exhausted'))

    const result = await verifyExportProfileSupportFresh(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
    )

    expect(result.supported).toBe(false)
    expect(result.profile).toEqual(DEFAULT_EXPORT_PROFILE)
    expect(result.reason).toBe(
      'MP4/AVC became unavailable before encoding started: hardware resources exhausted ' +
      'No codec was substituted.',
    )
    expect(harness.freshEncode).toHaveBeenCalledTimes(1)
  })

  test('propagates cancellation instead of presenting it as unsupported', async () => {
    const harness = makeProbe()
    const abort = new AbortController()
    abort.abort(new Error('user canceled'))

    await expect(verifyExportProfileSupportFresh(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      harness.probe,
      abort.signal,
    )).rejects.toThrow('user canceled')
    expect(harness.freshEncode).not.toHaveBeenCalled()
  })
})

describe('export audio capability helpers', () => {
  test('reflect exact off, mono, stereo, and document-use semantics', () => {
    const off = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })
    const mono = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioChannelLayout: 'mono',
    })

    expect(exportAudioChannelCount(off)).toBe(0)
    expect(exportAudioChannelCount(mono)).toBe(1)
    expect(exportAudioChannelCount(DEFAULT_EXPORT_PROFILE)).toBe(2)
    expect(exportProfileIncludesAudio(makeDoc(), off)).toBe(false)
    expect(exportProfileIncludesAudio(makeDoc(), mono)).toBe(true)
    expect(exportProfileIncludesAudio(makeDoc(false), mono)).toBe(false)
  })
})
