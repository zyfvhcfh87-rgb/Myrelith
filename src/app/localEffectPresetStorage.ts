import { mutateEffectPresetLibrary, readEffectPresetLibrary, type EffectPresetLibraryView, type PresetLibraryMutation } from '../domain/effectPresets'
import { singleKeyIdbTransaction, type SingleKeyRecordStore } from './indexedDbAccess'

export interface EffectPresetRepository {
  load(): Promise<EffectPresetLibraryView>
  mutate(mutation: PresetLibraryMutation, isCurrent?: () => boolean): Promise<EffectPresetLibraryView>
}
const STORE: SingleKeyRecordStore = {
  database: 'myrelith-effect-presets',
  store: 'library',
  key: 'local',
  unavailableMessage: 'Local preset storage is unavailable in this browser.',
  openFailedMessage: 'Could not open the local preset library.',
  blockedMessage: 'Another tab is blocking local preset storage.',
  transactionFailedMessage: 'Local preset transaction failed.',
}
export const localEffectPresetStorage: EffectPresetRepository = {
  load: () => singleKeyIdbTransaction(STORE, 'readwrite', (raw) => { const parsed = readEffectPresetLibrary(raw); return { result: parsed.view, write: parsed.migration } }),
  mutate: (mutation, isCurrent = () => true) => singleKeyIdbTransaction(STORE, 'readwrite', (raw) => {
    if (!isCurrent()) throw new Error('The project changed before the preset could be saved. Reopen Save preset.')
    const write = mutateEffectPresetLibrary(raw, mutation)
    return { write, result: readEffectPresetLibrary(write).view }
  }),
}
