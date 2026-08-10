import { beforeEach, describe, expect, test } from 'vitest'
import { analyzeVideoScopes } from '../domain/videoScopes'
import { useVideoScopesStore } from './videoScopesStore'

const analysis = analyzeVideoScopes(
  new Uint8ClampedArray([255, 255, 255, 255]),
  1,
  1,
)

describe('videoScopesStore', () => {
  beforeEach(() => useVideoScopesStore.getState().reset())

  test('reports capability fallback and clears resources when disabled', () => {
    useVideoScopesStore.getState().setRendererSupported(false)
    useVideoScopesStore.getState().setEnabled(true, 1)
    expect(useVideoScopesStore.getState()).toMatchObject({
      enabled: true,
      status: 'unsupported',
      analysis: null,
    })

    useVideoScopesStore.getState().setEnabled(false, 2)
    expect(useVideoScopesStore.getState()).toMatchObject({
      enabled: false,
      generation: 2,
      status: 'idle',
      analysis: null,
      frame: null,
    })
  })

  test('accepts only the active enabled generation', () => {
    useVideoScopesStore.getState().setRendererSupported(true)
    useVideoScopesStore.getState().setEnabled(true, 9)
    useVideoScopesStore.getState().acceptAnalysis(8, 2, 10, analysis)
    expect(useVideoScopesStore.getState().analysis).toBeNull()

    useVideoScopesStore.getState().acceptAnalysis(9, 3, 20, analysis)
    expect(useVideoScopesStore.getState()).toMatchObject({
      status: 'ready',
      analysis,
      frame: 3,
      analyzedAt: 20,
    })
  })
})
