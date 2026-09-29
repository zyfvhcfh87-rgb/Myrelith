/**
 * Shared IndexedDB plumbing for the origin-local stores. Record validation
 * stays with each owner; these helpers only own connection and transaction
 * lifetimes, so a result is published only after its transaction commits.
 */

type ErrorFactory = (message: string) => Error

const plainError: ErrorFactory = (message) => new Error(message)

export interface CachedDatabaseOptions {
  readonly name: string
  readonly version: number
  /** Object stores created during an upgrade when they are missing. */
  readonly stores: readonly string[]
  readonly unavailableMessage: string
  readonly openFailedMessage: string
  readonly blockedMessage: string
  readonly createError?: ErrorFactory
}

/**
 * One lazily opened connection shared by every call. A failed open, or a
 * versionchange from another tab (which closes the connection), clears the
 * cache so the next call reopens instead of reusing a closed connection.
 */
export function createCachedDatabase(
  options: CachedDatabaseOptions,
): () => Promise<IDBDatabase> {
  const createError = options.createError ?? plainError
  let cached: Promise<IDBDatabase> | null = null
  return () => {
    if (cached) return cached
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(createError(options.unavailableMessage))
        return
      }
      let blocked = false
      const request = indexedDB.open(options.name, options.version)
      request.onupgradeneeded = () => {
        for (const storeName of options.stores) {
          if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName)
          }
        }
      }
      request.onsuccess = () => {
        const database = request.result
        // The caller already saw the blocked rejection; never keep this late
        // connection open behind another tab's upgrade.
        if (blocked) {
          database.close()
          return
        }
        database.onversionchange = () => {
          database.close()
          if (cached === opening) cached = null
        }
        resolve(database)
      }
      request.onerror = () => reject(
        request.error ?? createError(options.openFailedMessage),
      )
      request.onblocked = () => {
        blocked = true
        reject(createError(options.blockedMessage))
      }
    })
    cached = opening
    void opening.catch(() => {
      if (cached === opening) cached = null
    })
    return opening
  }
}

export interface TransactionRequestMessages {
  readonly requestFailed: string
  readonly aborted: string
  readonly createError?: ErrorFactory
}

/** Run one request in its own transaction; resolve once that transaction commits. */
export function requestInTransaction<T>(
  database: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  requestFor: (store: IDBObjectStore) => IDBRequest<T>,
  messages: TransactionRequestMessages,
): Promise<T> {
  const createError = messages.createError ?? plainError
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = requestFor(transaction.objectStore(storeName))
    let result: T
    request.onsuccess = () => {
      result = request.result
    }
    request.onerror = () => reject(
      request.error ?? createError(messages.requestFailed),
    )
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () => reject(
      transaction.error ?? createError(messages.aborted),
    )
  })
}

export interface SingleKeyRecordStore {
  readonly database: string
  readonly store: string
  readonly key: string
  readonly unavailableMessage: string
  readonly openFailedMessage: string
  readonly blockedMessage: string
  readonly transactionFailedMessage: string
}

/**
 * Read one key, let `action` validate it, and optionally replace it in the same
 * transaction. Each call owns and closes its connection; completion, not put
 * success, confirms a save. A throwing action aborts before anything commits.
 */
export function singleKeyIdbTransaction<T>(
  target: SingleKeyRecordStore,
  mode: IDBTransactionMode,
  action: (raw: unknown) => { readonly result: T; readonly write?: unknown },
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error(target.unavailableMessage))
      return
    }
    const open = indexedDB.open(target.database, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(target.store)
    open.onerror = () => reject(open.error ?? new Error(target.openFailedMessage))
    let blocked = false
    open.onblocked = () => {
      blocked = true
      reject(new Error(target.blockedMessage))
    }
    open.onsuccess = () => {
      const database = open.result
      if (blocked) {
        database.close()
        return
      }
      database.onversionchange = () => database.close()
      let transaction: IDBTransaction
      try {
        transaction = database.transaction(target.store, mode)
      } catch (error) {
        database.close()
        reject(error)
        return
      }
      let failure: unknown
      let result: T
      transaction.oncomplete = () => {
        database.close()
        resolve(result)
      }
      transaction.onabort = transaction.onerror = () => {
        database.close()
        reject(failure ?? transaction.error ?? new Error(target.transactionFailedMessage))
      }
      const store = transaction.objectStore(target.store)
      const get = store.get(target.key)
      get.onsuccess = () => {
        try {
          const value = action(get.result)
          result = value.result
          if (value.write !== undefined) store.put(value.write, target.key)
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
    }
  })
}
