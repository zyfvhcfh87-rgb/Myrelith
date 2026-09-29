import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createFakeIndexedDb, type FakeIndexedDb } from '../test/fakeIndexedDb'
import { createCachedDatabase, requestInTransaction } from './indexedDbAccess'
import { createKeyedSerialQueue } from './keyedSerialQueue'

let fake: FakeIndexedDb

beforeEach(() => {
  fake = createFakeIndexedDb()
  vi.stubGlobal('indexedDB', fake.factory)
})
afterEach(() => vi.unstubAllGlobals())

function opener() {
  return createCachedDatabase({
    name: 'fixture',
    version: 1,
    stores: ['items'],
    unavailableMessage: 'unavailable',
    openFailedMessage: 'open failed',
    blockedMessage: 'blocked by another tab',
  })
}

describe('cached IndexedDB connections', () => {
  test('shares one connection and reopens after another tab requests a version change', async () => {
    const open = opener()
    const first = await open()
    expect(await open()).toBe(first)
    expect(fake.opens('fixture')).toBe(1)

    fake.fireVersionChange('fixture')
    const second = await open()
    expect(second).not.toBe(first)
    expect(fake.opens('fixture')).toBe(2)
    await expect(requestInTransaction(second, 'items', 'readonly', (store) => store.getAll(), {
      requestFailed: 'read failed',
      aborted: 'read aborted',
    })).resolves.toEqual([])
  })

  test('a blocked open rejects, closes its late connection, and the next call retries', async () => {
    const open = opener()
    fake.blockNextOpen('fixture')
    await expect(open()).rejects.toThrow('blocked by another tab')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.openConnections('fixture')).toBe(0)
    await open()
    expect(fake.opens('fixture')).toBe(2)
    expect(fake.openConnections('fixture')).toBe(1)
  })

  test('fails explicitly without IndexedDB and recovers once it exists', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const open = opener()
    await expect(open()).rejects.toThrow('unavailable')
    vi.stubGlobal('indexedDB', fake.factory)
    await expect(open()).resolves.toBeDefined()
  })

  test('publishes a request result only after its transaction commits', async () => {
    const database = await opener()()
    await requestInTransaction(database, 'items', 'readwrite', (store) => store.put({ n: 1 }, 'a'), {
      requestFailed: 'write failed',
      aborted: 'write aborted',
    })
    const value = { n: 2 }
    const pending = requestInTransaction(database, 'items', 'readonly', (store) => store.get('a'), {
      requestFailed: 'read failed',
      aborted: 'read aborted',
    })
    value.n = 3
    await expect(pending).resolves.toEqual({ n: 1 })
  })
})

describe('local storage owners reopen after a version change', () => {
  beforeEach(() => vi.resetModules())

  test('recent projects keep working after another tab upgrades the database', async () => {
    const { localProjectStorage } = await import('./localProjectStorage')
    await expect(localProjectStorage.listRecentProjects()).resolves.toEqual([])
    fake.fireVersionChange('webcut-local-projects')
    await expect(localProjectStorage.listRecentProjects()).resolves.toEqual([])
    expect(fake.opens('webcut-local-projects')).toBe(2)
  })

  test('remembered media releases its connection for another tab and reopens on demand', async () => {
    const { localMediaHandleRegistry } = await import('./localMediaHandles')
    await expect(localMediaHandleRegistry.list()).resolves.toEqual([])
    fake.fireVersionChange('webcut-local-media')
    await expect(localMediaHandleRegistry.list()).resolves.toEqual([])
    expect(fake.opens('webcut-local-media')).toBe(2)
  })
})

describe('keyed serial queue', () => {
  test('serializes one key in call order, isolates failures, and runs other keys in parallel', async () => {
    const enqueue = createKeyedSerialQueue()
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = enqueue('a', async () => { events.push('a1 start'); await gate; events.push('a1 end'); throw new Error('a1') })
    const second = enqueue('a', async () => { events.push('a2'); return 2 })
    const other = enqueue('b', async () => { events.push('b1'); return 1 })
    await expect(other).resolves.toBe(1)
    expect(events).toEqual(['a1 start', 'b1'])
    release()
    await expect(first).rejects.toThrow('a1')
    await expect(second).resolves.toBe(2)
    expect(events).toEqual(['a1 start', 'b1', 'a1 end', 'a2'])
  })
})
