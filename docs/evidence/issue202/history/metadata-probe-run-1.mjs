// Structural mux tests only. The synthetic header has NO decodable picture data.
// Independent parsers below do not import Mediabunny parser/codec helpers.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat, EncodedVideoPacketSource, EncodedPacket, Input, BufferSource, ALL_FORMATS} from 'mediabunny';
const root=path.dirname(fileURLToPath(import.meta.url));
const outputPath=process.argv[2];
if (!outputPath?.startsWith('/') || fs.existsSync(outputPath)) throw new Error('Use a fresh absolute result path');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');

// VP9 profile 2 key-frame uncompressed prefix: marker, profile bits, flags,
// sync marker, ten-bit selector, BT.2020 color ID, limited range. Padding is
// deliberately not presented as a compressed frame or a usable HDR video file.
function header(colorId=5) {
  const bits='10'+'01'+'0'+'0'+'1'+'1'+(0x498342).toString(2).padStart(24,'0')+'0'+colorId.toString(2).padStart(3,'0')+'0'+'0'.repeat(59);
  return Uint8Array.from(Array.from({length:bits.length/8},(_,i)=>parseInt(bits.slice(i*8,i*8+8),2)));
}
function readPrefix(bytes) {
  let offset=0;
  const bits=count=>{let value=0;for(let i=0;i<count;i++){if(offset>=bytes.length*8)throw new Error('truncated-vp9-prefix');value=value*2+((bytes[offset>>3]>>(7-(offset++&7)))&1);}return value;};
  const marker=bits(2), low=bits(1), high=bits(1), profile=low+2*high;
  if(profile===3)bits(1);
  if(bits(1)!==0||bits(1)!==0)throw new Error('not-key-frame-prefix');
  bits(2);const sync=bits(24),depth=profile>=2?(bits(1)?12:10):8,colorId=bits(3),fullRange=!!bits(1);
  if(marker!==2||sync!==0x498342)throw new Error('invalid-vp9-prefix');
  return {profile,depth,colorId,fullRange};
}

function parseMp4(bytes) {
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),found=[];
  const ascii=(offset,count)=>String.fromCharCode(...bytes.slice(offset,offset+count));
  function walk(start,end,depth=0){
    if(depth>12)throw new Error('mp4-depth');
    for(let offset=start;offset<end;){
      if(end-offset<8)throw new Error('truncated-box');
      const size=data.getUint32(offset),type=ascii(offset+4,4);
      if(size<8||offset+size>end)throw new Error('invalid-box-size');
      const payload=offset+8,finish=offset+size;
      found.push({type,offset,payload,end:finish});
      if(['moov','trak','mdia','minf','stbl'].includes(type))walk(payload,finish,depth+1);
      if(type==='stsd')walk(payload+8,finish,depth+1);
      if(type==='vp09')walk(payload+78,finish,depth+1);
      offset=finish;
    }
  }
  walk(0,bytes.length);
  const colr=found.find(v=>v.type==='colr'),vpc=found.find(v=>v.type==='vpcC');
  const color=colr?{type:ascii(colr.payload,4),primaries:data.getUint16(colr.payload+4),transfer:data.getUint16(colr.payload+6),matrix:data.getUint16(colr.payload+8),fullRange:!!(data.getUint8(colr.payload+10)&128)}:null;
  const configuration=vpc?{profile:bytes[vpc.payload+4],level:bytes[vpc.payload+5],depth:bytes[vpc.payload+6]>>4,chroma:(bytes[vpc.payload+6]>>1)&7,fullRange:!!(bytes[vpc.payload+6]&1),primaries:bytes[vpc.payload+7],transfer:bytes[vpc.payload+8],matrix:bytes[vpc.payload+9]}:null;
  const media=found.find(v=>v.type==='mdat');
  return {color,configuration,masteringBoxes:found.filter(v=>['mdcv','clli','SmDm','CoLL'].includes(v.type)).map(v=>v.type),packet:media?bytes.slice(media.payload,media.end):null};
}

function parseWebm(bytes) {
  const found=[],masters=new Set([0x18538067,0x1654ae6b,0xae,0xe0,0x55b0,0x55d0,0x1f43b675,0xa0]);
  function vint(offset,keepMarker=false){
    let width=1,mask=128;while(width<=8&&!(bytes[offset]&mask)){mask>>=1;width++;}
    if(width>8||offset+width>bytes.length)throw new Error('invalid-ebml-integer');
    let value=BigInt(keepMarker?bytes[offset]:bytes[offset]&(mask-1));
    for(let i=1;i<width;i++)value=value*256n+BigInt(bytes[offset+i]);
    return {width,value,unknown:!keepMarker&&value===(1n<<BigInt(7*width))-1n};
  }
  function walk(start,end,depth=0){
    if(depth>12)throw new Error('ebml-depth');
    for(let offset=start;offset<end;){
      const id=vint(offset,true),size=vint(offset+id.width),payload=offset+id.width+size.width;
      const finish=size.unknown?end:payload+Number(size.value),tag=Number(id.value);
      if(!Number.isSafeInteger(finish)||finish>end||finish<payload)throw new Error('invalid-ebml-size');
      found.push({tag,payload,end:finish});
      if(masters.has(tag))walk(payload,finish,depth+1);
      offset=finish;
    }
  }
  walk(0,bytes.length);
  function uint(tag){const item=found.find(v=>v.tag===tag);if(!item)return null;let value=0;for(let i=item.payload;i<item.end;i++)value=value*256+bytes[i];return value;}
  const block=found.find(v=>[0xa3,0xa1].includes(v.tag));
  const packet=block?bytes.slice(block.payload+vint(block.payload).width+3,block.end):null;
  return {color:{primaries:uint(0x55bb),transfer:uint(0x55ba),matrix:uint(0x55b1),range:uint(0x55b9)},
    masteringElements:found.filter(v=>[0x55bc,0x55bd,0x55d0].includes(v.tag)).map(v=>v.tag),packet};
}

const cells=[
  {id:'sdr709',tags:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false},codes:[1,1,1],headerColor:2},
  {id:'pq2020',tags:{primaries:'bt2020',transfer:'pq',matrix:'bt2020-ncl',fullRange:false},codes:[9,16,9],headerColor:5},
  {id:'hlg2020',tags:{primaries:'bt2020',transfer:'hlg',matrix:'bt2020-ncl',fullRange:false},codes:[9,18,9],headerColor:5},
  {id:'missing-transfer',tags:{primaries:'bt2020',matrix:'bt2020-ncl',fullRange:false},codes:[9,2,9],headerColor:5},
];
const rows=[];
for(const format of ['mp4','webm']) for(const cell of cells){
  const target=new BufferTarget(),source=new EncodedVideoPacketSource('vp9');
  const output=new Output({format:format==='mp4'?new Mp4OutputFormat():new WebMOutputFormat(),target});
  output.addVideoTrack(source);let input;
  const packet=header(cell.headerColor),packetBefore=readPrefix(packet);
  try{
    await output.start();
    const codec=`vp09.02.40.10.01.${cell.codes.map(v=>String(v).padStart(2,'0')).join('.')}.00`;
    await source.add(new EncodedPacket(packet,'key',0,1/30),{decoderConfig:{codec,codedWidth:2,codedHeight:2,colorSpace:cell.tags}});
    await output.finalize();
    const bytes=new Uint8Array(target.buffer),parsed=format==='mp4'?parseMp4(bytes):parseWebm(bytes);
    const packetAfter=parsed.packet?readPrefix(parsed.packet):null;
    input=new Input({formats:ALL_FORMATS,source:new BufferSource(bytes)});
    const track=await input.getPrimaryVideoTrack();
    const reopenedTags=await track.getColorSpace();
    const packetSha256=parsed.packet?digest(parsed.packet):null;
    const filename=`structural-${format}-${cell.id}.container.bin`;
    fs.writeFileSync(path.join(root,filename),bytes);
    delete parsed.packet;
    rows.push({id:`${format}-${cell.id}`,requestedTags:cell.tags,expectedCicp:cell.codes,bytes:bytes.length,filename,sha256:digest(bytes),
      ...parsed,reopenedTags,packetBefore,packetAfter,packetUnchanged:packetSha256===digest(header(cell.headerColor)),packetSha256});
  }catch(error){rows.push({id:`${format}-${cell.id}`,error:String(error)});await output.cancel();}
  finally{input?.dispose();}
}
const evidence={kind:'issue202-structural-metadata-probe',collectedAt:new Date().toISOString(),mediabunny:'1.50.9',
  scriptSha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),qualification:'Synthetic VP9 uncompressed header ONLY; no compressed picture, encoder, decoder, usable HDR video, bitstream round-trip or codec pixel oracle is qualified. Independent container/header parsers inspect mux output.',rows};
fs.writeFileSync(outputPath,JSON.stringify(evidence,null,2)+'\n');
process.stdout.write(JSON.stringify({rows:rows.length,errors:rows.filter(v=>v.error),mutatedPackets:rows.filter(v=>v.packetUnchanged===false).map(v=>v.id)})+'\n');
