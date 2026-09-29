/**
 * Hold one asynchronously acquired runtime lease for an effect's lifetime.
 * A lease that arrives after cleanup is released at once. Acquisition and
 * release failures are logged under `label` instead of escaping as unhandled
 * rejections; the runtime owner keeps its own error state.
 */
export function holdAsyncLease(
  acquire: () => Promise<() => Promise<void>>,
  label: string,
): () => void {
  let released = false
  let release: (() => Promise<void>) | null = null
  const releaseQuietly = (dispose: () => Promise<void>): void => {
    void dispose().catch((cause: unknown) => {
      console.warn(`${label} cleanup failed:`, cause)
    })
  }
  void acquire().then((acquired) => {
    if (released) releaseQuietly(acquired)
    else release = acquired
  }, (cause: unknown) => {
    console.warn(`${label} initialization failed:`, cause)
  })
  return () => {
    released = true
    if (release) releaseQuietly(release)
  }
}
