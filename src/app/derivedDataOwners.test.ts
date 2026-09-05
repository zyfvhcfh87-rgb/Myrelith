import { expect, test, vi } from 'vitest'
import { derivedDataIsClearing, registerDerivedDataOwner, withDerivedDataOwnersDrained } from './derivedDataOwners'

test('blocks new analysis through all owner drains and physical deletion', async () => {
  let releaseOwner!: () => void
  let releaseClear!: () => void
  const owner = new Promise<void>((resolve) => { releaseOwner = resolve })
  const deletion = new Promise<void>((resolve) => { releaseClear = resolve })
  const unregister = registerDerivedDataOwner(() => owner)
  const clear = vi.fn(() => deletion)
  try {
    const pending = withDerivedDataOwnersDrained(clear)
    expect(derivedDataIsClearing()).toBe(true)
    expect(clear).not.toHaveBeenCalled()
    releaseOwner()
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce())
    expect(derivedDataIsClearing()).toBe(true)
    releaseClear()
    await pending
    expect(derivedDataIsClearing()).toBe(false)
  } finally { releaseOwner(); releaseClear(); unregister() }
})

test('does not delete data when an owner cannot drain and restores admission after failure', async () => {
  const unregister = registerDerivedDataOwner(() => Promise.reject(new Error('Owner failed')))
  const clear = vi.fn(async () => {})
  try {
    await expect(withDerivedDataOwnersDrained(clear)).rejects.toThrow('Owner failed')
    expect(clear).not.toHaveBeenCalled()
    expect(derivedDataIsClearing()).toBe(false)
  } finally { unregister() }
})
