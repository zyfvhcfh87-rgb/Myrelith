/**
 * Per-key promise tails. Operations sharing a key run one at a time in call
 * order; unrelated keys proceed in parallel. A rejected operation still
 * releases its successor, and an idle key's tail is dropped so the map stays
 * bounded by the keys currently in flight.
 */
export type KeyedSerialQueue = <T>(key: string, operation: () => Promise<T>) => Promise<T>

export function createKeyedSerialQueue(): KeyedSerialQueue {
  const tails = new Map<string, Promise<void>>()
  return <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }
}
