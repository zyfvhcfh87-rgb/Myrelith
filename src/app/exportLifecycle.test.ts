import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  disposeLoadedExport,
  registerLoadedExportDisposer,
  resetLoadedExportDisposer,
} from './exportLifecycle'

beforeEach(() => {
  resetLoadedExportDisposer()
})

describe('lazy export lifecycle', () => {
  test('does not load or invoke an export that has never registered', async () => {
    await expect(disposeLoadedExport()).resolves.toBeUndefined()
  })

  test('awaits the registered controller disposer exactly once', async () => {
    const dispose = vi.fn(async () => undefined)
    registerLoadedExportDisposer(dispose)

    await disposeLoadedExport()

    expect(dispose).toHaveBeenCalledOnce()
  })
})
