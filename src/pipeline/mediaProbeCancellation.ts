/**
 * Cancellation test for media inspection failures. The probe and still-image
 * inspection reject an aborted signal with a fresh `AbortError`; this stays
 * Mediabunny-free so launcher callers can classify failures without loading
 * the probe itself.
 */
export function isMediaProbeCancellation(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}
