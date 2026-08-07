/**
 * Lightweight lifecycle seam for the lazily loaded export controller.
 *
 * Project replacement must stop an active export, but importing the heavy
 * controller only to discover that no export ever started defeats first-use
 * loading. The controller registers its disposer when its chunk evaluates.
 */

type ExportDisposer = () => Promise<void>

let loadedExportDisposer: ExportDisposer | null = null

export function registerLoadedExportDisposer(disposer: ExportDisposer): void {
  loadedExportDisposer = disposer
}

export async function disposeLoadedExport(): Promise<void> {
  await loadedExportDisposer?.()
}

/** Test/HMR seam. */
export function resetLoadedExportDisposer(): void {
  loadedExportDisposer = null
}
