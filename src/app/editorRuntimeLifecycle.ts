/**
 * Loaded-module lifecycle seam for editor-only runtime owners.
 *
 * Project teardown must reach capture, transport, preview, media-visual and
 * import owners, but the launcher must not statically load their runtimes.
 * Each owner registers its teardown when its module evaluates; the editor
 * chunk evaluates all of them before any project activates. An owner whose
 * module never evaluated holds no resources, so skipping it is exact.
 * Teardown order belongs to the caller (projectController/dependencies.ts),
 * never to registration order.
 */

interface EditorRuntimeTeardowns {
  voiceoverCapture(): Promise<void>
  avCapture(): Promise<void>
  sourcePlayback(): Promise<void>
  transport(): Promise<void>
  multicamMonitor(): void
  sourcePreview(): Promise<void>
  preview(): Promise<void>
  mediaVisuals(): void
  mediaImport(): void
}

export type EditorRuntimeOwner = keyof EditorRuntimeTeardowns

const loadedTeardowns: Partial<EditorRuntimeTeardowns> = {}

/** Called once as the owner module evaluates; an HMR re-evaluation replaces it. */
export function registerLoadedEditorRuntime<K extends EditorRuntimeOwner>(
  owner: K,
  teardown: EditorRuntimeTeardowns[K],
): void {
  loadedTeardowns[owner] = teardown
}

/** The owner's teardown, or undefined while its module has never evaluated. */
export function loadedEditorRuntimeTeardown<K extends EditorRuntimeOwner>(
  owner: K,
): EditorRuntimeTeardowns[K] | undefined {
  return loadedTeardowns[owner]
}
