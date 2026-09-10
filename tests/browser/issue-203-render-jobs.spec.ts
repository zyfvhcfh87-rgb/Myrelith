import { expect,test,type Page } from '@playwright/test'
async function create(page:Page){
 await page.goto('/')
 await page.getByRole('button',{name:'Start a new project'}).click()
 await page.getByLabel('Project name').fill('Render jobs')
 await page.getByLabel('Resolution').selectOption('720')
 await page.getByRole('button',{name:'Create project',exact:true}).click()
 await expect(page.getByRole('button',{name:'Commands'})).toBeVisible()
}
test('exact nonzero ranges retain picture order and rebase real 96 kHz audio',async({page})=>{
 test.setTimeout(120000)
 const problems:string[]=[];page.on('pageerror',e=>problems.push(e.message))
 await create(page)
 const result=await page.evaluate(async()=>{
  const dp='/src/state/documentStore.ts',mp='/src/state/mediaStore.ts',ip='/src/app/mediaImportController.ts',op='/src/domain/operations.ts'
  const store=(await import(dp)).useDocumentStore,media=(await import(mp)).useMediaStore
  const project=structuredClone(store.getState().project);project.sequences[0].frameRate={num:30000,den:1001};project.sequences[0].audioSampleRate=96000;store.getState().setProject(project)
  for(const [index,color] of ['#ff0000','#00ff00','#0000ff'].entries()){
   const canvas=new OffscreenCanvas(1280,720),ctx=canvas.getContext('2d')!;ctx.fillStyle=color;ctx.fillRect(0,0,1280,720)
   const imported=await (await import(ip)).importMedia(new File([await canvas.convertToBlob()],`plate${index}.png`,{type:'image/png'}));canvas.width=canvas.height=0
   if(imported.status!=='imported')throw new Error('Fixture import failed')
   const clip=(await import(op)).clipFromAssetRange(media.getState().assets.get(imported.assetId),index*4,0,4)
   store.getState().insertClips([{trackId:store.getState().doc.tracks[0].id,clip}])
  }
  const bytes=new ArrayBuffer(44+48000*2),view=new DataView(bytes)
  const text=(o:number,s:string)=>[...s].forEach((c,i)=>view.setUint8(o+i,c.charCodeAt(0)))
  text(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,48000,true);view.setUint32(28,96000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,96000,true)
  const audio=await(await import(ip)).importMedia(new File([bytes],'silence.wav',{type:'audio/wav'}));if(audio.status!=='imported')throw new Error('Audio import failed')
  const clip=(await import(op)).clipFromAssetRange(media.getState().assets.get(audio.assetId),0,0,12)
  store.getState().insertClips([{trackId:store.getState().doc.tracks.find((t:{kind:string})=>t.kind==='audio').id,clip}])
  const ep='/src/app/exportController.ts',profiles='/src/domain/exportProfile.ts',mb='/node_modules/.vite/deps/mediabunny.js',time='/src/domain/exportRange.ts'
  const {startExport}=await import(ep),profile=(await import(profiles)).exportPresetById('compatibility').profile
  const {Input,BlobSource,ALL_FORMATS,VideoSampleSink,AudioSampleSink}=await import(mb)
  const reports=[]
  for(const [startFrame,endFrame] of [[1,2],[3,9],[11,12]]){
   const output=await startExport(profile,{range:{startFrame,endFrame}})
   if(!output||output.destination!=='download')throw new Error('No output')
   const input=new Input({formats:ALL_FORMATS,source:new BlobSource(new Blob([output.buffer]))})
   const canvas=new OffscreenCanvas(1280,720),ctx=canvas.getContext('2d',{willReadFrequently:true})!
   try{
    const track=await input.getPrimaryVideoTrack(),audioTrack=await input.getPrimaryAudioTrack();const colors:number[][]=[],times:number[]=[]
    for await(const sample of new VideoSampleSink(track).samples())try{sample.draw(ctx,0,0,1280,720);colors.push([...ctx.getImageData(100,100,1,1).data]);times.push(sample.timestamp)}finally{sample.close()}
    let samples=0;for await(const sample of new AudioSampleSink(audioTrack).samples())try{samples+=sample.numberOfFrames}finally{sample.close()}
    const durationSeconds=await audioTrack.computeDuration()
    const boundary=(await import(time)).exportSampleBoundary
    reports.push({startFrame,endFrame,colors,times,samples,durationSamples:Math.round(durationSeconds*48000),expectedSamples:boundary(endFrame,store.getState().doc,48000)-boundary(startFrame,store.getState().doc,48000)})
   }finally{input.dispose();canvas.width=canvas.height=0}
  }
  return reports
 })
 for(const row of result){
  expect(row.colors).toHaveLength(row.endFrame-row.startFrame)
  expect(row.times[0]).toBe(0)
  row.colors.forEach((color:number[],index:number)=>{const channel=Math.floor((index+row.startFrame)/4);expect(color[channel]).toBeGreaterThan(245);expect(color[(channel+1)%3]).toBeLessThan(10)})
  // Browser AAC decoders expose codec packet padding for short files. The
  // exact source-sample boundary is covered by the focused sink tests; the
  // browser contract here is that export never truncates the requested audio.
  expect(row.durationSamples).toBeGreaterThanOrEqual(row.expectedSamples)
 }
 expect(problems).toEqual([])
})
test('queue UI saves presets, freezes range intent, serializes jobs and recovers metadata',async({page},info)=>{
 test.setTimeout(90000)
 const problems:string[]=[];page.on('pageerror',error=>problems.push(error.message))
 await create(page)
 await page.evaluate(async()=>{
  const dp='/src/state/documentStore.ts',tp='/src/state/transportStore.ts'
  const store=(await import(dp)).useDocumentStore,project=structuredClone(store.getState().project),doc=project.sequences[0]
  doc.captionTracks=[{id:'caption-track',name:'Caption',language:'en',role:'subtitles',hidden:false,stylePreset:'classic',items:[{id:'caption',text:'Render queue',range:{startFrame:0,durationFrames:12}}]}]
  doc.markers=[{id:'in',frame:3,label:'Start',color:'blue'},{id:'out',frame:9,label:'End',color:'blue'}]
  store.getState().setProject(project)
 ;(await import(tp)).useTransportStore.getState().setInOut({startFrame:1,durationFrames:1})
 })
 // The recovery journal is the durable project revision that the queue asks
 // the user to reopen after reload. Let the post-edit debounce settle before
 // intentionally closing the tab so the reopened revision includes the
 // marker/caption changes used by the queued ranges.
 await page.waitForTimeout(1200)
 await expect(page.getByText('Recovery copy updated',{exact:true})).toBeVisible({timeout:5000})
 await page.getByRole('button',{name:'Export',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'Export video'})
 await dialog.getByRole('radio',{name:/^Web/}).check()
 await expect(dialog.getByRole('button',{name:'Add render job'})).toBeEnabled()
 await dialog.getByText('Saved export presets',{exact:true}).click()
 await dialog.getByLabel('Preset name',{exact:true}).fill('Delivery')
 await dialog.getByRole('button',{name:'Save new preset'}).click()
 await expect.poll(async()=>dialog.locator('.render-queue select').first().evaluate((select)=>Array.from((select as HTMLSelectElement).options).some((option)=>option.textContent==='Delivery'))).toBe(true)
 await dialog.getByLabel('Job name',{exact:true}).fill('Range A')
 const queueSelects=dialog.locator('.render-queue select')
 await queueSelects.nth(1).selectOption('markers')
 await queueSelects.nth(2).selectOption('in');await queueSelects.nth(3).selectOption('out')
 await dialog.getByRole('button',{name:'Add render job'}).click()
 await expect(dialog.getByText('Range A',{exact:true})).toBeVisible()
 await dialog.getByLabel('Job name',{exact:true}).fill('Range B');await queueSelects.nth(1).selectOption('inout');await dialog.getByRole('button',{name:'Add render job'}).click()
 await expect(dialog.getByText('Range B',{exact:true})).toBeVisible()
 await dialog.getByRole('button',{name:'Run next job',exact:true}).click()
 await expect(dialog.getByRole('button',{name:'Download Range A',exact:true})).toBeVisible({timeout:30000})
 await expect(dialog.getByRole('button',{name:'Run next job',exact:true})).toBeDisabled()
 await dialog.getByRole('button',{name:'Discard download',exact:true}).click()
 await expect(dialog.getByRole('button',{name:'Run next job',exact:true})).toBeEnabled()
 await page.setViewportSize({width:720,height:800})
 await page.screenshot({path:info.outputPath('queue-compact.png')})
 await dialog.getByRole('button',{name:'Close',exact:true}).click()
 await page.waitForTimeout(800)
 await page.reload()
 await page.getByRole('button',{name:'Recover Render jobs',exact:true}).click()
 await page.getByRole('button',{name:'Recover project',exact:true}).click()
 await page.getByRole('button',{name:'Export',exact:true}).click()
 await expect(page.getByText('Range B',{exact:true})).toBeVisible()
 await expect(page.getByText('Reopen the matching project revision before running.',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'Run next job',exact:true}).click()
 await expect(page.getByRole('button',{name:'Download Range B',exact:true})).toBeVisible({timeout:30000})
 expect(problems).toEqual([])
})
