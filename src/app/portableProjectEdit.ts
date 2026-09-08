/** The app supplies the complete current media envelope before any portable edit commits. */
import { createProjectFileSnapshot, serializeProjectFile } from '../domain/projectFile'
import type { SequenceProject } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'

export function portableProjectEditError(expected: SequenceProject, generation: number, candidate: SequenceProject): string | null {
  const state = useDocumentStore.getState()
  if (state.project !== expected || state.projectGeneration !== generation) return 'The project changed. Reopen the editing controls.'
  if (candidate === expected) return null
  try {
    const media = useMediaStore.getState()
    serializeProjectFile(createProjectFileSnapshot(candidate, media.descriptors.values(), media.collections))
    return null
  } catch (cause) { return cause instanceof Error ? cause.message : 'This edit cannot be saved within the portable project limits.' }
}

export function commitPortableProjectEdit(expected: SequenceProject, generation: number, candidate: SequenceProject): string | null {
  const error = portableProjectEditError(expected, generation, candidate)
  if (error || candidate === expected) return error
  // The store repeats identity and retention admission after synchronous file validation.
  return useDocumentStore.getState().commitProjectEdit(expected, generation, candidate)
}
