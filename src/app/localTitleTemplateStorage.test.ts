import { afterEach, describe, expect, test, vi } from 'vitest'
import { localTitleTemplateStorage } from './localTitleTemplateStorage'
import { builtInTitleTemplates } from '../domain/titleTemplates'
/** Manual event ordering proves completion/abort semantics without opening a browser or native IDB. */
function database(raw: unknown = undefined) {
  const open: { result?: unknown; onblocked?: () => void; onsuccess?: () => void } = {}
  const get: { result: unknown; onsuccess?: () => void } = { result: raw }
  const put = vi.fn(), close = vi.fn()
  const transaction = { oncomplete: () => {}, onabort: () => {}, onerror: () => {}, error: null,
    objectStore: () => ({ get: () => get, put }), abort: vi.fn(() => transaction.onabort()) }
  const connection = { close, transaction: vi.fn(() => transaction), onversionchange: () => {} }
  vi.stubGlobal('indexedDB', { open: vi.fn(() => open) })
  return { open, get, put, close, transaction, connection,
    opened: () => { open.result = connection; open.onsuccess!() },
    read: () => get.onsuccess!(), complete: () => transaction.oncomplete() }
}
afterEach(() => vi.unstubAllGlobals())
describe('local title transaction lifecycle', () => {
  test('a put is not success; only transaction completion resolves, closes, and publishes summaries', async () => {
    const db = database(), template = builtInTitleTemplates()[0]
    const pending = localTitleTemplateStorage.mutate({ kind: 'save', template })
    let settled = false; void pending.then(() => { settled = true })
    db.opened(); db.read()
    expect(db.connection.transaction).toHaveBeenCalledOnce(); expect(db.put).toHaveBeenCalledOnce()
    await Promise.resolve(); expect(settled).toBe(false); expect(db.close).not.toHaveBeenCalled()
    db.complete()
    const view = await pending
    expect(db.close).toHaveBeenCalledOnce()
    expect(view.templates[0]).toMatchObject({ name: template.name, elements: 1 })
    expect(view.templates[0]).not.toHaveProperty('title')
  })
  test('a failed write never reports success and closes its connection', async () => {
    const db = database(), pending = localTitleTemplateStorage.mutate({ kind: 'save', template: builtInTitleTemplates()[0] })
    const rejected = expect(pending).rejects.toThrow(/transaction failed/)
    db.opened(); db.read(); db.transaction.onabort()
    await rejected; expect(db.close).toHaveBeenCalledOnce()
  })
  test('stale session aborts before put, including preserved unknown siblings', async () => {
    const db = database(JSON.stringify({ version: 1, templates: [{ version: 9, id: 'future' }] }))
    const pending = localTitleTemplateStorage.mutate({ kind: 'save', template: builtInTitleTemplates()[0] }, () => false)
    const rejected = expect(pending).rejects.toThrow(/project changed/)
    db.opened(); db.read(); await rejected
    expect(db.put).not.toHaveBeenCalled(); expect(db.transaction.abort).toHaveBeenCalledOnce(); expect(db.close).toHaveBeenCalledOnce()
  })
  test('unknown siblings survive mutation; corrupt/future libraries are read-only and cause no put', async () => {
    const unknown = { version: 9, name: 'Future', data: 'inert' }, db = database(JSON.stringify({ version: 1, templates: [unknown] }))
    const pending = localTitleTemplateStorage.mutate({ kind: 'save', template: builtInTitleTemplates()[0] })
    db.opened(); db.read(); expect(JSON.parse(db.put.mock.calls[0][0]).templates[0]).toEqual(unknown); db.complete(); await pending
    const future = database(JSON.stringify({ version: 5, templates: [] }))
    const failed = localTitleTemplateStorage.mutate({ kind: 'save', template: builtInTitleTemplates()[0] })
    const rejected = expect(failed).rejects.toThrow(/read-only/)
    future.opened(); future.read(); await rejected; expect(future.put).not.toHaveBeenCalled(); expect(future.close).toHaveBeenCalledOnce()
  })
  test('load and template read use readonly transactions; blocked late opens close', async () => {
    const template = builtInTitleTemplates()[0], db = database(JSON.stringify({ version: 1, templates: [template] }))
    const pending = localTitleTemplateStorage.read(template.id); db.opened(); db.read(); db.complete()
    expect(await pending).toEqual(template); expect(db.connection.transaction).toHaveBeenCalledWith('library', 'readonly')
    const late = database(), blocked = localTitleTemplateStorage.load(), rejected = expect(blocked).rejects.toThrow(/blocking/)
    late.open.onblocked!(); await rejected; late.opened()
    expect(late.close).toHaveBeenCalledOnce(); expect(late.connection.transaction).not.toHaveBeenCalled()
  })
})
