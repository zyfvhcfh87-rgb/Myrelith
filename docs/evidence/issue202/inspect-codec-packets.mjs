// Static inspection of already saved packets; no codec, browser or mux calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const result=JSON.parse(fs.readFileSync(path.join(root,'codec-probe-1.json')));
const rows=result.rows.map(row=>{
  const packet=row.packets[0],bytes=fs.readFileSync(path.join(root,packet.filename));
  if(digest(bytes)!==packet.sha256||bytes.length!==packet.bytes)throw new Error('Packet identity changed');
  let offset=0;
  const bits=count=>{let value=0;for(let i=0;i<count;i++){if(offset>=bytes.length*8)throw new Error('Truncated prefix');value=value*2+((bytes[offset>>3]>>(7-(offset++&7)))&1);}return value;};
  const marker=bits(2),low=bits(1),high=bits(1),profile=low+2*high;
  if(marker!==2||profile!==2||bits(1)!==0||bits(1)!==0)throw new Error('Expected profile2 key prefix');
  bits(2);if(bits(24)!==0x498342)throw new Error('Invalid sync');
  const depth=bits(1)?12:10,colorId=bits(3),fullRange=!!bits(1);
  if(colorId===7)throw new Error('RGB is not valid in profile2');
  const width=bits(16)+1,height=bits(16)+1,renderDifferent=!!bits(1);
  const renderWidth=renderDifferent?bits(16)+1:width,renderHeight=renderDifferent?bits(16)+1:height;
  return {id:row.id,packet:packet.filename,sha256:packet.sha256,profile,depth,colorId,fullRange,width,height,renderWidth,renderHeight,
    recordedVideoFrameCodedWidth:row.decoded[0].width,recordedVideoFrameCodedHeight:row.decoded[0].height,
    recordedVisibleRect:null,rawPixelComparisonPerformed:false};
});
const output=process.argv[2];
if(!output?.startsWith('/')||fs.existsSync(output))throw new Error('Fresh absolute result path required');
const evidence={kind:'issue202-static-vp9-header-inspection',collectedAt:new Date().toISOString(),
  scriptSha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),
  inputResultSha256:digest(fs.readFileSync(path.join(root,'codec-probe-1.json'))),
  qualification:'Limited independent VP9 key-header parse of saved packets, not an independent pixel decoder. VideoFrame visibleRect was not recorded by run1. No rerun.',rows};
fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify(rows.map(({id,width,height,recordedVideoFrameCodedWidth})=>({id,width,height,recordedVideoFrameCodedWidth})))+'\n');
