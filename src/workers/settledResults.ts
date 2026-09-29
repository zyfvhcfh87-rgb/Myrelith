/**
 * Cleanup settles every owner before reporting: one failed close must not
 * skip the others. These helpers turn the settled results into one error.
 */

/** Rejection reasons in input order. */
export function rejectionReasons(
  results: readonly PromiseSettledResult<unknown>[],
): unknown[] {
  const reasons: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') reasons.push(result.reason)
  }
  return reasons
}

/** Throw one AggregateError carrying every rejection, if any occurred. */
export function throwIfRejected(
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
): void {
  const reasons = rejectionReasons(results)
  if (reasons.length > 0) throw new AggregateError(reasons, message)
}
