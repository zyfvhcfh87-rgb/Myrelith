import { describe, expect, test } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  exportPresetById,
  updateExportProfile,
} from '../domain/exportProfile'
import {
  createMediabunnyOutputFormat,
  mediabunnyExportImplementationUnavailableReason,
} from './export-mediabunny-profile'

describe('Mediabunny buffered export profile adapter', () => {
  test('matches the pinned package metadata and containment contract', () => {
    const mp4 = createMediabunnyOutputFormat('mp4')
    const webm = createMediabunnyOutputFormat('webm')

    expect(mp4.fileExtension).toBe('.mp4')
    expect(mp4.mimeType).toBe('video/mp4')
    expect(mp4.getSupportedVideoCodecs()).toEqual(
      expect.arrayContaining(['avc', 'hevc']),
    )
    expect(mp4.getSupportedAudioCodecs()).toContain('aac')

    expect(webm.fileExtension).toBe('.webm')
    expect(webm.mimeType).toBe('video/webm')
    expect(webm.getSupportedVideoCodecs()).toEqual(
      expect.arrayContaining(['vp9', 'av1']),
    )
    expect(webm.getSupportedAudioCodecs()).toContain('opus')
  })

  test('allows generalized downloads but keeps file and Opus audio gated', () => {
    expect(mediabunnyExportImplementationUnavailableReason(
      exportPresetById('hevc').profile,
      true,
    )).toBeNull()
    expect(mediabunnyExportImplementationUnavailableReason(
      exportPresetById('web').profile,
      false,
    )).toBeNull()
    expect(mediabunnyExportImplementationUnavailableReason(
      exportPresetById('web').profile,
      true,
    )).toMatch(/exact Opus end-padding metadata/)
    expect(mediabunnyExportImplementationUnavailableReason(
      updateExportProfile(DEFAULT_EXPORT_PROFILE, { destination: 'file' }),
      true,
    )).toMatch(/direct-file export adapter has not been enabled/)
  })
})
