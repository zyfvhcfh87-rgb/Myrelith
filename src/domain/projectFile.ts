/**
 * Portable, versioned Myrelith project-file facade.
 *
 * Focused validators, migrations, and serialization helpers live under
 * domain/projectFile while callers retain this stable pure-domain import.
 */
export * from './projectFile/projectTypes'
export { validateProjectFile } from './projectFile/documentValidation'
export { migrateProjectFile } from './projectFile/migrations'
export {
  createProjectFileSnapshot,
  parseProjectFile,
  serializeProjectFile,
} from './projectFile/serialization'
