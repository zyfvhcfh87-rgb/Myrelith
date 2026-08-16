import { describe, expect, test, vi } from 'vitest'
import { PLUGIN_ACTIVATION_SENTINEL_KEY } from './pluginSafetyController'
import { createPluginStartupController } from './pluginStartupController'

function storageWith(value: string | null) {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }
}

describe('plugin startup controller', () => {
  test('clean startup is normal and import-time construction does no package work', () => {
    const storage = storageWith(null)
    const controller = createPluginStartupController(storage)
    expect(storage.getItem).toHaveBeenCalledOnce()
    expect(storage.getItem).toHaveBeenCalledWith(PLUGIN_ACTIVATION_SENTINEL_KEY)
    expect(controller.getSnapshot()).toEqual({
      mode: 'normal',
      sentinelStatus: 'clean',
      safeModeRecommended: false,
      recommendationReason: '',
      staleBatchId: null,
    })
    expect(controller.getSessionSafety().thirdPartyInitializationAllowed()).toBe(true)
  })

  test('stale activation requires one explicit reviewed-normal or safe-mode choice', () => {
    const controller = createPluginStartupController(storageWith(JSON.stringify({
      version: 1,
      batchId: 'previous-batch',
    })))
    const listener = vi.fn()
    controller.subscribe(listener)

    expect(controller.getSnapshot()).toMatchObject({
      mode: 'review-required',
      sentinelStatus: 'stale-activation',
      safeModeRecommended: true,
      staleBatchId: 'previous-batch',
    })
    expect(controller.getSessionSafety().thirdPartyInitializationAllowed()).toBe(false)
    expect(controller.continueWithReviewedNormalStartup()).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      mode: 'normal',
      safeModeRecommended: false,
      recommendationReason: '',
    })
    expect(controller.continueWithReviewedNormalStartup()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('safe mode is one-way for the session', () => {
    const controller = createPluginStartupController(storageWith(JSON.stringify({
      version: 1,
      batchId: 'previous-batch',
    })))
    expect(controller.enterSafeMode()).toBe(true)
    expect(controller.enterSafeMode()).toBe(false)
    expect(controller.continueWithReviewedNormalStartup()).toBe(false)
    expect(controller.getSnapshot().mode).toBe('safe-mode')
    expect(controller.getSessionSafety().thirdPartyInitializationAllowed()).toBe(false)
  })

  test('invalid or unavailable sentinel storage fails safe without a normal override', () => {
    const invalid = createPluginStartupController(storageWith('{nope'))
    expect(invalid.getSnapshot()).toMatchObject({
      mode: 'safe-mode',
      sentinelStatus: 'invalid-sentinel',
    })
    expect(invalid.continueWithReviewedNormalStartup()).toBe(false)

    const unavailable = createPluginStartupController({
      getItem() { throw new Error('blocked') },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    expect(unavailable.getSnapshot()).toMatchObject({
      mode: 'safe-mode',
      sentinelStatus: 'storage-unavailable',
    })
    expect(unavailable.continueWithReviewedNormalStartup()).toBe(false)
  })

  test('unsubscribe stops notifications', () => {
    const controller = createPluginStartupController(storageWith(null))
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    unsubscribe()
    expect(controller.enterSafeMode()).toBe(true)
    expect(listener).not.toHaveBeenCalled()
  })

  test('session-safety transitions stay synchronized with snapshots and subscribers', () => {
    const reviewed = createPluginStartupController(storageWith(JSON.stringify({
      version: 1,
      batchId: 'previous-batch',
    })))
    const reviewedListener = vi.fn()
    reviewed.subscribe(reviewedListener)
    expect(reviewed.getSessionSafety().continueWithReviewedNormalStartup()).toBe(true)
    expect(reviewed.getSnapshot()).toMatchObject({
      mode: 'normal',
      safeModeRecommended: false,
      recommendationReason: '',
    })
    expect(reviewedListener).toHaveBeenCalledOnce()

    const safe = createPluginStartupController(storageWith(null))
    const safeListener = vi.fn()
    safe.subscribe(safeListener)
    safe.getSessionSafety().enterSafeMode()
    expect(safe.getSnapshot().mode).toBe('safe-mode')
    expect(safe.getSessionSafety().continueWithReviewedNormalStartup()).toBe(false)
    safe.getSessionSafety().enterSafeMode()
    expect(safeListener).toHaveBeenCalledOnce()
  })
})
