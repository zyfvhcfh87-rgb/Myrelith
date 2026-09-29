import { afterEach, describe, expect, test, vi } from 'vitest'
import type { EditorRuntimeOwner } from '../editorRuntimeLifecycle'

const inspection = vi.hoisted(() => ({
  inspectMediaFileCompatibility: vi.fn(),
}))
vi.mock('../mediaInspection', () => inspection)

/** Fresh seam + deps, so each test controls exactly which owners have loaded. */
async function loadRealDeps() {
  vi.resetModules()
  const lifecycle = await import('../editorRuntimeLifecycle')
  const { projectControllerRealDeps } = await import('./dependencies')
  return { register: lifecycle.registerLoadedEditorRuntime, deps: projectControllerRealDeps }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

afterEach(() => {
  inspection.inspectMediaFileCompatibility.mockReset()
})

describe('projectControllerRealDeps editor runtime teardown', () => {
  test('tears loaded owners down in the fixed project order, awaiting each step', async () => {
    const { register, deps } = await loadRealDeps()
    const calls: EditorRuntimeOwner[] = []
    const sourcePlaybackDrained = deferred()
    const log = (owner: EditorRuntimeOwner) => () => { calls.push(owner) }
    register('voiceoverCapture', async () => { calls.push('voiceoverCapture') })
    register('avCapture', async () => { calls.push('avCapture') })
    register('sourcePlayback', async () => {
      calls.push('sourcePlayback')
      await sourcePlaybackDrained.promise
    })
    register('transport', async () => { calls.push('transport') })
    register('multicamMonitor', log('multicamMonitor'))
    register('sourcePreview', async () => { calls.push('sourcePreview') })
    register('preview', async () => { calls.push('preview') })
    register('mediaVisuals', log('mediaVisuals'))
    register('mediaImport', log('mediaImport'))

    await deps.disposeVoiceoverCapture?.()
    const transport = deps.disposeTransport()
    await Promise.resolve()
    // Source playback must release its Blobs before Program transport stops.
    expect(calls).toEqual(['voiceoverCapture', 'avCapture', 'sourcePlayback'])
    sourcePlaybackDrained.resolve()
    await transport
    await deps.disposePreview()
    deps.disposeMediaVisuals()
    deps.resetMediaImport()

    expect(calls).toEqual([
      'voiceoverCapture',
      'avCapture',
      'sourcePlayback',
      'transport',
      'multicamMonitor',
      'sourcePreview',
      'preview',
      'mediaVisuals',
      'mediaImport',
    ])
  })

  test('skips owners whose modules never loaded', async () => {
    const { register, deps } = await loadRealDeps()
    const preview = vi.fn(async () => {})
    register('preview', preview)

    await expect(deps.disposeVoiceoverCapture?.()).resolves.toBeUndefined()
    await expect(deps.disposeTransport()).resolves.toBeUndefined()
    await expect(deps.disposePreview()).resolves.toBeUndefined()
    expect(() => deps.disposeMediaVisuals()).not.toThrow()
    expect(() => deps.resetMediaImport()).not.toThrow()
    expect(preview).toHaveBeenCalledOnce()
  })

  test('asks both capture owners and rethrows the first failure', async () => {
    const { register, deps } = await loadRealDeps()
    const failure = new Error('voiceover draft is still writing')
    const avCapture = vi.fn(async () => {})
    register('voiceoverCapture', async () => { throw failure })
    register('avCapture', avCapture)

    await expect(deps.disposeVoiceoverCapture?.()).rejects.toBe(failure)
    expect(avCapture).toHaveBeenCalledOnce()
  })
})

describe('projectControllerRealDeps media inspection', () => {
  test('loads inspection on first use and forwards the exact request', async () => {
    const { deps } = await loadRealDeps()
    const result = { status: 'unsupported', asset: null, compatibility: {} }
    inspection.inspectMediaFileCompatibility.mockResolvedValue(result)
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' })
    const rate = { num: 30, den: 1 }
    const signal = new AbortController().signal

    await expect(deps.inspectMedia(file, rate, 'asset-1', signal)).resolves.toBe(result)
    expect(inspection.inspectMediaFileCompatibility)
      .toHaveBeenCalledWith(file, rate, 'asset-1', signal)
  })
})
