/** A typed integer field's value, or null while the draft is not a safe integer. */
export function integerDraft(value: string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}
