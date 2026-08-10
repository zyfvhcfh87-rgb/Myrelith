import { beforeEach, describe, expect, test } from 'vitest'
import { useProxyStore, type ProxyAssetState } from './proxyStore'

const item = (phase: ProxyAssetState['phase']): ProxyAssetState => ({
  assetId: 'asset-1',
  phase,
  progress: phase === 'generating' ? 0.5 : 0,
  detail: phase,
  canGenerate: phase !== 'generating',
  originalAvailable: true,
  entry: null,
})

describe('proxyStore', () => {
  beforeEach(() => useProxyStore.getState().reset())

  test('publishes only serializable cache facts and bounded progress', () => {
    useProxyStore.getState().setAsset(item('generating'))
    expect(useProxyStore.getState().assets.get('asset-1')).toEqual(item('generating'))
    expect(JSON.parse(JSON.stringify(
      [...useProxyStore.getState().assets.values()],
    ))).toEqual([item('generating')])
  })

  test('replaces and removes asset rows without retaining stale entries', () => {
    useProxyStore.getState().replaceAssets([item('ready')])
    expect(useProxyStore.getState().assets).toHaveLength(1)
    useProxyStore.getState().removeAsset('asset-1')
    expect(useProxyStore.getState().assets).toHaveLength(0)
  })
})
