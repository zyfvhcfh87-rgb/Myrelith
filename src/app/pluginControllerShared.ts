/**
 * app/pluginControllerShared.ts — small mechanics shared by the plugin
 * controllers. Each caller keeps its own messages, limits and ordering.
 */

import type { PluginParameter } from '../domain/pluginManifest'

/** Longest detail string a plugin controller projects into public state. */
const MAX_PUBLIC_DETAIL_CHARACTERS = 512

export function boundedDetail(value: string): string {
  return value.length <= MAX_PUBLIC_DETAIL_CHARACTERS
    ? value
    : `${value.slice(0, MAX_PUBLIC_DETAIL_CHARACTERS - 1)}…`
}

/** Rethrow one cleanup failure unchanged, or all of them together. */
export function throwCleanupFailures(
  failures: readonly unknown[],
  message: string,
): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

/**
 * Hand a freshly preflighted session to its caller only while it is still
 * current; otherwise close it before rethrowing the staleness failure.
 */
export async function returnOrCloseSession<
  T extends { close(reason: string): Promise<void> },
>(
  session: T,
  assertCurrent: () => void,
  closeReason: string,
  aggregateMessage: string,
): Promise<T> {
  try {
    assertCurrent()
    return session
  } catch (cause) {
    try {
      await session.close(closeReason)
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], aggregateMessage)
    }
    throw cause
  }
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export function freezePluginParameter(parameter: PluginParameter): PluginParameter {
  if (parameter.kind === 'enum') {
    return Object.freeze({
      ...parameter,
      options: Object.freeze(parameter.options.map((option) => Object.freeze({ ...option }))),
    })
  }
  return Object.freeze({ ...parameter })
}

/** One signal that aborts when any source does; dispose() detaches it. */
export function linkedAbortSignal(
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  const onAbort = (): void => controller.abort()
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of active) signal.removeEventListener('abort', onAbort)
    },
  }
}
