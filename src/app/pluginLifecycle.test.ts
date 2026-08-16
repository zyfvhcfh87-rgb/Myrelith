import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  captureLoadedPluginLifecycleToken,
  disposeLoadedPlugins,
  registerLoadedPluginDisposer,
  resetLoadedPluginDisposer,
} from './pluginLifecycle'

beforeEach(async () => {
  await resetLoadedPluginDisposer()
})

describe('plugin lifecycle', () => {
  test('does not load anything when no composition registered', async () => {
    await expect(disposeLoadedPlugins()).resolves.toBeUndefined()
  })

  test('disposes one registered owner once across repeated calls', async () => {
    const disposer = vi.fn(async () => {})
    await registerLoadedPluginDisposer(captureLoadedPluginLifecycleToken(), disposer)
    await Promise.all([disposeLoadedPlugins(), disposeLoadedPlugins()])
    await disposeLoadedPlugins()
    expect(disposer).toHaveBeenCalledOnce()
  })

  test('replacement awaits terminal cleanup before installing the next owner', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const token = captureLoadedPluginLifecycleToken()
    await registerLoadedPluginDisposer(token, async () => {
      order.push('old-start')
      await gate
      order.push('old-end')
    })
    const replacement = registerLoadedPluginDisposer(token, async () => { order.push('new') })
    await vi.waitFor(() => expect(order).toEqual(['old-start']))
    release?.()
    await replacement
    expect(order).toEqual(['old-start', 'old-end'])
    await disposeLoadedPlugins()
    expect(order).toEqual(['old-start', 'old-end', 'new'])
  })

  test('failed replacement cleanup terminally disposes the unregistered candidate', async () => {
    const token = captureLoadedPluginLifecycleToken()
    const next = vi.fn(async () => {})
    await registerLoadedPluginDisposer(token, async () => { throw new Error('cleanup failed') })
    await expect(registerLoadedPluginDisposer(token, next)).rejects.toThrow('cleanup failed')
    await disposeLoadedPlugins()
    expect(next).toHaveBeenCalledOnce()
  })

  test('rejects and disposes a registration that finishes after project disposal', async () => {
    const staleToken = captureLoadedPluginLifecycleToken()
    const stale = vi.fn(async () => {})
    await disposeLoadedPlugins()
    await expect(registerLoadedPluginDisposer(staleToken, stale)).resolves.toBe(false)
    expect(stale).toHaveBeenCalledOnce()
  })

  test('a fresh token after disposal can register the next project owner', async () => {
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})
    await registerLoadedPluginDisposer(captureLoadedPluginLifecycleToken(), first)
    await disposeLoadedPlugins()
    await expect(registerLoadedPluginDisposer(
      captureLoadedPluginLifecycleToken(),
      second,
    )).resolves.toBe(true)
    await resetLoadedPluginDisposer()
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  test('disposal during replacement cleanup rejects and disposes the candidate', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const token = captureLoadedPluginLifecycleToken()
    await registerLoadedPluginDisposer(token, async () => { await gate })
    const candidate = vi.fn(async () => {})
    const registration = registerLoadedPluginDisposer(token, candidate)
    await Promise.resolve()
    const disposal = disposeLoadedPlugins()
    release?.()
    await expect(registration).resolves.toBe(false)
    await disposal
    expect(candidate).toHaveBeenCalledOnce()
  })
})
