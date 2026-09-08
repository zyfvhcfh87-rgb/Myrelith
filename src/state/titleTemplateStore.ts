import { create } from 'zustand'
import type { TitleTemplateLibraryView } from '../domain/titleTemplates'
export const useTitleTemplateStore = create<TitleTemplateLibraryView & { busy: boolean; error: string | null; loaded: boolean }>(() => ({ templates: [], unavailable: [], readOnlyReason: null, busy: false, error: null, loaded: false }))
