export type Issue77ResourceKind =
  | 'iframe'
  | 'worker'
  | 'port'
  | 'watchdog'
  | 'queue'
  | 'memory'
  | 'request'

export interface Issue77LifecycleEvent {
  readonly sequence: number
  readonly action: 'own' | 'release' | 'begin' | 'settle'
  readonly kind: Issue77ResourceKind
  readonly id: string
  readonly reason?: string
}

export interface Issue77ResourceHandle {
  readonly key: string
  release(reason: string): void
}

export interface Issue77RequestHandle {
  readonly id: string
  settle(reason: string): void
}

export interface Issue77LifecycleSnapshot {
  readonly events: readonly Issue77LifecycleEvent[]
  readonly openResources: readonly string[]
  readonly pendingRequests: readonly string[]
}

export interface Issue77LifecycleLedger {
  own(kind: Exclude<Issue77ResourceKind, 'request'>, id: string): Issue77ResourceHandle
  beginRequest(id: string): Issue77RequestHandle
  snapshot(): Issue77LifecycleSnapshot
  terminalViolations(): readonly string[]
}

export function createIssue77LifecycleLedger(): Issue77LifecycleLedger {
  const events: Issue77LifecycleEvent[] = []
  const openResources = new Set<string>()
  const pendingRequests = new Set<string>()
  let sequence = 0

  const record = (
    action: Issue77LifecycleEvent['action'],
    kind: Issue77ResourceKind,
    id: string,
    reason?: string,
  ): void => {
    events.push({ sequence: sequence++, action, kind, id, ...(reason === undefined ? {} : { reason }) })
  }

  return {
    own(kind, id) {
      const key = `${kind}:${id}`
      if (openResources.has(key)) throw new Error(`fixture resource already owned: ${key}`)
      openResources.add(key)
      record('own', kind, id)
      let released = false
      return {
        key,
        release(reason) {
          if (released) throw new Error(`fixture resource released twice: ${key}`)
          released = true
          openResources.delete(key)
          record('release', kind, id, reason)
        },
      }
    },
    beginRequest(id) {
      if (pendingRequests.has(id)) throw new Error(`fixture request already pending: ${id}`)
      pendingRequests.add(id)
      record('begin', 'request', id)
      let settled = false
      return {
        id,
        settle(reason) {
          if (settled) throw new Error(`fixture request settled twice: ${id}`)
          settled = true
          pendingRequests.delete(id)
          record('settle', 'request', id, reason)
        },
      }
    },
    snapshot() {
      return {
        events: events.map((event) => ({ ...event })),
        openResources: [...openResources].sort(),
        pendingRequests: [...pendingRequests].sort(),
      }
    },
    terminalViolations() {
      return [
        ...[...openResources].sort().map((key) => `open resource: ${key}`),
        ...[...pendingRequests].sort().map((id) => `pending request: ${id}`),
      ]
    },
  }
}

export interface Issue77MessageEnvelope {
  readonly protocolVersion: 1
  readonly generation: number
  readonly requestId: number
  readonly payload: Uint8Array
}

export type Issue77MessageClassification =
  | 'accepted'
  | 'duplicate'
  | 'stale-generation'
  | 'stale-request'

export function issue77MessageEnvelope(
  generation: number,
  requestId: number,
  payload: Uint8Array = new Uint8Array(),
): Issue77MessageEnvelope {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError('fixture generation must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(requestId) || requestId < 0) {
    throw new RangeError('fixture request id must be a non-negative safe integer')
  }
  return {
    protocolVersion: 1,
    generation,
    requestId,
    payload: payload.slice(),
  }
}

export function classifyIssue77Message(
  envelope: Issue77MessageEnvelope,
  currentGeneration: number,
  currentRequestId: number,
  acceptedKeys: Set<string>,
): Issue77MessageClassification {
  if (envelope.generation !== currentGeneration) return 'stale-generation'
  if (envelope.requestId !== currentRequestId) return 'stale-request'
  const key = `${envelope.generation}:${envelope.requestId}`
  if (acceptedKeys.has(key)) return 'duplicate'
  acceptedKeys.add(key)
  return 'accepted'
}

export function issue77MessageCases(
  currentGeneration = 7,
  currentRequestId = 11,
): Readonly<Record<'current' | 'duplicate' | 'staleGeneration' | 'staleRequest', Issue77MessageEnvelope>> {
  return Object.freeze({
    current: issue77MessageEnvelope(currentGeneration, currentRequestId, Uint8Array.of(1)),
    duplicate: issue77MessageEnvelope(currentGeneration, currentRequestId, Uint8Array.of(2)),
    staleGeneration: issue77MessageEnvelope(currentGeneration - 1, currentRequestId),
    staleRequest: issue77MessageEnvelope(currentGeneration, currentRequestId - 1),
  })
}
