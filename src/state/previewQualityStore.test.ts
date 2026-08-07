import { beforeEach, describe, expect, test } from 'vitest'
import { usePreviewQualityStore } from './previewQualityStore'

beforeEach(() => {
  usePreviewQualityStore.setState({ qualityMode: 'auto' })
})

describe('previewQualityStore', () => {
  test('defaults to Auto and updates the session-only quality mode', () => {
    expect(usePreviewQualityStore.getState().qualityMode).toBe('auto')
    usePreviewQualityStore.getState().setQualityMode('quarter')
    expect(usePreviewQualityStore.getState().qualityMode).toBe('quarter')
  })
})
