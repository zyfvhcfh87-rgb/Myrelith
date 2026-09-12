import { parseCustomExportPreset,parseRenderJob,recoverRenderJob,activeRenderJob,moveRenderJob,MAX_RENDER_SNAPSHOT_BYTES,type RenderJob } from '../domain/renderJobs'
import { validateExportRange,type ExportRange } from '../domain/exportRange'
import { validateExportProfile,type ExportProfile } from '../domain/exportProfile'
import { sequenceById } from '../domain/projectSequences'
import { projectOutputMediaAssetIds,projectHasOutputPluginEffects } from '../domain/selectors'
import { useMediaStore } from '../state/mediaStore'
import { useRenderQueueStore } from '../state/renderQueueStore'
import { renderTransaction } from './localRenderStorage'
import { captureRenderSnapshot,renderSourcesMatch,type RenderSnapshot } from './renderSnapshot'
import { startExport,cancelExport,type ExportResult } from './exportController'
import { ExportCleanupIntegrityError } from '../pipeline/export'
import { requestExportFileDestination,type ExportFileDestinationCapability } from './exportFilePicker'
import { registerLoadedExportDisposer } from './exportLifecycle'
import { createPluginPreparedExportController,type PluginPreparedExportController } from './pluginPreparedExportController'
import { getPluginAppControllerOwner } from './pluginAppController'

const snapshots=new Map<string,RenderSnapshot>()
let result: {id:string;value:ExportResult}|null=null
let running: Promise<void>|null=null
let cancelRequested=false
let interrupted=false
let disposed=false
let initialized: Promise<void>|null=null
let prepared: PluginPreparedExportController|null=null
let integrityBlocked=false
const message=(cause:unknown)=> (cause instanceof Error?cause.message:String(cause)).slice(0,512)
const publishError=(cause:unknown)=>useRenderQueueStore.setState({error:message(cause)})

async function jobs(change?: (rows:readonly RenderJob[])=>readonly RenderJob[]): Promise<readonly RenderJob[]> {
  const library=await renderTransaction('jobs',parseRenderJob,change)
  useRenderQueueStore.setState({jobs:library.records})
  return library.records
}
async function update(id:string,change:Partial<RenderJob>): Promise<void>{
  await jobs(rows=>rows.map(row=>row.id===id?parseRenderJob({...row,...change}):row))
}
/** Never infer dead ownership from elapsed time: the browser lock is authoritative. */
async function exclusive(action:()=>Promise<void>): Promise<void>{
  if(!navigator.locks)throw new Error('This browser cannot safely own the persistent render queue. Use the single Export action.')
  await navigator.locks.request('myrelith-render-queue',{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock)throw new Error('Another tab owns the render queue. Finish or cancel it there first.')
    await action()
  })
}
export function initializeRenderQueue(): Promise<void>{
  disposed=false
  initialized??=(async()=>{
    await jobs()
    const presets=await renderTransaction('presets',parseCustomExportPreset)
    useRenderQueueStore.setState({presets:presets.records})
    // Recovery may only rewrite abandoned attempts while no other tab owns them.
    if(navigator.locks)await navigator.locks.request('myrelith-render-queue',{ifAvailable:true},async lock=>{
      if(lock)await jobs(rows=>rows.map(recoverRenderJob))
    })
  })().catch(cause=>{initialized=null;publishError(cause);throw cause})
  return initialized
}
export async function refreshRenderQueue(): Promise<void>{ await jobs() }
export async function saveExportPreset(name:string,profile:ExportProfile,id?:string): Promise<void>{
  const preset=parseCustomExportPreset({id:id??crypto.randomUUID(),name,profile})
  const library=await renderTransaction('presets',parseCustomExportPreset,rows=>{
    if(id && !rows.some(row=>row.id===id))throw new Error('This preset was removed in another tab.')
    return id?rows.map(row=>row.id===id?preset:row):[...rows,preset]
  })
  useRenderQueueStore.setState({presets:library.records,error:null})
}
export async function removeExportPreset(id:string): Promise<void>{
  const library=await renderTransaction('presets',parseCustomExportPreset,rows=>rows.filter(row=>row.id!==id))
  useRenderQueueStore.setState({presets:library.records})
}
export async function enqueueRenderJob(name:string,profile:ExportProfile,range:ExportRange): Promise<void>{
  await initializeRenderQueue()
  const snapshot=await captureRenderSnapshot()
  if(disposed)throw new Error('The project closed before queueing finished.')
  if(!renderSourcesMatch(snapshot))throw new Error('Media changed while capturing the job. Try again.')
  const doc=sequenceById(snapshot.project,snapshot.sequenceId)!
  const validatedRange=validateExportRange(doc,range)
  const retained=new Map([...snapshots.values()].map(value=>[value.revision,value.bytes]))
  retained.set(snapshot.revision,snapshot.bytes)
  if([...retained.values()].reduce((sum,bytes)=>sum+bytes,0)>MAX_RENDER_SNAPSHOT_BYTES)throw new Error('Queued snapshots exceed 64 MiB. Remove inactive jobs before adding another revision.')
  const row=parseRenderJob({id:crypto.randomUUID(),name,sequenceId:snapshot.sequenceId,binding:snapshot.binding,revision:snapshot.revision,range:validatedRange,profile:validateExportProfile(profile),status:'queued',delivery:'none',attempts:0,message:''})
  await jobs(rows=>[...rows,row])
  if(!disposed) {
    const shared=[...snapshots.values()].find(value=>value.revision===snapshot.revision)
    snapshots.set(row.id,shared ? {...shared,sequenceId:snapshot.sequenceId} : snapshot)
  }
}
export async function reorderRenderJob(id:string,delta:-1|1): Promise<void>{await jobs(rows=>moveRenderJob(rows,id,delta))}
export async function removeRenderJob(id:string): Promise<void>{
  await jobs(rows=>{if(rows.some(row=>row.id===id&&activeRenderJob(row)))throw new Error('Cancel the active job before removing it.');return rows.filter(row=>row.id!==id)})
  snapshots.delete(id)
  if(result?.id===id){result=null;useRenderQueueStore.setState({downloadId:null})}
}
export async function retryRenderJob(id:string): Promise<void>{
  await jobs(rows=>rows.map(row=>{
    if(row.id!==id)return row
    if(activeRenderJob(row))throw new Error('Wait for this attempt to finish cleanup.')
    if(row.delivery==='uncertain'||integrityBlocked)throw new Error('Output cleanup is uncertain. Reload before starting another attempt and inspect the selected file.')
    return {...row,status:'queued',message:'Retry will render from the first selected frame.'}
  }))
}
async function resolveSnapshot(job:RenderJob):Promise<RenderSnapshot>{
  const retained=snapshots.get(job.id)
  if(retained && renderSourcesMatch(retained))return retained
  const current=await captureRenderSnapshot()
  if(current.revision!==job.revision || current.binding!==job.binding)throw new Error('Reopen the exact saved or recovered project revision for this job. Current edits cannot replace its snapshot.')
  const snapshot={...current,sequenceId:job.sequenceId}
  snapshots.set(job.id,snapshot)
  return snapshot
}
function checkCancelled():void{if(cancelRequested||disposed)throw new DOMException('Render cancelled','AbortError')}
async function executeNext(destination?:ExportFileDestinationCapability, expectedId?:string):Promise<void>{
  const rows=await jobs()
  checkCancelled()
  const job=rows.find(row=>['queued','needs-project','needs-media','needs-destination','needs-review'].includes(row.status))
  if(!job)return
  if(expectedId && expectedId!==job.id)throw new Error('The queue order changed. Choose a destination for the new first job.')
  if(job.delivery==='uncertain'||integrityBlocked)throw new Error('Output cleanup is uncertain. Reload and inspect the selected file before retrying.')
  let snapshot:RenderSnapshot
  try{snapshot=await resolveSnapshot(job)}catch(cause){await update(job.id,{status:'needs-project',message:message(cause)});return}
  checkCancelled()
  if(!renderSourcesMatch(snapshot)){await update(job.id,{status:'needs-media',message:'Sources changed. Reconnect the original media for this job.'});return}
  const missing=[...projectOutputMediaAssetIds(snapshot.project,job.sequenceId,job.profile.audioChannelLayout!=='off')].filter(id=>!useMediaStore.getState().assets.has(id))
  if(missing.length){await update(job.id,{status:'needs-media',message:`Reconnect ${missing.length} original source(s) before running this job.`});return}
  if(job.profile.destination==='file'&&!destination){await update(job.id,{status:'needs-destination',message:'Choose an output file to start this job.'});return}
  useRenderQueueStore.setState({activeId:job.id,progress:0,error:null})
  await update(job.id,{status:'preparing',attempts:job.attempts+1,delivery:'unverified',message:'Preparing a fresh export attempt.'})
  try{
    checkCancelled()
    const doc=sequenceById(snapshot.project,job.sequenceId)
    if(!doc)throw new Error('The queued sequence no longer exists.')
    const callbacks={range:job.range,snapshot:{project:snapshot.project,sequenceId:job.sequenceId},fileDestination:destination,onProgress:(progress:number)=>{
      useRenderQueueStore.setState({progress})
    }}
    let readyToken:string|null=null
    if(projectHasOutputPluginEffects(snapshot.project,job.sequenceId)){
      prepared=createPluginPreparedExportController({appOwner:getPluginAppControllerOwner(),getDocumentSnapshot:()=>({document:doc,generation:0,project:snapshot.project,sequenceId:job.sequenceId})})
      const preparation=await prepared.prepare(job.profile)
      checkCancelled()
      if(preparation.status==='blocked'){
        await update(job.id,{status:'needs-review',delivery:'none',message:preparation.attempt.blockers.map(blocker=>blocker.reason).join('; ').slice(0,512)})
        return
      }
      if(preparation.status!=='ready')throw new Error('Plugin export preparation is unavailable.')
      readyToken=preparation.token
    }
    checkCancelled()
    if(!renderSourcesMatch(snapshot))throw new Error('Original media changed during export preparation.')
    await update(job.id,{status:'rendering',message:job.range.startFrame>0?'Rendering, including audio pre-roll before In.':'Rendering.'})
    checkCancelled()
    const output=prepared&&readyToken?await prepared.start(readyToken,callbacks):await startExport(job.profile,callbacks)
    if(output){
      if(output.destination==='download'){
        result={id:job.id,value:output}
        useRenderQueueStore.setState({downloadId:job.id})
      }
      await update(job.id,{status:'completed',delivery:output.destination==='file'?'file':'download',message:output.destination==='file'?`Committed ${output.fileName}`:'Download available in this session. It has not been verified as saved.'})
    }else await update(job.id,{status:interrupted?'interrupted':'cancelled',delivery:'aborted',message:'Attempt stopped. Retry starts at the beginning; the selected file may remain empty.'})
  }catch(cause){
    const integrity=cause instanceof ExportCleanupIntegrityError
    integrityBlocked ||= integrity
    await update(job.id,{status:interrupted?'interrupted':cancelRequested?'cancelled':'failed',delivery:integrity?'uncertain':'unverified',message:message(cause)})
  }finally{
    try{await prepared?.close('render-queue-attempt-ended')}catch(cause){
      integrityBlocked=true
      await update(job.id,{status:'failed',delivery:'uncertain',message:`Plugin cleanup failed: ${message(cause)}`.slice(0,512)})
    }finally{prepared=null;useRenderQueueStore.setState({activeId:null,progress:0})}
  }
}
export function runRenderQueue(destination?:ExportFileDestinationCapability,expectedId?:string):Promise<void>{
  if(running)return Promise.reject(new Error('The render queue is already active.'))
  if(result)return Promise.reject(new Error('Download or discard the completed result before continuing.'))
  if(document.visibilityState==='hidden')return Promise.reject(new Error('Return to this tab before starting the queue.'))
  if(integrityBlocked)return Promise.reject(new Error('Output cleanup is uncertain. Reload before another attempt.'))
  cancelRequested=false;interrupted=false;disposed=false
  running=exclusive(()=>executeNext(destination,expectedId)).catch(cause=>{publishError(cause);throw cause}).finally(()=>{running=null;useRenderQueueStore.setState({activeId:null})})
  return running
}
/** Invoke directly from the click: do not await a storage read before the picker. */
export async function chooseRenderDestination():Promise<void>{
  const job=useRenderQueueStore.getState().jobs.find(row=>['queued','needs-destination','needs-project','needs-media','needs-review'].includes(row.status))
  if(!job||job.profile.destination!=='file')throw new Error('The next job does not need a direct file.')
  const selected=await requestExportFileDestination(job.profile,`${job.name}.${job.profile.fileExtension}`)
  if(selected.status==='selected')await runRenderQueue(selected.destination,job.id)
  else if(selected.status!=='cancelled')throw new Error(selected.reason)
}
export async function cancelRenderQueue(asInterruption=false):Promise<void>{
  cancelRequested=true;interrupted ||= asInterruption
  const id=useRenderQueueStore.getState().activeId
  const cancel=running ? (prepared?prepared.cancel('render-queue-cancel'):cancelExport()) : Promise.resolve()
  if(id)await jobs(rows=>rows.map(row=>row.id===id&&activeRenderJob(row)?{...row,status:'cancelling',message:asInterruption?'Interrupted; waiting for cleanup.':'Cancelling; waiting for cleanup.'}:row))
  await cancel
  await running
}
export async function consumeRenderDownload(download:boolean):Promise<void>{
  if(!result||result.value.destination!=='download')throw new Error('The download was lost. Retry this job.')
  const current=result
  const output=result.value
  if(download){
    const url=URL.createObjectURL(new Blob([output.buffer],{type:current.value.mimeType}))
    try{const link=document.createElement('a');link.href=url;link.download=`render-${current.id}.${current.value.fileExtension}`;link.click()}finally{setTimeout(()=>URL.revokeObjectURL(url),1000)}
  }
  await update(current.id,{delivery:download?'download-requested':'discarded',message:download?'Download requested; disk save is not verifiable.':'Encoded download discarded.'})
  result=null;useRenderQueueStore.setState({downloadId:null})
}
registerLoadedExportDisposer(async()=>{
  disposed=true
  await cancelRenderQueue(true)
  snapshots.clear();result=null;initialized=null
  useRenderQueueStore.setState({downloadId:null})
})
if(typeof document!=='undefined'){
  document.addEventListener('visibilitychange',()=>useRenderQueueStore.setState({background:document.visibilityState==='hidden'}))
  const interrupt=()=>{if(running)void cancelRenderQueue(true).catch(publishError)}
  document.addEventListener('freeze',interrupt)
  window.addEventListener('pagehide',interrupt)
}
export function reportRenderQueueError(cause:unknown):void{publishError(cause)}
