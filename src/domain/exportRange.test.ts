import {describe,it,expect} from 'vitest'
import {validateExportRange,exportSampleBoundary} from './exportRange'
import {audioSampleBoundary} from './time'
import type {TimelineDoc} from './schema'
const doc: TimelineDoc = {schemaVersion:24,id:'d',name:'D',width:16,height:16,frameRate:{num:30000,den:1001},audioSampleRate:96000,tracks:[],captionTracks:[{id:'ct',name:'C',language:'en',role:'subtitles',hidden:false,stylePreset:'classic',items:[{id:'c',text:'End',range:{startFrame:0,durationFrames:30}}]}]}
// Only duration, rate and sample-rate fields are consumed by these pure contracts.
describe('export range',()=>{
 it('keeps a single final frame and rejects inverted or overflowing ranges',()=>{
  const full=validateExportRange(doc); expect(full.endFrame).toBe(30)
  expect(validateExportRange(doc,{startFrame:29,endFrame:30})).toEqual({startFrame:29,endFrame:30})
  for(const range of [{startFrame:0,endFrame:31},{startFrame:5,endFrame:5},{startFrame:1.5,endFrame:2},{startFrame:-1,endFrame:2}]) expect(()=>validateExportRange(doc,range)).toThrow()
 })
 it('telescopes exact audio endpoints at fractional rates and downsampling',()=>{
  for(const num of [24000,30000,60000]) for(const rate of [44100,48000,96000]) {
   const d={...doc,frameRate:{num,den:1001},audioSampleRate:rate}
   for(let start=0;start<20;start++) {
    const end=start+7, encoder=rate===96000?48000:rate
    const a=exportSampleBoundary(start,d,encoder), b=exportSampleBoundary(end,d,encoder)
    expect(a).toBe(Number(BigInt(audioSampleBoundary(start,d))*BigInt(encoder)/BigInt(rate)))
    let sum=0;for(let f=start;f<end;f++) sum+=exportSampleBoundary(f+1,d,encoder)-exportSampleBoundary(f,d,encoder)
    expect(sum).toBe(b-a)
   }
  }
 })
})
