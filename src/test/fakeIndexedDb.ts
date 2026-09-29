/**
 * Minimal in-memory IndexedDB for app storage tests. It models the semantics
 * the storage owners depend on: asynchronous request callbacks, commit only on
 * transaction completion, abort discarding staged writes, clone isolation,
 * closed connections rejecting new transactions, and versionchange
 * notifications from "another tab". Keys are strings only.
 */

type Store = Map<string, unknown>

interface FakeRequest<T = unknown> {
  result: T
  error: DOMException | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded?: (() => void) | null
  onblocked?: (() => void) | null
}

export interface FakeConnection {
  readonly objectStoreNames: { contains(name: string): boolean }
  onversionchange: (() => void) | null
  readonly closed: boolean
  createObjectStore(name: string): void
  transaction(names: string | readonly string[], mode?: IDBTransactionMode): unknown
  close(): void
}

export interface FakeIndexedDb {
  readonly factory: { open(name: string, version?: number): unknown }
  /** Number of `open()` calls per database name. */
  opens(name: string): number
  /** Connections to this database that have not been closed. */
  openConnections(name: string): number
  /** Deliver `versionchange` to every open connection, as another tab's upgrade would. */
  fireVersionChange(name: string): void
  /** Make the next open of this database report `blocked` before succeeding. */
  blockNextOpen(name: string): void
  stores(name: string): ReadonlyMap<string, Store>
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Structured-clone stand-in that stays in the test realm (Node's own
 * structuredClone returns typed arrays from another realm under jsdom).
 * Host objects such as file handles are serializable in real IndexedDB and are
 * kept by reference here.
 */
function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) return new Uint8Array(value) as T
  if (Array.isArray(value)) return value.map(cloneValue) as T
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
  ) as T
}

export function createFakeIndexedDb(): FakeIndexedDb {
  const databases = new Map<string, Map<string, Store>>()
  const versions = new Map<string, number>()
  const connections = new Map<string, Set<FakeConnection>>()
  const openCounts = new Map<string, number>()
  const blockedNames = new Set<string>()

  function connect(name: string, data: Map<string, Store>): FakeConnection {
    let closed = false
    const connection: FakeConnection = {
      objectStoreNames: { contains: (storeName) => data.has(storeName) },
      onversionchange: null,
      get closed() { return closed },
      createObjectStore(storeName) { data.set(storeName, new Map()) },
      close() {
        closed = true
        connections.get(name)?.delete(connection)
      },
      transaction(names, mode = 'readonly') {
        if (closed) throw new DOMException('The connection is closed.', 'InvalidStateError')
        const scope = typeof names === 'string' ? [names] : [...names]
        for (const storeName of scope) {
          if (!data.has(storeName)) throw new DOMException(storeName, 'NotFoundError')
        }
        return createTransaction(data, scope, mode)
      },
    }
    let set = connections.get(name)
    if (!set) connections.set(name, set = new Set())
    set.add(connection)
    return connection
  }

  function createTransaction(data: Map<string, Store>, scope: readonly string[], mode: IDBTransactionMode) {
    const staged = new Map(scope.map((storeName) => [storeName, new Map(data.get(storeName))]))
    const queue: (() => void)[] = []
    let finished = false
    const transaction = {
      error: null as DOMException | null,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      objectStore(storeName: string) {
        const store = staged.get(storeName)
        if (!store) throw new DOMException(storeName, 'NotFoundError')
        const request = <T>(operation: () => T): FakeRequest<T> => {
          if (finished) throw new DOMException('The transaction has finished.', 'TransactionInactiveError')
          const pending: FakeRequest<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null }
          queue.push(() => {
            pending.result = operation()
            pending.onsuccess?.()
          })
          return pending
        }
        const writable = () => {
          if (mode === 'readonly') throw new DOMException('Read-only transaction.', 'ReadOnlyError')
        }
        return {
          get: (key: string) => request(() => cloneValue(store.get(key))),
          getAll: () => request(() => [...store.values()].map((value) => cloneValue(value))),
          getAllKeys: () => request(() => [...store.keys()]),
          put: (value: unknown, key: string) => {
            writable()
            const copy = cloneValue(value)
            return request(() => { store.set(key, copy); return key })
          },
          delete: (key: string) => {
            writable()
            return request(() => { store.delete(key) })
          },
        }
      },
      abort() {
        if (finished) throw new DOMException('The transaction has finished.', 'InvalidStateError')
        finished = true
        queue.length = 0
        void tick().then(() => transaction.onabort?.())
      },
    }
    void (async () => {
      await tick()
      while (!finished && queue.length > 0) {
        queue.shift()!()
        await tick()
      }
      if (finished) return
      finished = true
      for (const [storeName, store] of staged) data.set(storeName, store)
      transaction.oncomplete?.()
    })()
    return transaction
  }

  return {
    factory: {
      open(name, version = 1) {
        openCounts.set(name, (openCounts.get(name) ?? 0) + 1)
        const request: FakeRequest<FakeConnection> = {
          result: undefined as unknown as FakeConnection,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          onblocked: null,
        }
        void (async () => {
          await tick()
          if (blockedNames.delete(name)) {
            request.onblocked?.()
            await tick()
          }
          let data = databases.get(name)
          if (!data) databases.set(name, data = new Map())
          request.result = connect(name, data)
          if ((versions.get(name) ?? 0) < version) {
            versions.set(name, version)
            request.onupgradeneeded?.()
          }
          request.onsuccess?.()
        })()
        return request
      },
    },
    opens: (name) => openCounts.get(name) ?? 0,
    openConnections: (name) => connections.get(name)?.size ?? 0,
    fireVersionChange(name) {
      for (const connection of [...(connections.get(name) ?? [])]) connection.onversionchange?.()
    },
    blockNextOpen(name) { blockedNames.add(name) },
    stores: (name) => databases.get(name) ?? new Map(),
  }
}
