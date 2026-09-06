import { mutateEffectPresetLibrary, readEffectPresetLibrary, type EffectPresetLibraryView, type PresetLibraryMutation } from '../domain/effectPresets'

export interface EffectPresetRepository {
  load(): Promise<EffectPresetLibraryView>
  mutate(mutation: PresetLibraryMutation, isCurrent?: () => boolean): Promise<EffectPresetLibraryView>
}
const DATABASE = 'myrelith-effect-presets'
const STORE = 'library'
const KEY = 'local'

/** Each call owns and closes its connection; completion, not put success, confirms a save. */
function transaction<T>(mode: IDBTransactionMode, action: (raw: unknown) => { result: T; write?: string }): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Local preset storage is unavailable in this browser.')); return }
    const open = indexedDB.open(DATABASE, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onerror = () => reject(open.error ?? new Error('Could not open the local preset library.'))
    let blocked = false
    open.onblocked = () => { blocked = true; reject(new Error('Another tab is blocking local preset storage.')) }
    open.onsuccess = () => {
      const database = open.result
      if (blocked) { database.close(); return }
      database.onversionchange = () => database.close()
      let transaction: IDBTransaction
      try { transaction = database.transaction(STORE, mode) }
      catch (error) { database.close(); reject(error); return }
      let failure: unknown
      let result: T
      transaction.oncomplete = () => { database.close(); resolve(result) }
      transaction.onabort = transaction.onerror = () => { database.close(); reject(failure ?? transaction.error ?? new Error('Local preset transaction failed.')) }
      const store = transaction.objectStore(STORE)
      const get = store.get(KEY)
      get.onsuccess = () => {
        try {
          const value = action(get.result)
          result = value.result
          if (value.write !== undefined) store.put(value.write, KEY)
        } catch (error) { failure = error; transaction.abort() }
      }
    }
  })
}
export const localEffectPresetStorage: EffectPresetRepository = {
  load: () => transaction('readonly', (raw) => ({ result: readEffectPresetLibrary(raw).view })),
  mutate: (mutation, isCurrent = () => true) => transaction('readwrite', (raw) => {
    if (!isCurrent()) throw new Error('The project changed before the preset could be saved. Reopen Save preset.')
    const write = mutateEffectPresetLibrary(raw, mutation)
    return { write, result: readEffectPresetLibrary(write).view }
  }),
}
