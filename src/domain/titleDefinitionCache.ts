import { readTitleDefinition, TITLE_LIMITS, type TitleDefinition, type TitleDefinitionResult } from './titleElements'
import { freeze } from 'immer'

const immutable = new WeakSet<object>()
const definitions = new WeakMap<TitleDefinition, TitleDefinitionResult>()

/** Frozen outer objects alone do not protect their nested element payloads. */
export function isImmutableTitleDefinition(value: TitleDefinition): boolean {
  if (value === null || typeof value !== 'object') return false
  if (immutable.has(value)) return true
  let entries = 0
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > TITLE_LIMITS.jsonDepth) return false
    if (value === null || typeof value !== 'object') return true
    if (!Object.isFrozen(value)) return false
    const keys = Reflect.ownKeys(value)
    entries += keys.length
    if (entries > TITLE_LIMITS.jsonEntries) return false
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && 'value' in descriptor && visit(descriptor.value, depth + 1)
    })
  }
  if (!visit(value, 0)) return false
  immutable.add(value)
  return true
}

/** Mutable parser/test/worker inputs are revalidated on every call. */
export function readTitleDefinitionCached(value: TitleDefinition): TitleDefinitionResult {
  const cached = definitions.get(value)
  if (cached) return cached
  const result = readTitleDefinition(value)
  if (isImmutableTitleDefinition(value)) definitions.set(value, freeze(result, true))
  return result
}
