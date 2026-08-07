import type EditorShell from './EditorShell'

export interface EditorShellModule {
  default: typeof EditorShell
}

let pendingEditorModule: Promise<EditorShellModule> | null = null

/** Share one editor import between the launcher preflight and React.lazy. */
export function loadEditorShell(): Promise<EditorShellModule> {
  pendingEditorModule ??= import('./EditorShell').catch((cause: unknown) => {
    pendingEditorModule = null
    throw cause
  })
  return pendingEditorModule
}

/** Test/HMR seam; production navigation keeps the loaded module cached. */
export function resetEditorModuleLoader(): void {
  pendingEditorModule = null
}
