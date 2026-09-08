// Tiny follow-up to classify canvas clipping; no codecs are configured or run.
import {chromium} from '@playwright/test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
const output=process.argv[2];
if(!output?.startsWith('/')||fs.existsSync(output))throw new Error('Fresh absolute output path required');
const server=createServer((_req,res)=>res.end('<!doctype html><title>Isolated transfer probe</title>'));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5202,'127.0.0.1',resolve);});
let browser;
try{
  browser=await chromium.launch({headless:true,args:['--mute-audio']});
  const cdp=await browser.newBrowserCDPSession();
  let commandLine,gpu;
  try{commandLine=(await cdp.send('Browser.getBrowserCommandLine')).arguments;}
  catch(error){commandLine={unavailable:String(error),requestedAdditionalFlags:['--mute-audio']};}
  try{
    const system=await cdp.send('SystemInfo.getInfo');
    gpu={devices:system.gpu.devices,featureStatus:system.gpu.featureStatus,
      renderer:system.gpu.auxAttributes?.glRenderer,version:system.gpu.auxAttributes?.glVersion,vendor:system.gpu.auxAttributes?.glVendor};
  }catch(error){gpu={unavailable:String(error)};}
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('http://127.0.0.1:5202');
  const rows=await page.evaluate(async()=>{
    const rows=[];
    for(const colorSpace of ['srgb','display-p3']) for(const sourceMode of ['standard','extended']) for(const destinationMode of ['standard','extended']){
      const id=`${colorSpace}-${sourceMode}-${destinationMode}`;
      const owners={framesOpened:0,framesClosed:0};
      try{
        const canvas=new OffscreenCanvas(2,1),dest=new OffscreenCanvas(2,1);
        const context=c=>({colorSpace,colorType:'float16',toneMapping:{mode:c},willReadFrequently:true});
        const a=canvas.getContext('2d',context(sourceMode)),b=dest.getContext('2d',context(destinationMode));
        const pixels=new Float16Array([-.125,.5,4,1, .5,-.125,2,.5]);
        a.putImageData(new ImageData(pixels,2,1,{colorSpace,pixelFormat:'rgba-float16'}),0,0);
        const before=Array.from(a.getImageData(0,0,2,1,{colorSpace,pixelFormat:'rgba-float16'}).data);
        b.drawImage(canvas,0,0);
        const after=Array.from(b.getImageData(0,0,2,1,{colorSpace,pixelFormat:'rgba-float16'}).data);
        let frame,frameResult;
        try{
          frame=new VideoFrame(canvas,{timestamp:0});owners.framesOpened++;
          frameResult={format:frame.format,colorSpace:frame.colorSpace.toJSON()};
          for(const format of ['native','RGBA']){
            try{
              const options=format==='native'?{}:{format};
              const bytes=new Uint8Array(frame.allocationSize(options));
              const layout=await frame.copyTo(bytes,options);
              frameResult[format]={bytes:bytes.byteLength,layout,sampleBytes:Array.from(bytes.slice(0,16)),qualifiedFloatingInterpretation:false};
            }catch(error){frameResult[format]={error:String(error)};}
          }
        }finally{if(frame){frame.close();owners.framesClosed++;}}
        rows.push({id,sourceAttributes:a.getContextAttributes(),destinationAttributes:b.getContextAttributes(),before,after,
          exactCanvasCopy:before.every((v,i)=>v===after[i]),frameResult,owners});
      }catch(error){rows.push({id,error:String(error),owners});}
    }
    return rows;
  });
  const result={kind:'issue202-tiny-canvas-transfer-diagnostic',collectedAt:new Date().toISOString(),browserVersion:browser.version(),
    scriptSha256:crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),commandLine,gpu,
    qualification:'Headless tiny storage/transfer probe only. No configured codecs, native hardware timing or physical HDR monitor qualification.',rows,consoleErrors:errors};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  process.stdout.write(JSON.stringify({browser:result.browserVersion,renderer:gpu.renderer,rows:rows.length,exactCanvasCopies:rows.filter(r=>r.exactCanvasCopy).length,errors})+'\n');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
