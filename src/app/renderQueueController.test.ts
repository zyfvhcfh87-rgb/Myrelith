import {beforeEach,describe,it,expect,vi} from 'vitest'
import {DEFAULT_EXPORT_PROFILE} from '../domain/exportProfile'
import {createTimelineDoc} from '../domain/projectSettings'
import {sequenceProjectFromTimeline} from '../domain/projectSequences'
import type {RenderJob} from '../domain/renderJobs'
const fake=vi.hoisted(()=>({rows:[] as RenderJob[],start:vi.fn(),cancel:vi.fn(),capture:vi.fn(),matches:vi.fn(),writeFailure:false,lockAvailable:true}))
vi.mock('./exportController',()=>({startExport:fake.start,cancelExport:fake.cancel}))
vi.mock('./renderSnapshot',()=>({captureRenderSnapshot:fake.capture,renderSourcesMatch:fake.matches}))
vi.mock('./localRenderStorage',()=>({renderTransaction:async(key:string,_parse:unknown,change?: (rows:readonly RenderJob[])=>readonly RenderJob[])=>{
 if(fake.writeFailure&&change)throw new Error('Quota exhausted')
 if(key==='presets')return {version:1,revision:0,records:[]}
 if(change)fake.rows=[...change(fake.rows)]
 return {version:1,revision:0,records:fake.rows}
}}))
vi.mock('./exportLifecycle',()=>({registerLoadedExportDisposer:vi.fn()}))
vi.mock('./pluginAppController',()=>({getPluginAppControllerOwner:vi.fn()}))
vi.mock('./pluginPreparedExportController',()=>({createPluginPreparedExportController:vi.fn()}))
const profile={...DEFAULT_EXPORT_PROFILE,audioChannelLayout:'off' as const,audioCodec:null,audioBitrate:null,audioBitrateMode:null}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
async function setup(){
 const controller=await import('./renderQueueController')
 const store=(await import('../state/renderQueueStore')).useRenderQueueStore
 await controller.initializeRenderQueue()
 return {controller,store}
}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();fake.rows=[];fake.writeFailure=false;fake.lockAvailable=true
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:string,_options:unknown,callback:(lock:object|null)=>Promise<void>)=>callback(fake.lockAvailable?{}:null)}})
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
 const doc=structuredClone(createTimelineDoc('Job',{width:1280,height:720,frameRate:{num:30,den:1},audioSampleRate:48000},'doc'))
 doc.captionTracks=[{id:'captions',name:'C',language:'en',role:'subtitles',stylePreset:'classic',hidden:false,items:[{id:'cue',text:'test',range:{startFrame:0,durationFrames:10}}]}]
 fake.capture.mockResolvedValue({project:sequenceProjectFromTimeline(doc),sequenceId:doc.id,binding:'local',revision:'a'.repeat(64),descriptorJson:'[]',bytes:1000})
 fake.matches.mockReturnValue(true)
 fake.start.mockResolvedValue({destination:'file',fileName:'test.mp4'})
 fake.cancel.mockResolvedValue(undefined)
})
describe('render queue ownership',()=>{
 it('runs immutable captured input, serial order, and supports reordering',async()=>{
  const {controller:c}=await setup()
  await c.enqueueRenderJob('first',profile,{startFrame:2,endFrame:5});await c.enqueueRenderJob('second',profile,{startFrame:6,endFrame:8})
  await c.reorderRenderJob(fake.rows[1]!.id,-1)
  await c.runRenderQueue()
  expect(fake.start.mock.calls[0]?.[1].range).toEqual({startFrame:6,endFrame:8})
  expect(fake.rows[0]?.status).toBe('completed');expect(fake.rows[1]?.status).toBe('queued')
 })
 it('retains admission through cancellation cleanup',async()=>{
  const {controller:c}=await setup();await c.enqueueRenderJob('one',profile,{startFrame:0,endFrame:5})
  const work=deferred<undefined>();fake.start.mockReturnValue(work.promise);fake.cancel.mockReturnValue(work.promise)
  const run=c.runRenderQueue();await vi.waitFor(()=>expect(fake.start).toHaveBeenCalledOnce())
  const cancel=c.cancelRenderQueue();await expect(c.runRenderQueue()).rejects.toThrow('already active')
  work.resolve(undefined);await cancel;await run
  expect(fake.rows[0]?.status).toBe('cancelled')
 })
 it('does not overwrite committed completion with a late cancel',async()=>{
  const {controller:c}=await setup();await c.enqueueRenderJob('one',profile,{startFrame:0,endFrame:5});await c.runRenderQueue();await c.cancelRenderQueue()
  expect(fake.rows[0]?.status).toBe('completed')
 })
 it('requires a matching revision after reload',async()=>{
  const {controller:c}=await setup();await c.enqueueRenderJob('one',profile,{startFrame:0,endFrame:5})
  vi.resetModules();fake.capture.mockResolvedValue({...await fake.capture(),revision:'b'.repeat(64)})
  const fresh=await setup();await fresh.controller.runRenderQueue()
  expect(fake.rows[0]?.status).toBe('needs-project');expect(fake.start).not.toHaveBeenCalled()
 })
 it('cannot start when another tab owns the queue or storage fails',async()=>{
  const {controller:c}=await setup();await c.enqueueRenderJob('one',profile,{startFrame:0,endFrame:5})
  fake.lockAvailable=false;await expect(c.runRenderQueue()).rejects.toThrow('Another tab')
  fake.lockAvailable=true;fake.writeFailure=true;await expect(c.runRenderQueue()).rejects.toThrow('Quota')
  expect(fake.start).not.toHaveBeenCalled()
 })
 it('holds one buffered result and requires explicit discard before continuing',async()=>{
  const {controller:c}=await setup();await c.enqueueRenderJob('one',profile,{startFrame:0,endFrame:5})
  fake.start.mockResolvedValue({destination:'download',buffer:new ArrayBuffer(2),mimeType:'video/mp4',fileExtension:'mp4'})
  await c.runRenderQueue();await expect(c.runRenderQueue()).rejects.toThrow('Download or discard')
  await c.consumeRenderDownload(false);expect(fake.rows[0]?.delivery).toBe('discarded')
 })
 it('does not admit hidden-page jobs',async()=>{
  const {controller:c}=await setup();Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})
  await expect(c.runRenderQueue()).rejects.toThrow('Return to this tab');expect(fake.start).not.toHaveBeenCalled()
 })
})
