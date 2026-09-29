/**
 * Small error helpers shared by every layer (pure TypeScript, so workers and
 * codecs may import them too). Each caller keeps its own messages.
 */

/** The message of an Error, or the string form of any other thrown value. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Longest failure detail a media runtime diagnostic keeps. */
export const MAX_RUNTIME_FAILURE_DETAIL_CHARACTERS = 2_048

/** errorMessage cut to the runtime-diagnostic bound (a plain cut). */
export function runtimeFailureDetail(cause: unknown): string {
  return errorMessage(cause).slice(0, MAX_RUNTIME_FAILURE_DETAIL_CHARACTERS)
}

/** Cap `value` at `maxCharacters` UTF-16 units; a cut ends with an ellipsis. */
export function truncateText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value
  return `${value.slice(0, maxCharacters - 1)}…`
}

/** A fresh cancellation error that callers recognize by its AbortError name. */
export function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/**
 * Throw a fresh abortError(message) once `signal` has aborted. The signal's
 * own reason is deliberately not rethrown.
 */
export function throwIfAborted(
  signal: AbortSignal | undefined,
  message: string,
): void {
  if (signal?.aborted) throw abortError(message)
}

/** True for an Error, DOMException or other error-shaped value named one of `names`. */
export function hasErrorName(cause: unknown, ...names: readonly string[]): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'name' in cause
    && names.includes(cause.name as string)
}
