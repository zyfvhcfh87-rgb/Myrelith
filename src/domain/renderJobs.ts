import { parseExportSettings, parseChapterPolicy, DEFAULT_CHAPTER_POLICY, type ChapterPolicy, type ExportSettingsUnion } from './deliveryProduct'
import type { ExportRange } from './exportRange'

export const MAX_RENDER_RECORDS = 100
export const MAX_RENDER_LIBRARY_BYTES = 1024 * 1024
export const MAX_RENDER_SNAPSHOT_BYTES = 64 * 1024 * 1024
export type RenderJobStatus = 'queued' | 'needs-project' | 'needs-media' | 'needs-destination' | 'needs-review' | 'preparing' | 'rendering' | 'cancelling' | 'interrupted' | 'cancelled' | 'failed' | 'completed'
export type RenderDelivery = 'none' | 'unverified' | 'aborted' | 'uncertain' | 'file' | 'download' | 'download-lost' | 'download-requested' | 'discarded'
export interface RenderJob {
  readonly id: string
  readonly name: string
  readonly sequenceId: string
  readonly binding: string
  readonly revision: string
  readonly range: ExportRange
  readonly profile: Readonly<ExportSettingsUnion>
  readonly chapters: Readonly<ChapterPolicy>
  readonly status: RenderJobStatus
  readonly delivery: RenderDelivery
  readonly attempts: number
  readonly message: string
}
export interface CustomExportPreset { readonly id: string; readonly name: string; readonly profile: Readonly<ExportSettingsUnion> }
export interface RenderLibrary<T> { readonly version: 1; readonly revision: number; readonly records: readonly T[] }
const statuses: readonly string[] = ['queued','needs-project','needs-media','needs-destination','needs-review','preparing','rendering','cancelling','interrupted','cancelled','failed','completed']
const deliveries: readonly string[] = ['none','unverified','aborted','uncertain','file','download','download-lost','download-requested','discarded']
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid local render record.')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new TypeError('Unrecognized local render fields.')
}
function string(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new TypeError('Invalid local render text.')
  return value
}
export function parseCustomExportPreset(value: unknown): CustomExportPreset {
  const v = record(value); keys(v, ['id','name','profile'])
  return Object.freeze({ id: string(v.id,128), name: string(v.name,128), profile: parseExportSettings(v.profile) })
}
export function parseRenderJob(value: unknown): RenderJob {
  const v = record(value)
  const hasChapters = Object.hasOwn(v, 'chapters')
  keys(v, hasChapters
    ? ['id','name','sequenceId','binding','revision','range','profile','chapters','status','delivery','attempts','message']
    : ['id','name','sequenceId','binding','revision','range','profile','status','delivery','attempts','message'])
  const range = record(v.range); keys(range,['startFrame','endFrame'])
  if (!Number.isSafeInteger(range.startFrame) || !Number.isSafeInteger(range.endFrame) || (range.startFrame as number) < 0 || (range.endFrame as number) <= (range.startFrame as number)
    || !Number.isSafeInteger(v.attempts) || (v.attempts as number) < 0 || (v.attempts as number) > 1_000_000
    || !statuses.includes(v.status as string) || !deliveries.includes(v.delivery as string)
    || typeof v.revision !== 'string' || !/^[a-f0-9]{64}$/.test(v.revision)) throw new TypeError('Invalid render job facts.')
  return Object.freeze({ id:string(v.id,128), name:string(v.name,128), sequenceId:string(v.sequenceId,256), binding:string(v.binding,512), revision:v.revision,
    range:Object.freeze({startFrame:range.startFrame as number,endFrame:range.endFrame as number}), profile:parseExportSettings(v.profile),
    chapters: hasChapters ? parseChapterPolicy(v.chapters) : DEFAULT_CHAPTER_POLICY,
    status:v.status as RenderJobStatus, delivery:v.delivery as RenderDelivery, attempts:v.attempts as number,message:string(v.message,512,true) })
}
export function parseRenderLibrary<T>(raw: unknown, parse: (value: unknown) => T): RenderLibrary<T> {
  if (raw === undefined) return {version:1,revision:0,records:[]}
  if (typeof raw !== 'string' || raw.length * 2 > MAX_RENDER_LIBRARY_BYTES) throw new Error('Local render library is too large or unreadable; preserved without changes.')
  const v = record(JSON.parse(raw)); keys(v,['version','revision','records'])
  if (v.version !== 1 || !Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || !Array.isArray(v.records) || v.records.length > MAX_RENDER_RECORDS) throw new Error('Unsupported local render library; preserved without changes.')
  const records = v.records.map(parse)
  const ids = records.map(v => (v as {id:string}).id)
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate local render identities.')
  return {version:1,revision:v.revision as number,records}
}
export function serializeRenderLibrary<T>(value: RenderLibrary<T>, parse: (value: unknown) => T): string {
  const raw = JSON.stringify(value)
  parseRenderLibrary(raw,parse)
  return raw
}
export function activeRenderJob(job: RenderJob): boolean { return ['preparing','rendering','cancelling'].includes(job.status) }
export function recoverRenderJob(job: RenderJob): RenderJob {
  if (activeRenderJob(job)) return {...job,status:'interrupted',delivery:'unverified',message:'Interrupted. Output is unverified. Reopen the matching project and retry from the start.'}
  if (job.delivery === 'download') return {...job,delivery:'download-lost',message:'Reload discarded the encoded download. Retry to render it again.'}
  if (['queued','needs-destination','needs-review','needs-media'].includes(job.status)) return {...job,status:'needs-project',message:'Reopen the matching project revision before running.'}
  return job
}
export function moveRenderJob(jobs: readonly RenderJob[], id: string, delta: -1 | 1): readonly RenderJob[] {
  const index = jobs.findIndex(job => job.id === id); const target = index + delta
  if (index < 0 || target < 0 || target >= jobs.length || activeRenderJob(jobs[index]!) || activeRenderJob(jobs[target]!)) return jobs
  const next = [...jobs]; [next[index],next[target]] = [next[target]!,next[index]!]; return next
}
