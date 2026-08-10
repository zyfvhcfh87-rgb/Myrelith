/** Bounded opaque string contract for app-owned, non-portable project ids. */

export const MAX_LOCAL_PROJECT_BINDING_ID_CHARACTERS = 512
const LOCAL_PROJECT_BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u

export function isLocalProjectBindingId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_LOCAL_PROJECT_BINDING_ID_CHARACTERS
    && LOCAL_PROJECT_BINDING_ID.test(value)
}
