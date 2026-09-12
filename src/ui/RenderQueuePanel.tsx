import { useEffect,useState } from 'react'
import type { ExportSettingsUnion } from '../domain/deliveryProduct'
import { exportSettingsSummary } from '../domain/deliveryProduct'
import { docDurationFrames } from '../domain/selectors'
import { validateExportRange } from '../domain/exportRange'
import { activeRenderJob } from '../domain/renderJobs'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useRenderQueueStore } from '../state/renderQueueStore'
import { initializeRenderQueue,refreshRenderQueue,enqueueRenderJob,runRenderQueue,chooseRenderDestination,cancelRenderQueue,retryRenderJob,reorderRenderJob,removeRenderJob,consumeRenderDownload,saveExportPreset,removeExportPreset,reportRenderQueueError } from '../app/renderQueueController'

export function RenderQueuePanel({profile,onProfile,disabled,chapters}:{profile:Readonly<ExportSettingsUnion>|null;onProfile:(profile:Readonly<ExportSettingsUnion>)=>void;disabled:boolean;chapters?:{mode:'off'|'sidecar'}}){
 const doc=useDocumentStore(state=>state.doc)
 const inOut=useTransportStore(state=>state.inOut)
 const view=useRenderQueueStore()
 const [name,setName]=useState('')
 const [mode,setMode]=useState('full')
 const [startMarker,setStartMarker]=useState('')
 const [endMarker,setEndMarker]=useState('')
 const [presetId,setPresetId]=useState('')
 const [presetName,setPresetName]=useState('')
 const [pending,setPending]=useState(false)
 useEffect(()=>{void initializeRenderQueue().catch(reportRenderQueueError)},[])
 const act=(action:()=>Promise<void>)=>{setPending(true);void action().catch(reportRenderQueueError).finally(()=>setPending(false))}
 const markers=doc.markers??[]
 let range: {startFrame:number;endFrame:number}|null=null
 let rangeError: string|null=null
 try{
  if(mode==='full')range=validateExportRange(doc)
  else if(mode==='inout'){
   if(!inOut)throw new Error('Set both timeline In and Out marks first.')
   range=validateExportRange(doc,{startFrame:inOut.startFrame,endFrame:inOut.startFrame+inOut.durationFrames})
  }else{
   const start=markers.find(marker=>marker.id===startMarker),end=markers.find(marker=>marker.id===endMarker)
   if(!start||!end)throw new Error('Choose Start and End markers.')
   range=validateExportRange(doc,{startFrame:start.frame,endFrame:end.frame})
  }
 }catch(error){rangeError=error instanceof Error?error.message:String(error)}
 const next=view.jobs.find(job=>['queued','needs-project','needs-media','needs-destination','needs-review'].includes(job.status))
 const selectedPreset=view.presets.find(preset=>preset.id===presetId)
 return <section className="render-queue" aria-label="Render queue and saved presets">
  <details><summary>Saved export presets</summary>
   <label htmlFor="render-preset-select">Saved preset <select id="render-preset-select" value={presetId} onChange={event=>{const id=event.target.value;setPresetId(id);setPresetName(view.presets.find(p=>p.id===id)?.name??'')}}><option value="">New preset</option>{view.presets.map(preset=><option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
   <label htmlFor="render-preset-name">Preset name <input id="render-preset-name" value={presetName} maxLength={128} onChange={event=>setPresetName(event.target.value)}/></label>
   <div className="render-queue-actions">
    <button type="button" disabled={disabled||pending||!profile||!presetName.trim()} onClick={()=>act(()=>saveExportPreset(presetName,profile!))}>Save new preset</button>
    <button type="button" disabled={disabled||pending||!selectedPreset} onClick={()=>selectedPreset&&onProfile(selectedPreset.profile)}>Use preset</button>
    <button type="button" disabled={disabled||pending||!selectedPreset||!presetName.trim()} onClick={()=>act(()=>saveExportPreset(presetName,selectedPreset!.profile,presetId))}>Rename preset</button>
    <button type="button" disabled={disabled||pending||!selectedPreset||!profile||!presetName.trim()} onClick={()=>act(()=>saveExportPreset(presetName,profile!,presetId))}>Replace preset settings</button>
    <button type="button" disabled={pending||!selectedPreset} onClick={()=>act(()=>removeExportPreset(presetId))}>Delete preset</button>
   </div>
  </details>
  <details open><summary>Render queue ({view.jobs.length}/100)</summary>
   <p>Jobs capture the current edit. After reload, reopen that same saved revision and reconnect its media. Keep this tab open; interrupted jobs restart from the beginning.</p>
   <label htmlFor="render-job-name">Job name <input id="render-job-name" value={name} maxLength={128} placeholder={doc.name} onChange={event=>setName(event.target.value)}/></label>
   <label htmlFor="render-queue-range">Queue range <select id="render-queue-range" value={mode} onChange={event=>setMode(event.target.value)}><option value="full">Full sequence</option><option value="inout">Timeline In/Out</option><option value="markers">Between markers</option></select></label>
   {mode==='markers'&&<div className="render-queue-actions">{(['Start','End'] as const).map(edge=>{const id=edge==='Start'?'render-start-marker':'render-end-marker';return <label key={edge} htmlFor={id}>{edge} marker <select id={id} value={edge==='Start'?startMarker:endMarker} onChange={event=>(edge==='Start'?setStartMarker:setEndMarker)(event.target.value)}><option value="">Choose marker</option>{markers.map(marker=><option key={marker.id} value={marker.id}>{marker.label||'Marker'} — frame {marker.frame}</option>)}</select></label>})}</div>}
   <p>{range?`Frames ${range.startFrame}–${range.endFrame} (End exclusive): ${range.endFrame-range.startFrame} of ${docDurationFrames(doc)} frames.`:rangeError}</p>
   <div className="render-queue-actions">
    <button type="button" disabled={disabled||pending||!profile||!range||view.jobs.length>=100} onClick={()=>act(()=>enqueueRenderJob(name.trim()||doc.name,profile!,range!,chapters))}>Add render job</button>
    <button type="button" disabled={disabled||pending||!!view.activeId||!!view.downloadId||!next} onClick={()=>act(()=>next?.profile.destination==='file'||next?.profile.destination==='directory'?chooseRenderDestination():runRenderQueue())}>{next?.profile.destination==='file'?'Choose file and run next':next?.profile.destination==='directory'?'Choose folder and run next':'Run next job'}</button>
    <button type="button" disabled={!view.activeId} onClick={()=>act(()=>cancelRenderQueue())}>Cancel active job</button>
    <button type="button" disabled={pending} onClick={()=>act(refreshRenderQueue)}>Refresh queue</button>
   </div>
   {view.background&&view.activeId&&<p role="status">Tab hidden. Rendering progress is unverified; browser suspension can interrupt this attempt.</p>}
   {view.activeId&&<p role="status">{view.background?'Last observed progress':'Rendering, including any audio pre-roll'}: {Math.floor(view.progress*100)}%</p>}
   {view.error&&<p role="status" aria-live="polite">{view.error}</p>}
   <ol className="render-job-list">{view.jobs.map((job,index)=><li key={job.id}>
    <strong>{job.name}</strong> — {job.status} · frames {job.range.startFrame}–{job.range.endFrame} · {exportSettingsSummary(job.profile)}{job.chapters.mode==='sidecar'?' · chapters sidecar':''} · attempt {job.attempts}
    <p>{job.message} {job.delivery==='uncertain'?'Inspect the selected file; cleanup could not be confirmed.':''}</p>
    <div className="render-queue-actions">
     <button type="button" aria-label={`Move ${job.name} up`} disabled={pending||activeRenderJob(job)||index===0} onClick={()=>act(()=>reorderRenderJob(job.id,-1))}>↑</button>
     <button type="button" aria-label={`Move ${job.name} down`} disabled={pending||activeRenderJob(job)||index===view.jobs.length-1} onClick={()=>act(()=>reorderRenderJob(job.id,1))}>↓</button>
     <button type="button" disabled={pending||activeRenderJob(job)||view.downloadId===job.id} onClick={()=>act(()=>retryRenderJob(job.id))}>Retry {job.name}</button>
     <button type="button" disabled={pending||activeRenderJob(job)} onClick={()=>act(()=>removeRenderJob(job.id))}>Remove {job.name}</button>
     {view.downloadId===job.id&&<><button type="button" disabled={pending} onClick={()=>act(()=>consumeRenderDownload(true))}>Download {job.name}</button><button type="button" disabled={pending} onClick={()=>act(()=>consumeRenderDownload(false))}>Discard download</button></>}
    </div>
   </li>)}</ol>
  </details>
 </section>
}
