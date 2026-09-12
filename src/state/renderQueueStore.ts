import { create } from 'zustand'
import type { CustomExportPreset, RenderJob } from '../domain/renderJobs'
export interface RenderQueueView {
  jobs: readonly RenderJob[]
  presets: readonly CustomExportPreset[]
  error: string | null
  activeId: string | null
  progress: number
  background: boolean
  downloadId: string | null
}
export const useRenderQueueStore = create<RenderQueueView>(()=>({jobs:[],presets:[],error:null,activeId:null,progress:0,background:false,downloadId:null}))
