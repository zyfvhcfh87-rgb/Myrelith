export const PLUGIN_ACTIVATION_SENTINEL_KEY = 'myrelith.plugin-activation:v1'
export const PLUGIN_ACTIVATION_LOCK_NAME = 'myrelith.plugin-activation:v1'

const PLUGIN_ACTIVATION_RECORD_VERSION = 2
const MAX_ACTIVATION_OWNER_COUNT = 32
const MAX_ID_CHARACTERS = 128
const PLUGIN_ACTIVATION_OWNER_LOCK_PREFIX = `${PLUGIN_ACTIVATION_LOCK_NAME}:owner:`

const liveActivationOwnerCounts = new Map<string, number>()

export interface PluginSafetyStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface PluginActivationCoordinationLock {
  runExclusive<T>(work: () => Promise<T> | T): Promise<T>
}

export type PluginStartupSafety =
  | { readonly status: 'clean'; readonly offerSafeMode: false }
  | { readonly status: 'invalid-sentinel'; readonly offerSafeMode: true }
  | { readonly status: 'storage-unavailable'; readonly offerSafeMode: true }
  | {
      readonly status: 'stale-activation'
      readonly offerSafeMode: true
      readonly batchId: string
    }

export interface RunPluginActivationBatchOptions<T> {
  readonly storage: PluginSafetyStorage
  readonly batchId: string
  readonly ownerId?: string
  readonly coordinationLock?: PluginActivationCoordinationLock
  activate(): Promise<T>
}

export interface PluginSessionSafety {
  enterSafeMode(): void
  continueWithReviewedNormalStartup(): boolean
  startupMode(): PluginSessionStartupMode
  isSafeMode(): boolean
  thirdPartyInitializationAllowed(): boolean
}

export type PluginSessionStartupMode = 'normal' | 'review-required' | 'safe-mode'

interface ActivationOwner {
  readonly ownerId: string
  readonly batchId: string
}

interface ActivationRecordV2 {
  readonly version: 2
  readonly owners: readonly ActivationOwner[]
}

type ParsedActivationRecord =
  | { readonly kind: 'v1'; readonly batchId: string }
  | { readonly kind: 'v2'; readonly owners: readonly ActivationOwner[] }
  | { readonly kind: 'invalid' }

export function createPluginSessionSafety(
  startupSafety: PluginStartupSafety,
): PluginSessionSafety {
  let mode: PluginSessionStartupMode = startupSafety.status === 'clean'
    ? 'normal'
    : startupSafety.status === 'stale-activation'
      ? 'review-required'
      : 'safe-mode'
  return Object.freeze({
    enterSafeMode: () => { mode = 'safe-mode' },
    continueWithReviewedNormalStartup: () => {
      if (mode !== 'review-required') return false
      mode = 'normal'
      return true
    },
    startupMode: () => mode,
    isSafeMode: () => mode === 'safe-mode',
    thirdPartyInitializationAllowed: () => mode === 'normal',
  })
}

type StaleActivationLeftovers =
  | { readonly kind: 'v1' }
  | { readonly kind: 'v2'; readonly ownerIds: readonly string[] }
  | { readonly kind: 'none' }

/**
 * Capture leftover owners at launch. A later reviewed continue drops only
 * those entries that are no longer inside activate(), so a live peer,
 * including one already counted when this snapshot was taken, stays
 * recorded until it finishes.
 */
export function createStaleActivationAcknowledgement(
  storage: PluginSafetyStorage,
  coordinationLock?: PluginActivationCoordinationLock,
): () => Promise<void> {
  const leftovers = snapshotStaleActivationLeftovers(storage)
  return () => acknowledgeStaleActivationLeftovers(storage, leftovers, coordinationLock)
}

export function readPluginStartupSafety(storage: PluginSafetyStorage): PluginStartupSafety {
  let raw: string | null
  try {
    raw = storage.getItem(PLUGIN_ACTIVATION_SENTINEL_KEY)
  } catch {
    return Object.freeze({ status: 'storage-unavailable', offerSafeMode: true })
  }
  if (raw === null) return Object.freeze({ status: 'clean', offerSafeMode: false })
  const parsed = parseActivationRecord(raw)
  if (parsed.kind === 'v1') {
    return Object.freeze({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: parsed.batchId,
    })
  }
  if (parsed.kind === 'v2') {
    return Object.freeze({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: sortedOwners(parsed.owners)[0]!.batchId,
    })
  }
  return Object.freeze({ status: 'invalid-sentinel', offerSafeMode: true })
}

/** Persist crash intent before third-party registration and clear only this owner after success. */
export async function runPluginActivationBatch<T>(
  options: RunPluginActivationBatchOptions<T>,
): Promise<T> {
  const batchId = validatedId(options.batchId, 'Plugin activation batch id')
  const ownerId = validatedId(
    options.ownerId ?? createPluginActivationOwnerId(),
    'Plugin activation owner id',
  )
  const owner: ActivationOwner = Object.freeze({ ownerId, batchId })
  return withActivationOwnerPresence(ownerId, async () => {
    await mutateActivationRecord(options.storage, options.coordinationLock, (current) => {
      if (current?.kind === 'invalid') {
        throw new TypeError('Plugin activation sentinel is invalid')
      }
      const existing = current?.kind === 'v2' ? current.owners : []
      const nextOwners = [...existing.filter((entry) => entry.ownerId !== ownerId), owner]
      if (nextOwners.length > MAX_ACTIVATION_OWNER_COUNT) {
        throw new TypeError('Plugin activation owner limit exceeded')
      }
      return { write: true, next: Object.freeze({ version: 2, owners: nextOwners }) }
    })
    const result = await options.activate()
    await mutateActivationRecord(options.storage, options.coordinationLock, (current) => {
      if (current === null || current.kind !== 'v2') return { write: false, next: null }
      const remaining = current.owners.filter((entry) => entry.ownerId !== ownerId)
      if (remaining.length === current.owners.length) return { write: false, next: null }
      if (remaining.length === 0) return { write: true, next: null }
      return { write: true, next: Object.freeze({ version: 2, owners: remaining }) }
    })
    return result
  })
}

export function createPluginActivationOwnerId(): string {
  const crypto = globalThis.crypto
  if (crypto?.randomUUID) return crypto.randomUUID()
  if (crypto?.getRandomValues) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  }
  throw new TypeError('Plugin activation owner id could not be created')
}

function snapshotStaleActivationLeftovers(
  storage: PluginSafetyStorage,
): StaleActivationLeftovers {
  try {
    const raw = storage.getItem(PLUGIN_ACTIVATION_SENTINEL_KEY)
    if (raw === null) return Object.freeze({ kind: 'none' })
    const parsed = parseActivationRecord(raw)
    if (parsed.kind === 'v1') return Object.freeze({ kind: 'v1' })
    if (parsed.kind === 'v2') {
      return Object.freeze({
        kind: 'v2',
        ownerIds: Object.freeze(parsed.owners.map((owner) => owner.ownerId)),
      })
    }
    return Object.freeze({ kind: 'none' })
  } catch {
    return Object.freeze({ kind: 'none' })
  }
}

async function acknowledgeStaleActivationLeftovers(
  storage: PluginSafetyStorage,
  leftovers: StaleActivationLeftovers,
  lock: PluginActivationCoordinationLock | undefined,
): Promise<void> {
  if (leftovers.kind === 'none') return
  try {
    const remoteLive = leftovers.kind === 'v2'
      ? await snapshotRemoteLiveActivationOwnerIds()
      : null
    await mutateActivationRecord(storage, lock, (current) => {
      if (current === null) return { write: false, next: null }
      if (leftovers.kind === 'v1') {
        if (current.kind === 'v1') return { write: true, next: null }
        return { write: false, next: null }
      }
      if (current.kind !== 'v2') return { write: false, next: null }
      const live = new Set(liveActivationOwnerCounts.keys())
      for (const ownerId of remoteLive ?? []) live.add(ownerId)
      const drop = new Set(leftovers.ownerIds.filter((ownerId) => !live.has(ownerId)))
      const remaining = current.owners.filter((owner) => !drop.has(owner.ownerId))
      if (remaining.length === current.owners.length) return { write: false, next: null }
      if (remaining.length === 0) return { write: true, next: null }
      return { write: true, next: Object.freeze({ version: 2, owners: remaining }) }
    })
  } catch {
    // In-memory review already continued; durable leftovers stay until storage recovers.
  }
}

function validatedId(value: string, label: string): string {
  if (value.length === 0 || value.length > MAX_ID_CHARACTERS) {
    throw new TypeError(`${label} must contain 1-${String(MAX_ID_CHARACTERS)} characters`)
  }
  return value
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARACTERS
}

function parseActivationRecord(raw: string): ParsedActivationRecord {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { kind: 'invalid' }
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (
      keys.length === 2
      && record.version === 1
      && isBoundedId(record.batchId)
    ) {
      return { kind: 'v1', batchId: record.batchId }
    }
    if (record.version !== PLUGIN_ACTIVATION_RECORD_VERSION || keys.length !== 2) {
      return { kind: 'invalid' }
    }
    if (!Array.isArray(record.owners)
      || record.owners.length === 0
      || record.owners.length > MAX_ACTIVATION_OWNER_COUNT) {
      return { kind: 'invalid' }
    }
    const owners: ActivationOwner[] = []
    const seen = new Set<string>()
    for (const entry of record.owners) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { kind: 'invalid' }
      }
      const owner = entry as Record<string, unknown>
      if (
        Object.keys(owner).length !== 2
        || !isBoundedId(owner.ownerId)
        || !isBoundedId(owner.batchId)
        || seen.has(owner.ownerId)
      ) {
        return { kind: 'invalid' }
      }
      seen.add(owner.ownerId)
      owners.push(Object.freeze({ ownerId: owner.ownerId, batchId: owner.batchId }))
    }
    return { kind: 'v2', owners: Object.freeze(owners) }
  } catch {
    return { kind: 'invalid' }
  }
}

function sortedOwners(owners: readonly ActivationOwner[]): readonly ActivationOwner[] {
  return [...owners].sort((left, right) => {
    if (left.ownerId < right.ownerId) return -1
    if (left.ownerId > right.ownerId) return 1
    if (left.batchId < right.batchId) return -1
    if (left.batchId > right.batchId) return 1
    return 0
  })
}

function serializeActivationRecord(record: ActivationRecordV2): string {
  return JSON.stringify({
    version: PLUGIN_ACTIVATION_RECORD_VERSION,
    owners: sortedOwners(record.owners).map((owner) => ({
      ownerId: owner.ownerId,
      batchId: owner.batchId,
    })),
  })
}

function browserActivationLock(): PluginActivationCoordinationLock | undefined {
  const locks = globalThis.navigator?.locks
  if (!locks || typeof locks.request !== 'function') return undefined
  return Object.freeze({
    runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
      return locks.request(
        PLUGIN_ACTIVATION_LOCK_NAME,
        { mode: 'exclusive' },
        async () => await work(),
      )
    },
  })
}

async function withActivationOwnerPresence<T>(
  ownerId: string,
  work: () => Promise<T>,
): Promise<T> {
  liveActivationOwnerCounts.set(ownerId, (liveActivationOwnerCounts.get(ownerId) ?? 0) + 1)
  try {
    const locks = globalThis.navigator?.locks
    if (!locks || typeof locks.request !== 'function') return await work()
    return await locks.request(
      PLUGIN_ACTIVATION_OWNER_LOCK_PREFIX + ownerId,
      { mode: 'shared' },
      async () => await work(),
    )
  } finally {
    const remaining = (liveActivationOwnerCounts.get(ownerId) ?? 1) - 1
    if (remaining <= 0) liveActivationOwnerCounts.delete(ownerId)
    else liveActivationOwnerCounts.set(ownerId, remaining)
  }
}

async function snapshotRemoteLiveActivationOwnerIds(): Promise<ReadonlySet<string>> {
  const locks = globalThis.navigator?.locks
  if (!locks || typeof locks.query !== 'function') return new Set()
  try {
    const snapshot = await locks.query()
    const live = new Set<string>()
    for (const info of [...snapshot.held ?? [], ...snapshot.pending ?? []]) {
      const name = info.name
      if (typeof name !== 'string' || !name.startsWith(PLUGIN_ACTIVATION_OWNER_LOCK_PREFIX)) {
        continue
      }
      const ownerId = name.slice(PLUGIN_ACTIVATION_OWNER_LOCK_PREFIX.length)
      if (isBoundedId(ownerId)) live.add(ownerId)
    }
    return live
  } catch {
    return new Set()
  }
}

async function withActivationCoordination<T>(
  lock: PluginActivationCoordinationLock | undefined,
  work: () => T,
): Promise<T> {
  const exclusive = lock ?? browserActivationLock()
  if (!exclusive) return work()
  return exclusive.runExclusive(work)
}

async function mutateActivationRecord(
  storage: PluginSafetyStorage,
  lock: PluginActivationCoordinationLock | undefined,
  mutate: (
    current: ParsedActivationRecord | null,
  ) => { readonly write: boolean; readonly next: ActivationRecordV2 | null },
): Promise<void> {
  await withActivationCoordination(lock, () => {
    const raw = storage.getItem(PLUGIN_ACTIVATION_SENTINEL_KEY)
    const current = raw === null ? null : parseActivationRecord(raw)
    const result = mutate(current)
    if (!result.write) return
    if (result.next === null) storage.removeItem(PLUGIN_ACTIVATION_SENTINEL_KEY)
    else storage.setItem(PLUGIN_ACTIVATION_SENTINEL_KEY, serializeActivationRecord(result.next))
  })
}
