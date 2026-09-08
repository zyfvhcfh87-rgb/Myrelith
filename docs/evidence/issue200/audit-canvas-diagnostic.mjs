import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
const [root, output] = process.argv.slice(2)
if (!root || !output) throw new Error('Use artifact-directory followed by a fresh output JSON path')
const result = join(root, 'results', readdirSync(join(root, 'results')).find(x => x.startsWith('diagnostic-')))
const samples = join(result, 'samples'), fixtures = JSON.parse(readFileSync(join(result, 'fixtures.json'), 'utf8'))
const report = JSON.parse(readFileSync(join(result, 'diagnostic-comparisons.json'), 'utf8'))
const pins = JSON.parse(readFileSync('docs/evidence/issue200/canvas-diagnostic-fixture-pins.json', 'utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')
const metadata = new Map(), cache = new Map(), tree = createHash('sha256')
let rawBytes = 0, compressedBytes = 0, contextCount = 0, finiteExports = 0
function raw(id) {
  if (cache.has(id)) { const value=cache.get(id); cache.delete(id); cache.set(id,value); return value }
  const value=gunzipSync(readFileSync(join(samples, `${id}.rgba.gz`)))
  cache.set(id,value); if(cache.size>64)cache.delete(cache.keys().next().value)
  return value
}
for (const name of readdirSync(samples).filter(x => x.endsWith('.json')).sort()) {
  const id=name.slice(0,-5), bytes=readFileSync(join(samples,name)), value=JSON.parse(bytes)
  const compressed=readFileSync(join(samples,`${id}.rgba.gz`)), rgba=gunzipSync(compressed)
  if(sha(rgba)!==value.rgbaSha256 || rgba.length!==value.rgbaBytes || rgba.length!==value.pixels.width*value.pixels.height*4)throw Error(`Raw integrity: ${id}`)
  const pin=pins.fixtures.find(x=>id.startsWith(`${x.id}-`))
  if(value.fixtureSha256!==(id.includes('-expanded-')||id.includes('-export-')?pin.expanded:pin.legacy))throw Error(`Fixture pin: ${id}`)
  const p=value.pixels
  if(!p.scratchCleared || p.requests!==0 || p.liveCanvases!==0 || p.peakCanvases>3)throw Error(`Ownership: ${id}`)
  for(const c of p.contexts) {
    const frequently=!(id.includes('-production-')&&c.role==='destination')
    if(c.actual===null || c.actual.colorSpace!=='srgb' || c.actual.willReadFrequently!==frequently)throw Error(`Context attributes: ${id}`)
    contextCount++
  }
  if(value.exportOwnership) {
    const e=value.exportOwnership
    if(e.leases!==1||e.closed!==1||!e.finalized)throw Error(`Export ownership: ${id}`)
    finiteExports++
  }
  rawBytes+=rgba.length; compressedBytes+=compressed.length
  tree.update(`${id}\0${sha(bytes)}\0${sha(compressed)}\0${sha(rgba)}\0`)
  metadata.set(id,value)
}
function compare(a,b) {
  const left=raw(a),right=raw(b)
  if(left.length!==right.length)throw Error(`Dimension mismatch ${a}/${b}`)
  let differingBytes=0,maximumDelta=0
  if(!left.equals(right))for(let i=0;i<left.length;i++){const d=Math.abs(left[i]-right[i]);if(d)differingBytes++;if(d>maximumDelta)maximumDelta=d}
  return {differingBytes,maximumDelta,sameLines:JSON.stringify(metadata.get(a).pixels.lines)===JSON.stringify(metadata.get(b).pixels.lines)}
}
const badReported=[],scopeCounts={}
for(const row of report.comparisons) {
  const fixture=fixtures.find(x=>row.id.startsWith(`${x.id}-`)).id
  const parts=row.id.slice(fixture.length+1).split('-'), [quality,policy]=parts
  const sample=(variant,host,repeat,mode=policy)=>`${fixture}-${quality}-${mode}-${variant}-${host}-${repeat}`
  const exported=(repeat,mode=policy)=>`${fixture}-${quality}-${mode}-export-${repeat}`
  let a,b
  switch(row.scope) {
    case 'repeat': a=sample(parts[2],parts[3],0);b=sample(parts[2],parts[3],1);break
    case 'export-repeat':a=exported(0);b=exported(1);break
    case 'same-host-renderer':a=sample('baseline',parts[2],parts[3]);b=sample('compact',parts[2],parts[3]);break
    case 'same-host-upgrade':a=sample('compact',parts[2],parts[3]);b=sample('expanded',parts[2],parts[3]);break
    case 'same-realm-canvas-kind':a=sample(parts[2],'html',parts[3]);b=sample(parts[2],'offscreen',parts[3]);break
    case 'same-kind-realm':a=sample(parts[2],'offscreen',parts[3]);b=sample(parts[2],'worker',parts[3]);break
    case 'finite-export':a=sample('expanded',parts[4],parts[3]);b=exported(parts[3]);break
    case 'context-policy':a=parts[1]==='export'?exported(0,'proof'):sample(parts[1],parts[2],0,'proof');b=parts[1]==='export'?exported(0,'production'):sample(parts[1],parts[2],0,'production');break
    default:throw Error(row.scope)
  }
  const actual=compare(a,b)
  if(actual.differingBytes!==row.differingBytes||actual.maximumDelta!==row.maximumDelta||actual.sameLines!==row.sameLines)badReported.push({row,actual,a,b})
  const summary=scopeCounts[row.scope]??={total:0,exact:0,different:0,maxDelta:0,lineMismatches:0}
  summary.total++;if(actual.differingBytes===0&&actual.maximumDelta===0&&actual.sameLines)summary.exact++;else summary.different++
  summary.maxDelta=Math.max(summary.maxDelta,actual.maximumDelta);if(!actual.sameLines)summary.lineMismatches++
}
const old=JSON.parse(readFileSync(join(root,'original-run-legacy-pixel-matrix.json'),'utf8'))
const reproductions=[]
for(const fixture of fixtures)for(const quality of ['full','half','quarter']) {
  const clip=fixture.legacy.sequences[0].tracks[0].clips[0]
  const original=old.rows.find(r=>r.family===clip.text.fontFamily&&r.case===clip.name&&r.quality===quality)
  const worker=compare(`${fixture.id}-${quality}-proof-expanded-html-0`,`${fixture.id}-${quality}-proof-expanded-worker-0`)
  const exported=quality==='full'?compare(`${fixture.id}-${quality}-proof-expanded-html-0`,`${fixture.id}-${quality}-proof-export-0`):null
  reproductions.push({id:fixture.id,quality,workerMatchesOriginal:JSON.stringify(worker)===JSON.stringify(original.worker),exportMatchesOriginal:exported===null?null:JSON.stringify(exported)===JSON.stringify(original.export)})
}
const audit={samples:metadata.size,rawBytes,compressedBytes,contextsVerified:contextCount,finiteExportsVerified:finiteExports,comparisonCount:report.comparisons.length,comparisonRecalculationMismatches:badReported,scopeCounts,reproductions,metadataCompressedAndRawTreeSha256:tree.digest('hex')}
if(metadata.size!==1008 || rawBytes!==106272000 || report.comparisons.length!==2160 || badReported.length || contextCount!==3024 || finiteExports!==36) throw new Error('Audit counts or comparison recalculation differ')
writeFileSync(output,JSON.stringify(audit,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({...audit,reproductions:{rows:reproductions.length,workerCountersReproduced:reproductions.filter(x=>x.workerMatchesOriginal).length,exportsCompared:reproductions.filter(x=>x.exportMatchesOriginal!==null).length,exportCountersReproduced:reproductions.filter(x=>x.exportMatchesOriginal).length}},null,2))
