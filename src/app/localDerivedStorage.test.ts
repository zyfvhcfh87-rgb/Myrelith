import { describe, expect, test, vi } from 'vitest'
import { createDisposableStorageController } from './localDerivedStorage'

describe('disposable local storage registry', () => {
  test('estimates and clears only explicitly registered providers', async () => {
    const firstClear = vi.fn(async () => undefined)
    const secondClear = vi.fn(async () => undefined)
    const controller = createDisposableStorageController([
      {
        id: 'proxy-cache',
        estimate: vi.fn(async () => ({ bytes: 64, itemCount: 2 })),
        clear: firstClear,
      },
      {
        id: 'thumbnail-cache',
        estimate: vi.fn(async () => ({ bytes: 32, itemCount: 1 })),
        clear: secondClear,
      },
    ])

    await expect(controller.estimate()).resolves.toEqual({
      bytes: 96,
      itemCount: 3,
    })
    await controller.clear()
    expect(firstClear).toHaveBeenCalledOnce()
    expect(secondClear).toHaveBeenCalledOnce()
  })

  test('rejects ambiguous providers and invalid usage instead of broad cleanup', async () => {
    const provider = {
      id: 'cache',
      estimate: vi.fn(async () => ({ bytes: -1, itemCount: 0 })),
      clear: vi.fn(async () => undefined),
    }
    expect(() => createDisposableStorageController([provider, provider]))
      .toThrow('ids must be unique')
    await expect(createDisposableStorageController([provider]).estimate())
      .rejects.toThrow('invalid usage')
  })
})
