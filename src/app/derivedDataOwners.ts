/** App-only cancellation barrier for disposable storage; never visits project storage. */
const owners = new Set<() => Promise<void>>()
let clearing = 0
export function derivedDataIsClearing(): boolean { return clearing > 0 }
export function registerDerivedDataOwner(cancelAndDrain: () => Promise<void>): () => void {
  owners.add(cancelAndDrain)
  return () => { owners.delete(cancelAndDrain) }
}
export async function withDerivedDataOwnersDrained(clear: () => Promise<void>): Promise<void> {
  clearing++
  try {
    await Promise.all([...owners].map((drain) => drain()))
    await clear()
  } finally { clearing-- }
}
