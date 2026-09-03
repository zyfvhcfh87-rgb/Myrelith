import type { SequenceProject } from './projectSequences'

/**
 * This is an explainable comparison estimate, not a JavaScript heap claim.
 * It intentionally models only retained JSON-shaped document graphs:
 *
 * - object/array headers: 32 bytes;
 * - object properties and array elements: one 8-byte reference slot;
 * - strings: a 24-byte header plus UTF-16 payload;
 * - numbers: 8 bytes when they are roots (nested values already occupy a slot);
 * - booleans/null: no allocation beyond their containing slot.
 *
 * Property-name intern tables, allocator padding, engine metadata, Zustand,
 * Immer, browser media, and GPU resources are deliberately out of scope.
 */
export const DOCUMENT_MEMORY_ESTIMATOR_VERSION =
  'json-retained-graph-v1' as const

const OBJECT_HEADER_BYTES = 32
const ARRAY_HEADER_BYTES = 32
const REFERENCE_SLOT_BYTES = 8
const STRING_HEADER_BYTES = 24
const NUMBER_BYTES = 8

export interface RetainedDocumentGraphEstimate {
  readonly estimatedBytes: number
  readonly objectCount: number
  readonly arrayCount: number
  readonly propertySlotCount: number
  readonly arraySlotCount: number
  readonly stringCount: number
  readonly stringCodeUnitCount: number
  readonly numberRootCount: number
}

export interface DocumentMemoryEstimate {
  readonly estimator: typeof DOCUMENT_MEMORY_ESTIMATOR_VERSION
  readonly assumptions: readonly string[]
  readonly authoredDocument: {
    /** Stable artifact key; format 6 measures the complete SequenceProject. */
    readonly serializedUtf8Bytes: number
    readonly retainedGraph: RetainedDocumentGraphEstimate
  }
  readonly history: {
    readonly pastDepth: number
    readonly futureDepth: number
    readonly snapshotCount: number
    /** Sum of independently serialized past/future snapshots. */
    readonly serializedUtf8Bytes: number
    /** Bytes retained in the shared graph in addition to the current doc. */
    readonly estimatedAdditionalRetainedBytes: number
    /** Difference between independent graphs and the shared retained graph. */
    readonly estimatedStructuralSharingSavingsBytes: number
  }
  readonly totals: {
    readonly serializedUtf8Bytes: number
    readonly estimatedRetainedBytes: number
  }
}

const ESTIMATOR_ASSUMPTIONS = Object.freeze([
  'Counts the JSON-shaped SequenceProject and whole-project undo/redo snapshots only.',
  'Counts shared object and array references once across current/history graphs.',
  'Uses fixed shallow headers and reference slots; it is not a browser heap measurement.',
  'Excludes stores, Immer bookkeeping, imported bytes, decoded media, caches, canvases, and GPU allocations.',
] as const)

/** UTF-8 byte length without TextEncoder, keeping domain/ browser-free. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (
      code >= 0xd800
      && code <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index++
    } else {
      bytes += 3
    }
  }
  return bytes
}

function serializedUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('Document memory estimation requires JSON values')
  }
  return utf8ByteLength(serialized)
}

function retainedGraphEstimate(
  roots: readonly unknown[],
): RetainedDocumentGraphEstimate {
  const seen = new WeakSet<object>()
  const stack = roots.map((value) => ({ value, isRoot: true }))
  let estimatedBytes = 0
  let objectCount = 0
  let arrayCount = 0
  let propertySlotCount = 0
  let arraySlotCount = 0
  let stringCount = 0
  let stringCodeUnitCount = 0
  let numberRootCount = 0

  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry === undefined) break
    const { value, isRoot } = entry
    if (typeof value === 'string') {
      stringCount++
      stringCodeUnitCount += value.length
      estimatedBytes += STRING_HEADER_BYTES + value.length * 2
      continue
    }
    if (typeof value === 'number' && isRoot) {
      numberRootCount++
      estimatedBytes += NUMBER_BYTES
      continue
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) {
      continue
    }
    seen.add(value)

    if (Array.isArray(value)) {
      arrayCount++
      arraySlotCount += value.length
      estimatedBytes += ARRAY_HEADER_BYTES + value.length * REFERENCE_SLOT_BYTES
      for (const child of value) stack.push({ value: child, isRoot: false })
      continue
    }

    objectCount++
    const children = Object.values(value)
    propertySlotCount += children.length
    estimatedBytes += OBJECT_HEADER_BYTES
      + children.length * REFERENCE_SLOT_BYTES
    for (const child of children) stack.push({ value: child, isRoot: false })
  }

  return {
    estimatedBytes,
    objectCount,
    arrayCount,
    propertySlotCount,
    arraySlotCount,
    stringCount,
    stringCodeUnitCount,
    numberRootCount,
  }
}

export function estimateDocumentMemory(
  project: SequenceProject,
  past: readonly SequenceProject[],
  future: readonly SequenceProject[],
): DocumentMemoryEstimate {
  const currentRetained = retainedGraphEstimate([project])
  const historySnapshots = [...past, ...future]
  const allRetained = retainedGraphEstimate([project, ...historySnapshots])
  const independentlyRetained = [project, ...historySnapshots]
    .reduce(
      (sum, snapshot) => sum + retainedGraphEstimate([snapshot]).estimatedBytes,
      0,
    )
  const authoredSerializedBytes = serializedUtf8Bytes(project)
  const historySerializedBytes = historySnapshots.reduce(
    (sum, snapshot) => sum + serializedUtf8Bytes(snapshot),
    0,
  )

  return {
    estimator: DOCUMENT_MEMORY_ESTIMATOR_VERSION,
    assumptions: ESTIMATOR_ASSUMPTIONS,
    authoredDocument: {
      serializedUtf8Bytes: authoredSerializedBytes,
      retainedGraph: currentRetained,
    },
    history: {
      pastDepth: past.length,
      futureDepth: future.length,
      snapshotCount: historySnapshots.length,
      serializedUtf8Bytes: historySerializedBytes,
      estimatedAdditionalRetainedBytes:
        allRetained.estimatedBytes - currentRetained.estimatedBytes,
      estimatedStructuralSharingSavingsBytes:
        independentlyRetained - allRetained.estimatedBytes,
    },
    totals: {
      serializedUtf8Bytes: authoredSerializedBytes + historySerializedBytes,
      estimatedRetainedBytes: allRetained.estimatedBytes,
    },
  }
}
