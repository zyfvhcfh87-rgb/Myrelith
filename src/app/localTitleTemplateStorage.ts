import { mutateTitleTemplateLibrary, readTitleTemplateLibrary, titleTemplateFromLibrary, type TitleTemplateV1, type TitleTemplateLibraryView, type TitleTemplateMutation } from '../domain/titleTemplates'

export interface TitleTemplateRepository {
  load(): Promise<TitleTemplateLibraryView>
  read(id: string): Promise<TitleTemplateV1>
  mutate(mutation: TitleTemplateMutation, isCurrent?: () => boolean): Promise<TitleTemplateLibraryView>
}
const DATABASE = 'myrelith-title-templates'
const STORE = 'library'
const KEY = 'local'

/** Each call owns and closes its connection; completion, not put success, confirms a save. */
function transaction<T>(mode: IDBTransactionMode, action: (raw: unknown) => { result: T; write?: string }): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Local template storage is unavailable in this browser.')); return }
    const open = indexedDB.open(DATABASE, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onerror = () => reject(open.error ?? new Error('Could not open the local template library.'))
    let blocked = false
    open.onblocked = () => { blocked = true; reject(new Error('Another tab is blocking local template storage.')) }
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
      transaction.onabort = transaction.onerror = () => { database.close(); reject(failure ?? transaction.error ?? new Error('Local template transaction failed.')) }
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
export const localTitleTemplateStorage: TitleTemplateRepository = {
  load: () => transaction('readonly', (raw) => ({ result: readTitleTemplateLibrary(raw).view })),
  read: (id) => transaction('readonly', (raw) => ({ result: titleTemplateFromLibrary(raw, id) })),
  mutate: (mutation, isCurrent = () => true) => transaction('readwrite', (raw) => {
    if (!isCurrent()) throw new Error('The project changed before the template could be saved. Reopen Save template.')
    const write = mutateTitleTemplateLibrary(raw, mutation)
    return { write, result: readTitleTemplateLibrary(write).view }
  }),
}
