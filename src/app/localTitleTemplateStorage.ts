import { mutateTitleTemplateLibrary, readTitleTemplateLibrary, titleTemplateFromLibrary, type TitleTemplateV1, type TitleTemplateLibraryView, type TitleTemplateMutation } from '../domain/titleTemplates'
import { singleKeyIdbTransaction, type SingleKeyRecordStore } from './indexedDbAccess'

export interface TitleTemplateRepository {
  load(): Promise<TitleTemplateLibraryView>
  read(id: string): Promise<TitleTemplateV1>
  mutate(mutation: TitleTemplateMutation, isCurrent?: () => boolean): Promise<TitleTemplateLibraryView>
}
const STORE: SingleKeyRecordStore = {
  database: 'myrelith-title-templates',
  store: 'library',
  key: 'local',
  unavailableMessage: 'Local template storage is unavailable in this browser.',
  openFailedMessage: 'Could not open the local template library.',
  blockedMessage: 'Another tab is blocking local template storage.',
  transactionFailedMessage: 'Local template transaction failed.',
}
export const localTitleTemplateStorage: TitleTemplateRepository = {
  load: () => singleKeyIdbTransaction(STORE, 'readonly', (raw) => ({ result: readTitleTemplateLibrary(raw).view })),
  read: (id) => singleKeyIdbTransaction(STORE, 'readonly', (raw) => ({ result: titleTemplateFromLibrary(raw, id) })),
  mutate: (mutation, isCurrent = () => true) => singleKeyIdbTransaction(STORE, 'readwrite', (raw) => {
    if (!isCurrent()) throw new Error('The project changed before the template could be saved. Reopen Save template.')
    const write = mutateTitleTemplateLibrary(raw, mutation)
    return { write, result: readTitleTemplateLibrary(write).view }
  }),
}
