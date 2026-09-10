import type { SequenceProject } from '../domain/projectSequences'
import { createProjectFileSnapshot, serializeProjectFile } from '../domain/projectFile'
import type { MediaCollection } from '../domain/mediaCollections'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import { MAX_RENDER_SNAPSHOT_BYTES } from '../domain/renderJobs'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'

/** Conservative logical retention/scratch admission before stringify allocates. */
function measure(value: unknown, depth=0): number {
  if(depth>64)throw new Error('Render snapshot is too deeply nested.')
  if(value===null || value===undefined)return 16
  if(typeof value==='string')return 64+value.length*12
  if(typeof value==='number'||typeof value==='boolean')return 64
  if(typeof value!=='object')throw new Error('Render snapshots require portable data.')
  let size=128
  for(const [key,child] of Object.entries(value)){
    size+=64+key.length*12+measure(child,depth+1)
    if(size>MAX_RENDER_SNAPSHOT_BYTES)throw new Error('Queued snapshot exceeds the 64 MiB retention and scratch allowance.')
  }
  return size
}
function canonical(value: unknown): unknown {
  if(Array.isArray(value))return value.map(canonical)
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)]))
  return value
}
export interface RenderSnapshot {
  readonly project: SequenceProject
  readonly sequenceId: string
  readonly binding: string
  readonly revision: string
  readonly descriptorJson: string
  readonly bytes: number
}
async function sha256Hex(serialized: string): Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serialized))
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')
}
export async function renderRevisionDigest(
  project: SequenceProject,
  descriptors: readonly PortableAssetDescriptor[],
  collections: readonly MediaCollection[] = [],
): Promise<string> {
  const portable=serializeProjectFile(createProjectFileSnapshot(project,descriptors,collections))
  return sha256Hex(portable)
}
export async function captureRenderSnapshot(): Promise<RenderSnapshot> {
  const state=useDocumentStore.getState()
  const project=state.project, sequenceId=state.activeSequenceId
  const generation=state.projectGeneration
  const binding=getActiveLocalProjectBindingId()
  if(!binding)throw new Error('Open a local project before queueing an export.')
  const media=useMediaStore.getState()
  const descriptors=[...media.descriptors.values()].sort((a,b)=>a.id.localeCompare(b.id))
  // Hash the validated portable representation rather than the live Zustand
  // object. Recovery/project-file parsing normalizes optional fields, so a
  // raw object hash would incorrectly turn an unchanged reopened revision
  // into `needs-project` after reload.
  const portable=serializeProjectFile(createProjectFileSnapshot(project,descriptors,media.collections))
  const bytes=measure({project:portable,descriptors,collections:media.collections})
  const descriptorJson=JSON.stringify(canonical(descriptors))
  const revision=await sha256Hex(portable)
  if(useDocumentStore.getState().project!==project || useDocumentStore.getState().projectGeneration!==generation || getActiveLocalProjectBindingId()!==binding)throw new Error('The project changed while capturing the job. Try again.')
  return {project,sequenceId,binding,revision,descriptorJson,bytes}
}
export function renderSourcesMatch(snapshot: RenderSnapshot): boolean {
  return snapshot.binding===getActiveLocalProjectBindingId() && snapshot.descriptorJson===JSON.stringify(canonical([...useMediaStore.getState().descriptors.values()].sort((a,b)=>a.id.localeCompare(b.id))))
}
