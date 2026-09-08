// Prepared R2 codec experiment. Run only after the orchestrator grants its slot.
// Three synthetic frames total; no product imports, user media, sound or timing claims.
import {chromium} from '@playwright/test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
const root=path.dirname(fileURLToPath(import.meta.url));
const output=process.argv[2];
if(!output?.startsWith('/')||fs.existsSync(output))throw new Error('Fresh absolute output path required');
if(process.env.ISSUE202_CODEC_SLOT!=='granted')throw new Error('Exclusive codec slot not asserted');
const server=createServer((_req,res)=>res.end('<!doctype html><title>Isolated codec research</title>'));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5202,'127.0.0.1',resolve);});
let browser;
try{
  browser=await chromium.launch({headless:true,args:['--mute-audio']});
  const cdp=await browser.newBrowserCDPSession();
  let gpu,commandLine;
  try{const info=await cdp.send('SystemInfo.getInfo');gpu={devices:info.gpu.devices,featureStatus:info.gpu.featureStatus,renderer:info.gpu.auxAttributes?.glRenderer};}
  catch(error){gpu={unavailable:String(error)};}
  try{commandLine=(await cdp.send('Browser.getBrowserCommandLine')).arguments;}
  catch(error){commandLine={unavailable:String(error),requestedAdditionalFlags:['--mute-audio']};}
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('http://127.0.0.1:5202');
  const rows=await page.evaluate(async()=>{
    const rows=[],width=1024,height=16,lumaSamples=width*height,chromaSamples=lumaSamples/4;
    const cells=[
      {id:'sdr709',codes:'01.01.01',tags:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:true}},
      {id:'pq2020',codes:'09.16.09',tags:{primaries:'bt2020',transfer:'pq',matrix:'bt2020-ncl',fullRange:true}},
      {id:'hlg2020',codes:'09.18.09',tags:{primaries:'bt2020',transfer:'hlg',matrix:'bt2020-ncl',fullRange:true}},
    ];
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
    const bounded=async(promise,label)=>{
      let timer;
      try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}-timeout-10s`)),10000);})]);}
      finally{clearTimeout(timer);}
    };
    // Independent limited VP9 uncompressed-prefix reader, not a full bitstream validator.
    function prefix(bytes){
      let offset=0;
      const bits=count=>{let value=0;for(let i=0;i<count;i++){if(offset>=bytes.length*8)throw new Error('truncated-vp9-prefix');value=value*2+((bytes[offset>>3]>>(7-(offset++&7)))&1);}return value;};
      const marker=bits(2),lo=bits(1),hi=bits(1),profile=lo+2*hi;
      if(profile===3)bits(1);
      if(bits(1)!==0||bits(1)!==0)throw new Error('not-key-frame-prefix');
      bits(2);const sync=bits(24),depth=profile>=2?(bits(1)?12:10):8,colorId=bits(3),fullRange=!!bits(1);
      if(marker!==2||sync!==0x498342)throw new Error('invalid-vp9-prefix');
      return {profile,depth,colorId,fullRange};
    }
    for(const cell of cells){
      const ledger={framesOpened:0,framesClosed:0,encodersOpened:0,encodersClosed:0,decodersOpened:0,decodersClosed:0,
        sourcePlaneBytes:0,encodedPayloadBytes:0,decodedCopyBytes:0,retainedReadbackFrames:0,peakRetainedReadbackFrames:0};
      const row={id:cell.id,expected:{width,height,format:'I420P10',luma:'code(x,y)=x',chroma:512,uniqueLuma:1024,tags:cell.tags},ledger};
      let encoder,decoder,input,decoderConfig,asyncError,terminal=false;
      const chunks=[],pending=[];
      try{
        const codec=`vp09.02.40.10.01.${cell.codes}.01`;
        const config={codec,width,height,framerate:30,bitrate:8000000,hardwareAcceleration:'prefer-software',latencyMode:'quality'};
        const support=await VideoEncoder.isConfigSupported(config);
        row.encoderConfig={requested:config,returned:support.config,supported:support.supported};
        if(!support.supported){row.outcome='unsupported-encoder-config';continue;}
        encoder=new VideoEncoder({error:error=>{asyncError=String(error);},output:(chunk,metadata)=>{
          if(terminal)return;
          if(chunks.length>=2||ledger.encodedPayloadBytes+chunk.byteLength>4*1024*1024){asyncError='encoded-payload-ceiling';return;}
          const bytes=new Uint8Array(chunk.byteLength);chunk.copyTo(bytes);
          chunks.push({bytes,type:chunk.type,timestamp:chunk.timestamp,duration:chunk.duration});
          ledger.encodedPayloadBytes+=bytes.byteLength;
          if(metadata?.decoderConfig)decoderConfig=metadata.decoderConfig;
        }});ledger.encodersOpened++;
        encoder.configure(support.config);
        const planes=new Uint16Array(lumaSamples+2*chromaSamples);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)planes[y*width+x]=x;
        planes.fill(512,lumaSamples);ledger.sourcePlaneBytes=planes.byteLength;
        row.sourceSha256=await hash(planes);
        input=new VideoFrame(planes,{format:'I420P10',codedWidth:width,codedHeight:height,timestamp:0,duration:33333,colorSpace:cell.tags});
        ledger.framesOpened++;
        encoder.encode(input,{keyFrame:true});input.close();ledger.framesClosed++;input=null;
        await bounded(encoder.flush(),'encoder-flush');
        if(asyncError)throw new Error(asyncError);
        row.decoderConfig=decoderConfig;
        row.packets=[];
        for(const chunk of chunks)row.packets.push({bytes:chunk.bytes.byteLength,sha256:await hash(chunk.bytes),type:chunk.type,header:prefix(chunk.bytes),data:Array.from(chunk.bytes)});
        if(!decoderConfig||chunks.length!==1)throw new Error('expected-one-packet-and-decoder-config');
        row.decoderSupport=await VideoDecoder.isConfigSupported(decoderConfig);
        if(!row.decoderSupport.supported){row.outcome='unsupported-decoder-config';continue;}
        row.decoded=[];
        decoder=new VideoDecoder({error:error=>{asyncError=String(error);},output:frame=>{
          ledger.framesOpened++;
          if(terminal||ledger.retainedReadbackFrames>=1){frame.close();ledger.framesClosed++;asyncError='late-or-extra-decoded-frame';return;}
          ledger.retainedReadbackFrames++;ledger.peakRetainedReadbackFrames=Math.max(ledger.peakRetainedReadbackFrames,ledger.retainedReadbackFrames);
          pending.push((async()=>{
            try{
              const item={format:frame.format,width:frame.codedWidth,height:frame.codedHeight,tags:frame.colorSpace.toJSON()};
              row.decoded.push(item);
              if(!['I420P10','I422P10','I444P10'].includes(frame.format)){item.outcome='unqualified-sample-format';return;}
              if(frame.codedWidth!==width||frame.codedHeight!==height)throw new Error('unexpected-decoded-size');
              const allocationBytes=frame.allocationSize();
              if(allocationBytes>1024*1024)throw new Error('readback-ceiling');
              const bytes=new Uint8Array(allocationBytes);
              ledger.decodedCopyBytes=Math.max(ledger.decodedCopyBytes,bytes.byteLength);
              const layout=await frame.copyTo(bytes);item.layout=layout;item.sha256=await hash(bytes);
              const view=new DataView(bytes.buffer),unique=new Set();let mismatch=0,maximumAbsoluteError=0,totalError=0;
              for(let y=0;y<height;y++)for(let x=0;x<width;x++){
                const value=view.getUint16(layout[0].offset+y*layout[0].stride+x*2,true),error=value-x;
                unique.add(value);if(error!==0)mismatch++;maximumAbsoluteError=Math.max(maximumAbsoluteError,Math.abs(error));totalError+=error;
              }
              item.luma={samples:lumaSamples,mismatches:mismatch,unique:unique.size,maximumAbsoluteError,meanSignedError:totalError/lumaSamples};
              item.outcome='raw-luma-measured';
            }catch(error){asyncError=String(error);}
            finally{frame.close();ledger.framesClosed++;ledger.retainedReadbackFrames--;}
          })());
        }});ledger.decodersOpened++;
        decoder.configure(row.decoderSupport.config);
        for(const chunk of chunks)decoder.decode(new EncodedVideoChunk({type:chunk.type,timestamp:chunk.timestamp,duration:chunk.duration??undefined,data:chunk.bytes}));
        await bounded(decoder.flush(),'decoder-flush');
        await bounded(Promise.all(pending),'decoded-copy');
        if(asyncError)throw new Error(asyncError);
        row.outcome='completed-diagnostic';
      }catch(error){row.outcome='failed';row.error=String(error);}
      finally{
        terminal=true;
        if(input){input.close();ledger.framesClosed++;}
        if(encoder){if(encoder.state!=='closed')encoder.close();ledger.encodersClosed++;}
        if(decoder){if(decoder.state!=='closed')decoder.close();ledger.decodersClosed++;}
        try{await bounded(Promise.all(pending),'terminal-copy-drain');}catch(error){row.cleanupError=String(error);}
        row.terminalOwnedResources=ledger.framesOpened-ledger.framesClosed+ledger.encodersOpened-ledger.encodersClosed+ledger.decodersOpened-ledger.decodersClosed;
        rows.push(row);
      }
    }
    return rows;
  });
  for(const row of rows)for(const [index,packet]of(row.packets??[]).entries()){
    const filename=path.basename(output,'.json')+`-${row.id}-${index}.vp9-packet.bin`;
    const destination=path.join(root,filename);
    if(fs.existsSync(destination))throw new Error('Refusing to overwrite packet evidence');
    fs.writeFileSync(destination,Uint8Array.from(packet.data));delete packet.data;packet.filename=filename;
  }
  const evidence={kind:'issue202-three-frame-codec-diagnostic',collectedAt:new Date().toISOString(),browserVersion:browser.version(),
    scriptSha256:crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),commandLine,gpu,
    qualification:'Three synthetic 1024x16 frames only. Same-browser decode against an exact independently stated ramp. Prefix reader is not a full codec validator. No independent decoder, complete metadata, lossy quality threshold, performance, native-memory or physical HDR qualification.',rows,consoleErrors:errors};
  fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
  process.stdout.write(JSON.stringify({rows:rows.map(r=>({id:r.id,outcome:r.outcome,error:r.error,terminalOwnedResources:r.terminalOwnedResources})),errors})+'\n');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
