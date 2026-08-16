/** Awaitable lifecycle seam for the lazily created app-owned plugin composition. */

export type LoadedPluginDisposer = () => Promise<void>

declare const loadedPluginLifecycleTokenBrand: unique symbol
export interface LoadedPluginLifecycleToken {
  readonly [loadedPluginLifecycleTokenBrand]: true
}

let loadedDisposer: LoadedPluginDisposer | null = null
let lifecycleQueue: Promise<void> = Promise.resolve()
let lifecycleGeneration = 0
const tokenGenerations = new WeakMap<object, number>()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = lifecycleQueue.then(task, task)
  lifecycleQueue = result.then(() => {}, () => {})
  return result
}

/** Capture before starting async composition creation. Disposal invalidates it. */
export function captureLoadedPluginLifecycleToken(): LoadedPluginLifecycleToken {
  const token = Object.freeze({}) as LoadedPluginLifecycleToken
  tokenGenerations.set(token, lifecycleGeneration)
  return token
}

async function disposeCandidate(disposer: LoadedPluginDisposer): Promise<void> {
  await disposer()
}

/** Replace the loaded composition only after the prior owner closes terminally. */
export function registerLoadedPluginDisposer(
  token: LoadedPluginLifecycleToken,
  disposer: LoadedPluginDisposer,
): Promise<boolean> {
  const expectedGeneration = tokenGenerations.get(token)
  return enqueue(async () => {
    if (expectedGeneration === undefined || expectedGeneration !== lifecycleGeneration) {
      await disposeCandidate(disposer)
      return false
    }
    if (loadedDisposer === disposer) return true
    const previous = loadedDisposer
    loadedDisposer = null
    try {
      await previous?.()
    } catch (error) {
      try {
        await disposeCandidate(disposer)
      } catch (candidateError) {
        throw new AggregateError(
          [error, candidateError],
          'Prior and candidate plugin composition cleanup both failed',
        )
      }
      throw error
    }
    if (expectedGeneration !== lifecycleGeneration) {
      await disposeCandidate(disposer)
      return false
    }
    loadedDisposer = disposer
    return true
  })
}

/** Concurrent/repeated disposal is serialized; each registered owner runs at most once. */
export function disposeLoadedPlugins(): Promise<void> {
  lifecycleGeneration += 1
  return enqueue(async () => {
    const disposer = loadedDisposer
    loadedDisposer = null
    await disposer?.()
  })
}

/** Test/HMR seam that preserves ownership cleanup. */
export function resetLoadedPluginDisposer(): Promise<void> {
  return disposeLoadedPlugins()
}
