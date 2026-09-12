import { describe,it,expect } from 'vitest'
import { DEFAULT_EXPORT_PROFILE } from './exportProfile'
import { parseRenderJob,parseRenderLibrary,serializeRenderLibrary,recoverRenderJob,moveRenderJob, type RenderJob } from './renderJobs'
const job: RenderJob = {id:'a',name:'A',sequenceId:'s',binding:'local',revision:'a'.repeat(64),range:{startFrame:4,endFrame:5},profile:DEFAULT_EXPORT_PROFILE,status:'queued',delivery:'none',attempts:0,message:''}
describe('persistent render facts',()=>{
  it('round trips concrete intent, never resources',()=>{ const raw=serializeRenderLibrary({version:1,revision:2,records:[job]},parseRenderJob); expect(parseRenderLibrary(raw,parseRenderJob).records).toEqual([job]); expect(()=>parseRenderJob({...job,buffer:[]})).toThrow() })
  it('rejects hostile and future libraries without repairing them',()=>{ for(const raw of ['{}',JSON.stringify({version:2,revision:0,records:[]}),JSON.stringify({version:1,revision:0,records:[job,job]})]) expect(()=>parseRenderLibrary(raw,parseRenderJob)).toThrow() })
  it('rejects invalid ranges, profiles and unbounded metadata',()=>{for(const patch of [{range:{startFrame:5,endFrame:5}},{name:'x'.repeat(129)},{attempts:-1},{profile:{...job.profile,videoCodec:'magic'}},{revision:'wrong'}]) expect(()=>parseRenderJob({...job,...patch})).toThrow()})
  it('recovers attempts as interrupted, not resumable',()=>{for(const status of ['preparing','rendering','cancelling'] as const) expect(recoverRenderJob({...job,status})).toMatchObject({status:'interrupted',delivery:'unverified'}); expect(recoverRenderJob({...job,status:'completed',delivery:'download'}).delivery).toBe('download-lost')})
  it('reorders only inactive jobs',()=>{const jobs=[job,{...job,id:'b'}]; expect(moveRenderJob(jobs,'b',-1)[0]?.id).toBe('b'); const active=[job,{...job,id:'b',status:'rendering' as const}]; expect(moveRenderJob(active,'a',1)).toBe(active)})
})
