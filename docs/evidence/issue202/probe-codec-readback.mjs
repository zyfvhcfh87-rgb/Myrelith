// Prepared decode-only follow-up. Requires its own explicit exclusive slot grant.
// Exactly three previously saved 264-byte packets; no new encoding or source media.
import {chromium} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
const root=path.dirname(fileURLToPath(import.meta.url)),output=process.argv[2];
if(!output?.startsWith('/')||fs.existsSync(output))throw new Error('Fresh absolute result path required');
if(process.env.ISSUE202_READBACK_SLOT!=='granted')throw new Error('Dedicated readback slot not asserted');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sourceHash=()=>digest(fs.readFileSync(fileURLToPath(import.meta.url)));
const startingScriptSha256=sourceHash(),startingCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(root,'../../..'),encoding:'utf8'}).trim();
const inputBytes=fs.readFileSync(path.join(root,'codec-probe-1.json')),previous=JSON.parse(inputBytes);
if(previous.rows.length!==3)throw new Error('Expected exactly three prior cells');
const cells=previous.rows.map(row=>{
  if(row.packets.length!==1||row.expected.width!==1024||row.expected.height!==16)throw new Error('Unreviewed cell shape');
  const packet=row.packets[0],bytes=fs.readFileSync(path.join(root,packet.filename));
  if(bytes.length!==264||digest(bytes)!==packet.sha256)throw new Error('Packet identity changed');
  return {id:row.id,expected:row.expected,decoderConfig:row.decoderConfig,packetSha256:packet.sha256,bytes:Array.from(bytes)};
});
const server=createServer((_req,res)=>res.end('<!doctype html><title>Isolated saved packet readback</title>'));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5202,'127.0.0.1',resolve);});
let browser;
try{
  browser=await chromium.launch({headless:true,args:['--mute-audio']});
  const cdp=await browser.newBrowserCDPSession();let gpu,commandLine;
  try{const info=await cdp.send('SystemInfo.getInfo');gpu={devices:info.gpu.devices,featureStatus:info.gpu.featureStatus,renderer:info.gpu.auxAttributes?.glRenderer};}catch(error){gpu={unavailable:String(error)};}
  try{commandLine=(await cdp.send('Browser.getBrowserCommandLine')).arguments;}catch(error){commandLine={unavailable:String(error),requestedAdditionalFlags:['--mute-audio']};}
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('http://127.0.0.1:5202');
  const rows=await page.evaluate(async cells=>{
    const rows=[];let abortRemaining=false;
    const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}-timeout-10s`)),10000);})]);}finally{clearTimeout(timer);}};
    for(const cell of cells){
      if(abortRemaining)break;
      const ledger={framesOpened:0,framesClosed:0,decodersOpened:0,decodersClosed:0,retainedFrames:0,decodedCopyBytes:0};
      const row={id:cell.id,packetSha256:cell.packetSha256,expected:cell.expected,ledger,decoded:[]};
      let decoder,terminal=false,asyncError;const pending=[];
      try{
        row.decoderSupport=await VideoDecoder.isConfigSupported(cell.decoderConfig);
        if(!row.decoderSupport.supported){row.outcome='unsupported-decoder-config';continue;}
        decoder=new VideoDecoder({error:error=>{asyncError=String(error);},output:frame=>{
          ledger.framesOpened++;
          if(terminal||ledger.retainedFrames>=1){frame.close();ledger.framesClosed++;asyncError='late-or-extra-frame';return;}
          ledger.retainedFrames++;
          pending.push((async()=>{
            try{
              const visible=frame.visibleRect;
              const item={format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
                visibleRect:visible?{x:visible.x,y:visible.y,width:visible.width,height:visible.height}:null,
                displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,tags:frame.colorSpace.toJSON()};
              row.decoded.push(item);
              if(frame.format!=='I420P10')throw new Error('unqualified-format');
              if(!visible||visible.width!==1024||visible.height!==16||!Number.isInteger(visible.x)||!Number.isInteger(visible.y)||visible.x<0||visible.y<0||visible.x%2||visible.y%2||visible.x+visible.width>frame.codedWidth||visible.y+visible.height>frame.codedHeight)throw new Error('unqualified-visible-rectangle');
              const options={rect:item.visibleRect},size=frame.allocationSize(options);
              if(size>1024*1024)throw new Error('readback-ceiling');
              const bytes=new Uint8Array(size);ledger.decodedCopyBytes=size;
              const layout=await frame.copyTo(bytes,options);item.layout=layout;
              const view=new DataView(bytes.buffer),planeSizes=[[1024,16],[512,8],[512,8]];
              item.planes=planeSizes.map(([width,height],plane)=>{
                if(!layout[plane]||layout[plane].stride<width*2||layout[plane].offset+(height-1)*layout[plane].stride+width*2>size)throw new Error('invalid-copy-layout');
                let mismatches=0,maximumAbsoluteError=0,totalError=0;const unique=new Set();
                for(let y=0;y<height;y++)for(let x=0;x<width;x++){
                  const value=view.getUint16(layout[plane].offset+y*layout[plane].stride+2*x,true),expected=plane===0?x:512,error=value-expected;
                  if(value>1023)throw new Error('sample-exceeds-ten-bit-range');
                  unique.add(value);if(error!==0)mismatches++;maximumAbsoluteError=Math.max(maximumAbsoluteError,Math.abs(error));totalError+=error;
                }
                return {plane,width,height,samples:width*height,unique:unique.size,mismatches,maximumAbsoluteError,meanSignedError:totalError/(width*height)};
              });
              item.sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
            }catch(error){asyncError=String(error);}finally{frame.close();ledger.framesClosed++;ledger.retainedFrames--;}
          })());
        }});ledger.decodersOpened++;
        decoder.configure(row.decoderSupport.config);
        decoder.decode(new EncodedVideoChunk({type:'key',timestamp:0,duration:33333,data:Uint8Array.from(cell.bytes)}));
        await bounded(decoder.flush(),'decoder-flush');await bounded(Promise.all(pending),'visible-copy');
        if(asyncError)throw new Error(asyncError);
        if(row.decoded.length!==1||!row.decoded[0].planes)throw new Error('expected-one-copied-frame');
        row.outcome='completed-diagnostic';
      }catch(error){row.outcome='failed';row.error=String(error);}
      finally{
        terminal=true;if(decoder){if(decoder.state!=='closed')decoder.close();ledger.decodersClosed++;}
        try{await bounded(Promise.all(pending),'terminal-copy-drain');}catch(error){row.cleanupError=String(error);}
        row.terminalOwnedResources=ledger.framesOpened-ledger.framesClosed+ledger.decodersOpened-ledger.decodersClosed;
        if(row.cleanupError||row.terminalOwnedResources!==0){row.outcome='failed-cleanup';row.browserTeardownRequired=true;row.cleanupError??='terminal-owned-resources-remain';abortRemaining=true;}
        rows.push(row);
      }
    }
    return rows;
  },cells);
  const evidence={kind:'issue202-saved-packet-visible-readback',collectedAt:new Date().toISOString(),browserVersion:browser.version(),
    startingCommit,startingScriptSha256,scriptSha256:sourceHash(),sourceIdentityUnchanged:startingScriptSha256===sourceHash(),inputResultSha256:digest(inputBytes),commandLine,gpu,
    qualification:'Three saved packets, same-browser decode and visible-rectangle copy only. No new encoding, external decoder, lossy quality threshold, mastering metadata, performance, native-memory or physical HDR qualification.',rows,consoleErrors:errors};
  fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify(rows.map(row=>({id:row.id,outcome:row.outcome,error:row.error,terminalOwnedResources:row.terminalOwnedResources})))+'\n');
}finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
