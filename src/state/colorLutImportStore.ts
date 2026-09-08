import { create } from 'zustand'
export interface ColorLutImportSummary {
  readonly phase: 'idle' | 'reading' | 'ready' | 'error'
  readonly name: string
  readonly detail: string
}
/** Summary facts only; the app controller owns the pending table and worker. */
export const useColorLutImportStore = create<ColorLutImportSummary>(() => ({ phase: 'idle', name: '', detail: '' }))
