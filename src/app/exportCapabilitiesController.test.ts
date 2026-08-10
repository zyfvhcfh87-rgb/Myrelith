import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  exportPresetById,
  type ExportProfile,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import type { ExportCapabilityResult } from '../pipeline/export-capabilities'
import {
  checkCurrentExportProfile,
  getExportPresetCapabilities,
  preflightExportProfile,
  resolveExportSelection,
  type ExportCapabilitiesControllerDeps,
} from './exportCapabilitiesController'

const DOC: TimelineDoc = {
  schemaVersion: 11,
  id: 'capability-controller-doc',
  name: 'Capability controller',
  frameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  audioSampleRate: 48_000,
  tracks: [],
}

const PRESET_IDS = ['compatibility', 'web', 'modern', 'hevc'] as const

function result(
  profile: ExportProfile,
  supported: boolean,
  reason: string | null = supported ? null : 'unsupported fixture',
): Readonly<ExportCapabilityResult> {
  return Object.freeze({ profile, supported, reason })
}

function makeDeps(
  supportedIds: readonly string[] = ['compatibility'],
): ExportCapabilitiesControllerDeps & {
  getDocument: ReturnType<typeof vi.fn>
  checkProfile: ReturnType<typeof vi.fn>
  verifyProfile: ReturnType<typeof vi.fn>
} {
  const getDocument = vi.fn(() => DOC)
  const checkProfile = vi.fn(async (_doc: TimelineDoc, profile: ExportProfile) => {
    const preset = PRESET_IDS.find((id) => (
      exportPresetById(id).profile.videoCodec === profile.videoCodec
    ))
    return result(
      profile,
      preset !== undefined && supportedIds.includes(preset),
      `${preset ?? 'custom'} unavailable`,
    )
  })
  const verifyProfile = vi.fn(async (
    _doc: TimelineDoc,
    profile: ExportProfile,
  ) => result(profile, true))
  return { getDocument, checkProfile, verifyProfile }
}

describe('getExportPresetCapabilities', () => {
  test('probes only the catalog and resolves Auto in documented order', async () => {
    const deps = makeDeps(['compatibility', 'web'])

    const snapshot = await getExportPresetCapabilities(deps)

    expect(deps.getDocument).toHaveBeenCalledTimes(1)
    expect(deps.checkProfile).toHaveBeenCalledTimes(4)
    expect(deps.checkProfile.mock.calls.map((call) => call[1].videoCodec)).toEqual([
      'avc',
      'vp9',
      'av1',
      'hevc',
    ])
    expect(snapshot.autoPresetId).toBe('web')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.presets)).toBe(true)
    expect(snapshot.presets.every(Object.isFrozen)).toBe(true)
  })

  test('reports no Auto result when every documented profile is unavailable', async () => {
    const snapshot = await getExportPresetCapabilities(makeDeps([]))
    expect(snapshot.autoPresetId).toBeNull()
    expect(resolveExportSelection('auto', snapshot)).toEqual({
      selectionId: 'auto',
      presetId: null,
      profile: null,
      reason: 'No export profile supports this project in this browser.',
    })
  })
})

describe('resolveExportSelection', () => {
  test('shows the concrete Auto choice', async () => {
    const snapshot = await getExportPresetCapabilities(
      makeDeps(['compatibility', 'web', 'modern']),
    )

    expect(resolveExportSelection('auto', snapshot)).toMatchObject({
      selectionId: 'auto',
      presetId: 'modern',
      profile: { container: 'webm', videoCodec: 'av1' },
      reason: null,
    })
  })

  test('never falls back from an unavailable explicit selection', async () => {
    const snapshot = await getExportPresetCapabilities(makeDeps(['compatibility']))

    expect(resolveExportSelection('web', snapshot)).toEqual({
      selectionId: 'web',
      presetId: 'web',
      profile: null,
      reason: 'web unavailable',
    })
  })

  test('rejects a malformed capability snapshot instead of inventing a profile', () => {
    expect(() => resolveExportSelection('web', {
      presets: [],
      autoPresetId: null,
    })).toThrow(/missing export preset web/)
  })
})

describe('advanced and pre-start capability facade', () => {
  test('validates and checks one current advanced profile', async () => {
    const deps = makeDeps()
    const value = { ...DEFAULT_EXPORT_PROFILE }

    await expect(checkCurrentExportProfile(value, deps)).resolves.toMatchObject({
      supported: true,
    })
    expect(deps.checkProfile).toHaveBeenCalledWith(
      DOC,
      expect.objectContaining({ videoCodec: 'avc' }),
    )
    expect(deps.checkProfile.mock.calls[0][1]).not.toBe(value)
  })

  test('freshly verifies the exact profile and forwards cancellation', async () => {
    const deps = makeDeps()
    const abort = new AbortController()

    await preflightExportProfile(
      DOC,
      DEFAULT_EXPORT_PROFILE,
      abort.signal,
      deps,
    )

    expect(deps.verifyProfile).toHaveBeenCalledWith(
      DOC,
      expect.objectContaining({ container: 'mp4', videoCodec: 'avc' }),
      abort.signal,
    )
  })

  test('rejects changed support with the exact reason and no substitution', async () => {
    const deps = makeDeps()
    deps.verifyProfile.mockResolvedValue(result(
      DEFAULT_EXPORT_PROFILE,
      false,
      'Compatibility became unavailable. No codec was substituted.',
    ))

    await expect(preflightExportProfile(
      DOC,
      DEFAULT_EXPORT_PROFILE,
      undefined,
      deps,
    )).rejects.toThrow(
      'Compatibility became unavailable. No codec was substituted.',
    )
    expect(deps.verifyProfile).toHaveBeenCalledTimes(1)
  })
})
