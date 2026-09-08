// Evidence integrity, not a claim that the candidate's failed gate passed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url)),repository=path.resolve(root,'../../..');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const check=(file,expected)=>assert.equal(sha(file),expected,file);
const freeze=read('oracle-freeze-v1.json'),inventory=read('source-inventory.json');
for(const file of freeze.files)check(path.join(root,file.path),file.sha256);
for(const file of inventory.files)check(path.join(repository,file.path),file.sha256);

for(const run of [1,2]){
  const result=read(`numerical-result-${run}.json`);
  for(const file of result.files){
    const name=run===1&&['candidate.mjs','compare.mjs'].includes(file.path)?`history/${file.path.replace('.mjs','-run-1.mjs')}`:file.path;
    check(path.join(root,name),file.sha256);
  }
  assert.equal(result.summary.scalarPassed,118);
  assert.equal(result.scalar.filter(r=>r.passed).length,118);
  assert.equal(result.summary.storagePassed,68);
  assert.equal(result.storage.filter(r=>r.passed).length,68);
  assert.deepEqual(result.summary.storageFailures,['scopes-pre-view-bin-edges']);
  assert.equal(result.storage.find(r=>r.kind==='discrete-scope').passed,false);
}
assert.deepEqual(read('numerical-result-1.json').summary,read('numerical-result-2.json').summary);

const browser=read('browser-probe-1.json'),transfer=read('transfer-probe-1.json'),metadata=read('metadata-probe-1.json');
for(const [result,source] of [[browser,'probe-browser.mjs'],[transfer,'probe-transfers.mjs'],[metadata,'history/metadata-probe-run-1.mjs']]){
  check(path.join(root,source),result.scriptSha256);
}
assert.equal(browser.rows.length,23);assert.equal(transfer.rows.length,8);assert.equal(metadata.rows.length,8);
assert.equal(browser.owners.framesOpened,browser.owners.framesClosed);
assert.equal(browser.owners.devicesOpened,browser.owners.devicesDestroyed);
for(const row of transfer.rows)assert.equal(row.owners.framesOpened,row.owners.framesClosed);
assert.equal(transfer.rows.filter(r=>r.exactCanvasCopy).length,4);
for(const row of metadata.rows){
  assert.equal(row.error,undefined);check(path.join(root,row.filename),row.sha256);
  assert.equal(fs.statSync(path.join(root,row.filename)).size,row.bytes);
  assert.equal((row.masteringBoxes??row.masteringElements).length,0);
}
assert.deepEqual(metadata.rows.filter(r=>!r.packetUnchanged).map(r=>r.id),['webm-pq2020','webm-hlg2020','webm-missing-transfer']);

for(const name of fs.readdirSync(root).filter(name=>name.endsWith('.mjs'))){
  execFileSync(process.execPath,['--check',path.join(root,name)],{stdio:'pipe'});
}
const allowedImports={
  'oracle.py':new Set(['hashlib','json','decimal','fractions','pathlib','struct','sys']),
  'presentation-oracle.py':new Set(['json','pathlib','sys','oracle']),
};
for(const [name,allowed]of Object.entries(allowedImports)){
  const source=fs.readFileSync(path.join(root,name),'utf8');
  for(const match of source.matchAll(/^(?:from|import)\s+([a-zA-Z0-9_.]+)/gm))assert.ok(allowed.has(match[1]),`${name}: ${match[1]}`);
}
const references=spawnSync('rg',['-l','issue202|evidence/issue202',path.join(repository,'src'),path.join(repository,'package.json')],{encoding:'utf8'});
assert.equal(references.status,1,`Unexpected product reference: ${references.stdout} ${references.stderr}`);
const env={...process.env,DEVELOPER_DIR:'/Library/Developer/CommandLineTools'};
const git=args=>execFileSync('git',args,{cwd:repository,env,encoding:'utf8'}).trim().split('\n').filter(Boolean);
assert.equal(git(['branch','--show-current'])[0],'codex/issue202');
const changed=[...git(['diff','--name-only',inventory.baseCommit]),...git(['ls-files','--others','--exclude-standard'])];
for(const file of changed)assert.ok(file==='docs/ISSUE_202_PLAN.md'||file.startsWith('docs/evidence/issue202/'),`Unowned change: ${file}`);
if(fs.existsSync(path.join(root,'r1-r2-manifest.json'))){
  // This is an immutable historical gate; later protocol amendments must not
  // rewrite its source identities. Verify the exact committed gate snapshot.
  const gate='b9be925423684c6a836c1b3f5306bf49ceceb2b2';
  for(const file of read('r1-r2-manifest.json').files){
    const bytes=execFileSync('git',['show',`${gate}:${file.path}`],{cwd:repository,env,maxBuffer:8*1024*1024});
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),file.sha256,file.path);
  }
}
if(fs.existsSync(path.join(root,'codec-probe-1.json'))){
  const codec=read('codec-probe-1.json');
  assert.equal(codec.startingCommit,'a75cc864b0815d14a93c5e1d7f8d1c90dae2f6a1');
  check(path.join(root,'probe-codec.mjs'),codec.startingScriptSha256);
  assert.equal(codec.scriptSha256,codec.startingScriptSha256);assert.equal(codec.sourceIdentityUnchanged,true);
  assert.equal(codec.rows.length,3);
  for(const row of codec.rows){
    assert.equal(row.outcome,'failed');assert.match(row.error,/unexpected-decoded-size/);
    assert.equal(row.terminalOwnedResources,0);assert.equal(row.ledger.decodedCopyBytes,0);
    for(const packet of row.packets)check(path.join(root,packet.filename),packet.sha256);
  }
  const inspection=read('codec-packet-inspection-1.json');
  check(path.join(root,'inspect-codec-packets.mjs'),inspection.scriptSha256);
  check(path.join(root,'codec-probe-1.json'),inspection.inputResultSha256);
  for(const row of inspection.rows){assert.equal(row.width,1024);assert.equal(row.height,16);assert.equal(row.rawPixelComparisonPerformed,false);}
}
if(fs.existsSync(path.join(root,'codec-run-1-manifest.json'))){
  const gate='ea530ecc9b88d5f36fa44cced849d9056a0166ba';
  for(const file of read('codec-run-1-manifest.json').files){
    const bytes=execFileSync('git',['show',`${gate}:${file.path}`],{cwd:repository,env,maxBuffer:8*1024*1024});
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),file.sha256,file.path);
  }
}
if(fs.existsSync(path.join(root,'codec-readback-1.json'))){
  const result=read('codec-readback-1.json'),previous=read('codec-probe-1.json');
  assert.equal(result.startingCommit,'ea530ecc9b88d5f36fa44cced849d9056a0166ba');
  check(path.join(root,'probe-codec-readback.mjs'),result.startingScriptSha256);
  assert.equal(result.startingScriptSha256,result.scriptSha256);assert.equal(result.sourceIdentityUnchanged,true);
  check(path.join(root,'codec-probe-1.json'),result.inputResultSha256);
  assert.equal(result.rows.length,3);assert.deepEqual(result.consoleErrors,[]);
  for(const row of result.rows){
    assert.equal(row.packetSha256,previous.rows.find(r=>r.id===row.id).packets[0].sha256);
    assert.equal(row.outcome,'completed-diagnostic');assert.equal(row.terminalOwnedResources,0);
    assert.equal(row.ledger.framesOpened,1);assert.equal(row.ledger.framesClosed,1);
    assert.equal(row.ledger.decodersOpened,1);assert.equal(row.ledger.decodersClosed,1);
    assert.equal(row.ledger.decodedCopyBytes,49152);assert.equal(row.ledger.retainedFrames,0);
    const frame=row.decoded[0];assert.equal(row.decoded.length,1);assert.equal(frame.format,'I420P10');
    assert.deepEqual(frame.visibleRect,{x:0,y:0,width:1024,height:16});
    assert.equal(frame.codedWidth,1088);assert.equal(frame.codedHeight,16);
    assert.equal(frame.displayWidth,1024);assert.equal(frame.displayHeight,16);
    assert.deepEqual(frame.tags,row.expected.tags);
    assert.deepEqual(frame.planes[0],{plane:0,width:1024,height:16,samples:16384,unique:896,mismatches:4496,maximumAbsoluteError:1,meanSignedError:-0.2509765625});
    for(const plane of frame.planes.slice(1)){assert.equal(plane.mismatches,0);assert.equal(plane.maximumAbsoluteError,0);assert.equal(plane.unique,1);}
  }
}
if(fs.existsSync(path.join(root,'codec-readback-1-manifest.json'))){
  for(const file of read('codec-readback-1-manifest.json').files)check(path.join(repository,file.path),file.sha256);
}
for(const name of ['r3-reference-freeze-v1.json','r3-harness-manifest.json']){
  if(fs.existsSync(path.join(root,name)))for(const file of read(name).files)check(path.resolve(root,file.path),file.sha256);
}
if(fs.existsSync(path.join(root,'r3-preparation-check-1.json'))){
  const preparation=read('r3-preparation-check-1.json');
  check(path.join(root,'r3-check-preparation.mjs'),preparation.scriptSha256);
  assert.equal(preparation.reference.shaderReferenceCases,40);
  assert.equal(preparation.browserLaunched,false);assert.equal(preparation.shaderExecuted,false);
  assert.equal(preparation.measuredPerformance,false);assert.equal(preparation.nativeLifecycleTested,false);
  assert.equal(preparation.unauthorizedRunnerRejected,true);
  for(const file of preparation.sourceFiles)check(path.resolve(root,file.path),file.sha256);
}
process.stdout.write(JSON.stringify({frozenFiles:freeze.files.length,productionHashes:inventory.files.length,scalarPasses:118,viewPasses:68,
  retainedScopeFailures:1,browserRows:23,transferRows:8,structuralRows:8,
  codecReadbackRows:fs.existsSync(path.join(root,'codec-readback-1.json'))?read('codec-readback-1.json').rows.length:0,
  codecQualityDecision:'not-qualified',r3ReferenceCases:fs.existsSync(path.join(root,'r3-reference-v1.json'))?read('r3-reference-v1.json').rows.length:0,
  r3PreparationOnly:true,productionImports:0,changedPathsWithinOwnership:true})+'\n');
