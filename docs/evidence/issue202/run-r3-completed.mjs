// Prepared only. Environment assertion is not a grant; the orchestrator must grant this exact committed harness first.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(root, '../../..');
const output = process.argv[2];
if (process.env.ISSUE202_R3_COMPLETION_SLOT !== 'granted') throw new Error('Fresh exclusive R3 completion-correction slot required');
if (!output?.startsWith('/') || fs.existsSync(output) || path.dirname(output) !== root) {
  throw new Error('Fresh absolute result path in the owned evidence directory required');
}
const env = {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools'};
const git = args => execFileSync('git', args, {cwd: repository, env, encoding: 'utf8'}).trim();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
if (git(['branch', '--show-current']) !== 'codex/issue202' || git(['status', '--porcelain'])) {
  throw new Error('Reviewed branch and clean committed harness required before launch');
}
const manifests = ['r3-reference-freeze-v1.json', 'r3-harness-manifest.json', 'r3-completed-manifest.json'];
const verified = [];
for (const name of manifests) for (const file of read(name).files) {
  const target = path.resolve(root, file.path);
  if (!target.startsWith(repository + path.sep) || sha(fs.readFileSync(target)) !== file.sha256) {
    throw new Error(`Reviewed source identity changed: ${name} ${file.path}`);
  }
  verified.push({manifest: name, path: file.path, sha256: file.sha256});
}
for (const file of read('source-inventory.json').files) {
  if (sha(fs.readFileSync(path.join(repository, file.path))) !== file.sha256) throw new Error(`Production source changed: ${file.path}`);
}
const startingCommit = git(['rev-parse', 'HEAD']);
const startingScriptSha256 = sha(fs.readFileSync(fileURLToPath(import.meta.url)));
const result = {kind: 'issue202-r3-preview-completion-correction', started: new Date().toISOString(), startingCommit,
  startingScriptSha256, verified, requestedAdditionalFlags: ['--mute-audio'], console: [], progress: [],
  teardown: {browserClosed: false, serverClosed: false}};
let server, browser, timer;
try {
  server = await createServer({configFile: false, root: repository, publicDir: false,
    cacheDir: path.join(repository, '.tmp/issue202-r3-vite'),
    optimizeDeps: {noDiscovery: true, include: []},
    server: {host: '127.0.0.1', port: 5202, strictPort: true, open: false, watch: null}});
  await server.listen();
  browser = await chromium.launch({headless: true, args: result.requestedAdditionalFlags});
  result.browserVersion = browser.version();
  const cdp = await browser.newBrowserCDPSession();
  result.runtimeVersion = await cdp.send('Browser.getVersion');
  const sourceAudit = read('r3-completion-source-audit.json');
  if (result.browserVersion !== sourceAudit.browserVersion
      || result.runtimeVersion.revision.replace(/^@/, '') !== sourceAudit.chromiumRevision) {
    throw new Error('Runtime Chromium revision does not match the reviewed completion source');
  }
  try {
    const info = await cdp.send('SystemInfo.getInfo');
    result.gpu = {devices: info.gpu.devices, featureStatus: info.gpu.featureStatus, renderer: info.gpu.auxAttributes?.glRenderer};
  } catch (error) { result.gpu = {unavailable: String(error)}; }
  try { result.commandLine = (await cdp.send('Browser.getBrowserCommandLine')).arguments; }
  catch (error) { result.commandLine = {unavailable: String(error), requestedAdditionalFlags: result.requestedAdditionalFlags}; }
  const page = await browser.newPage();
  page.on('pageerror', error => result.console.push({type: 'pageerror', text: String(error)}));
  page.on('console', message => {
    if (message.text().startsWith('ISSUE202_R3 ')) {
      const value = JSON.parse(message.text().slice('ISSUE202_R3 '.length));
      result.progress.push(value);
      process.stdout.write(JSON.stringify(value) + '\n');
    } else result.console.push({type: message.type(), text: message.text()});
  });
  await page.goto('http://127.0.0.1:5202/docs/evidence/issue202/r3.html');
  result.experiment = await Promise.race([
    page.evaluate(async () => (await import('./r3-controller-completed.mjs')).runR3()),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Whole browser session exceeded 650s; terminal ownership unknown')), 650000); }),
  ]);
} catch (error) {
  result.error = {message: String(error), stack: error.stack};
  result.outcome = 'unqualified-session-failure';
} finally {
  clearTimeout(timer);
  try { if (browser) { await browser.close(); result.teardown.browserClosed = true; } }
  catch (error) { result.teardown.browserError = String(error); }
  finally {
    try { if (server) { await server.close(); result.teardown.serverClosed = true; } }
    catch (error) { result.teardown.serverError = String(error); }
  }
  result.completed = new Date().toISOString();
  result.completionCommit = git(['rev-parse', 'HEAD']);
  result.scriptSha256 = sha(fs.readFileSync(fileURLToPath(import.meta.url)));
  result.changedSources = verified.filter(file => sha(fs.readFileSync(path.resolve(root, file.path))) !== file.sha256);
  result.sourceIdentityUnchanged = result.completionCommit === startingCommit
    && result.scriptSha256 === startingScriptSha256 && result.changedSources.length === 0;
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
}
process.stdout.write(JSON.stringify({output, sourceIdentityUnchanged: result.sourceIdentityUnchanged,
  numericPassed: result.experiment?.numericPassed, jobs: result.experiment?.jobs.length, teardown: result.teardown}) + '\n');
if (result.error || !result.sourceIdentityUnchanged || !result.teardown.browserClosed || !result.teardown.serverClosed) process.exitCode = 2;
