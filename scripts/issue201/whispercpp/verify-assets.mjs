// Read-only source preparation check. Does not download/extract/install, import
// generated runtime, compile/instantiate WASM, or invoke a model/toolchain.
import { readFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { inspectTinyQ8, MODEL_SHA256 } from './model-format.mjs';
const evidence = new URL('../../../docs/evidence/issue201/whispercpp-preparation/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('assets.json', evidence)));
const root = resolve(process.argv[2] ?? '.tmp/issue201-whispercpp-preparation');
const table = Array.from({ length: 256 }, (_, i) => { let x = i; for (let n = 0; n < 8; n++) x = (x >>> 1) ^ (x & 1 ? 0x82f63b78 : 0); return x >>> 0; });
async function verify(path, expected) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size !== expected.bytes) throw Error(`size/type: ${expected.name}`);
  const h = createHash('sha256'), md5 = createHash('md5'); let crc = 0xffffffff;
  for await (const b of createReadStream(path)) {
    h.update(b); md5.update(b);
    if (expected.publisherChecks?.crc32c) for (const x of b) crc = table[(crc ^ x) & 255] ^ (crc >>> 8);
  }
  if (h.digest('hex') !== expected.sha256) throw Error(`digest: ${expected.name}`);
  const bytes = Buffer.alloc(4); bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  if (expected.publisherChecks?.crc32c && bytes.toString('base64') !== expected.publisherChecks.crc32c) throw Error('crc32c');
  if (expected.publisherChecks?.md5 && md5.digest('base64') !== expected.publisherChecks.md5) throw Error('md5');
}
for (const entry of manifest.archives) {
  if (!/^[a-zA-Z0-9._-]+$/.test(entry.name)) throw Error('archive path');
  await verify(join(root, entry.name), entry);
}
for (const entry of manifest.sourceRecords) await verify(new URL(entry.name, evidence), entry);
const tags = JSON.parse(await readFile(new URL('emscripten-releases-tags.json', evidence)));
if (tags.releases['6.0.8'] !== manifest.toolchain.buildRevision) throw Error('SDK tag');
const modelMetadata = JSON.parse(await readFile(new URL('model-publisher-metadata.json', evidence)));
const publishedModel = modelMetadata.siblings.find(x => x.rfilename === 'ggml-tiny-q8_0.bin');
if (modelMetadata.sha !== manifest.model.revision || publishedModel.lfs.sha256 !== MODEL_SHA256
  || publishedModel.size !== manifest.archives[0].bytes) throw Error('publisher model identity');
for (const [metadata, archiveName, publishedName] of [
  ['cmake-release.json','cmake-4.4.3-macos-universal.tar.gz','cmake-4.4.3-macos-universal.tar.gz'],
  ['ninja-release.json','ninja-1.13.2-mac.zip','ninja-mac.zip']]) {
  const release = JSON.parse(await readFile(new URL(metadata, evidence)));
  const published = release.assets.find(x => x.name === publishedName), local = manifest.archives.find(x => x.name === archiveName);
  if (published.digest !== `sha256:${local.sha256}` || published.size !== local.bytes) throw Error('publisher tool identity');
}
const sums = await readFile(new URL('node-SHASUMS256.txt', evidence), 'utf8');
const node = manifest.archives.find(x => x.name === 'node-v24.19.0-darwin-arm64.tar.gz');
if (!sums.split('\n').includes(`${node.sha256}  ${node.name}`)) throw Error('Node publisher hash');
const format = inspectTinyQ8(await readFile(join(root, 'ggml-tiny-q8_0.bin')));
console.log(JSON.stringify({ status: 'verified-source-assets-only', archives: manifest.archives.length,
  evidenceFiles: manifest.sourceRecords.length, modelBytes: format.bytes, tensorCount: format.tensorCount,
  toolchainExecuted: false, wasmInstantiated: false, inferenceExecuted: false }, null, 2));
