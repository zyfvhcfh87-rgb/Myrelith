// Bounded API/configuration probe: no codec configure/decode/encode or timings.
import {chromium} from '@playwright/test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';

const outputPath = process.argv[2];
if (!outputPath?.startsWith('/') || fs.existsSync(outputPath)) throw new Error('Pass a fresh absolute result path');
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Issue 202 isolated capability probe</title>');
});
await new Promise((resolve, reject) => {server.once('error', reject); server.listen(5202, '127.0.0.1', resolve);});
let browser;
const consoleErrors = [];
try {
  browser = await chromium.launch({headless: true, args: ['--mute-audio']});
  const page = await browser.newPage();
  page.on('pageerror', e => consoleErrors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await page.goto('http://127.0.0.1:5202');
  const result = await page.evaluate(async () => {
    const rows = [], owners = {framesOpened: 0, framesClosed: 0, devicesOpened: 0, devicesDestroyed: 0};
    const probe = async (id, run) => { try {rows.push({id, status: 'returned', ...(await run())});} catch (e) {rows.push({id, status: 'rejected', error: String(e)});} };
    const withFrame = async (input, init, run) => {
      let frame;
      try {frame = new VideoFrame(input, init); owners.framesOpened++; return await run(frame);}
      finally {if (frame) {frame.close(); owners.framesClosed++;}}
    };
    for (const format of ['I420P10', 'I444P10']) {
      await probe('raw-'+format, async () => {
        const width = format === 'I444P10' ? 1024 : 2, height = 2;
        const count = width*height, chroma = format === 'I444P10' ? count : 1;
        const data = new Uint16Array(count+2*chroma);
        for (let i=0; i<count; i++) data[i] = format === 'I444P10' ? i%1024 : [0, 1, 512, 1023][i];
        data.fill(512, count);
        return withFrame(data, {format, codedWidth: width, codedHeight: height, timestamp: 0,
          colorSpace: {primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: true}}, async frame => {
          const output = new Uint8Array(frame.allocationSize()), layout = await frame.copyTo(output);
          const view = new DataView(output.buffer), values = [];
          for (let y=0; y<height; y++) for (let x=0; x<width; x++) values.push(view.getUint16(layout[0].offset+y*layout[0].stride+x*2, true));
          let mismatches = 0;
          for (let i=0; i<count; i++) if (values[i] !== data[i]) mismatches++;
          let chromaMismatches = 0;
          const chromaWidth = format === 'I444P10' ? width : 1;
          const chromaHeight = format === 'I444P10' ? height : 1;
          for (let plane=1; plane<3; plane++) for (let y=0; y<chromaHeight; y++) for (let x=0; x<chromaWidth; x++) {
            if (view.getUint16(layout[plane].offset+y*layout[plane].stride+x*2, true) !== 512) chromaMismatches++;
          }
          return {requestedFormat: format, actualFormat: frame.format, colorSpace: frame.colorSpace.toJSON(), allocationBytes: output.byteLength, layout,
            lumaMismatches: mismatches, chromaMismatches, uniqueLumaValues: new Set(values).size, exactRawCopy: mismatches === 0 && chromaMismatches === 0 && frame.format === format};
        });
      });
    }
    for (const colorSpace of ['srgb', 'display-p3']) {
      await probe('canvas-float16-'+colorSpace, async () => {
        const canvas = new OffscreenCanvas(1024, 1);
        const ctx = canvas.getContext('2d', {colorType: 'float16', colorSpace, willReadFrequently: true});
        if (!ctx) throw new Error('no-context');
        const data = new Float16Array(4096);
        for (let i=0; i<1024; i++) data.set([i/1023, -.125, 4, 1], 4*i);
        ctx.putImageData(new ImageData(data, 1024, 1, {colorSpace, pixelFormat: 'rgba-float16'}), 0, 0);
        const read = ctx.getImageData(0, 0, 1024, 1, {colorSpace, pixelFormat: 'rgba-float16'});
        const copy = new OffscreenCanvas(1024, 1), second = copy.getContext('2d', {colorType: 'float16', colorSpace, willReadFrequently: true});
        second.drawImage(canvas, 0, 0);
        const afterDraw = second.getImageData(0, 0, 1024, 1, {colorSpace, pixelFormat: 'rgba-float16'});
        const reds = Array.from({length: 1024}, (_, i) => read.data[i*4]);
        const frameHop = await withFrame(canvas, {timestamp: 0}, async frame => ({format: frame.format, colorSpace: frame.colorSpace.toJSON(), allocationBytes: frame.allocationSize()})).catch(error => ({error: String(error)}));
        return {requested: {colorSpace, colorType: 'float16'}, attributes: ctx.getContextAttributes(), readArray: read.data.constructor.name,
          uniqueRedValues: new Set(reds).size, sample: Array.from(read.data.slice(0, 8)), drawSample: Array.from(afterDraw.data.slice(0, 8)), frameHop};
      });
    }
    await probe('canvas-unorm8-negative-control', async () => {
      const ctx = new OffscreenCanvas(1024, 1).getContext('2d', {colorSpace: 'srgb', willReadFrequently: true});
      for (let x=0; x<1024; x++) {ctx.fillStyle = `rgb(${x/1023*255},${x/1023*255},${x/1023*255})`; ctx.fillRect(x, 0, 1, 1);}
      const data = ctx.getImageData(0, 0, 1024, 1).data;
      return {attributes: ctx.getContextAttributes(), uniqueRedValues: new Set(Array.from({length:1024}, (_, i) => data[i*4])).size};
    });
    await probe('webgl2-rgba16f-readback', async () => {
      const canvas = new OffscreenCanvas(2, 2), gl = canvas.getContext('webgl2');
      if (!gl) throw new Error('no-webgl2');
      const textures = [], buffers = [], shaders = [], programs = [];
      try {
        if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no-float-color-buffer');
        const texture = gl.createTexture(); textures.push(texture); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 2, 2, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fbo = gl.createFramebuffer(); buffers.push(fbo); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) throw new Error('incomplete-float-framebuffer');
        const makeShader = (type, source) => {const s=gl.createShader(type); shaders.push(s); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s;};
        const vert=makeShader(gl.VERTEX_SHADER, '#version 300 es\nvoid main(){gl_Position=vec4(gl_VertexID==1?3.0:-1.0,gl_VertexID==2?3.0:-1.0,0.,1.);}');
        const frag=makeShader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;out vec4 c;void main(){c=vec4(-.125,.5,4.,1.);}');
        const program=gl.createProgram(); programs.push(program); gl.attachShader(program,vert); gl.attachShader(program,frag); gl.linkProgram(program);
        if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program); gl.viewport(0,0,2,2); gl.drawArrays(gl.TRIANGLES,0,3);
        const pixels=new Float32Array(16); gl.readPixels(0,0,2,2,gl.RGBA,gl.FLOAT,pixels);
        const error=gl.getError();
        return {framebufferStatus, error, pixels: Array.from(pixels), renderTargetBytes:32, readbackBytes:64,
          floatBlendExtension: !!gl.getExtension('EXT_float_blend'), exactKnownPixel: error===gl.NO_ERROR && pixels.every((v,i)=>v===[-.125,.5,4,1][i%4])};
      } finally {for(const p of programs) gl.deleteProgram(p); for(const s of shaders) gl.deleteShader(s); for(const b of buffers) gl.deleteFramebuffer(b); for(const t of textures) gl.deleteTexture(t); gl.getExtension('WEBGL_lose_context')?.loseContext();}
    });
    await probe('webgpu-extended-config', async () => {
      if (!navigator.gpu) throw new Error('no-webgpu');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('no-adapter');
      const device = await adapter.requestDevice(); owners.devicesOpened++;
      let ctx;
      try {
        const canvas=new OffscreenCanvas(1,1); ctx=canvas.getContext('webgpu');
        device.pushErrorScope('validation');
        ctx.configure({device,format:'rgba16float',colorSpace:'display-p3',toneMapping:{mode:'extended'},alphaMode:'premultiplied'});
        const error=await device.popErrorScope();
        return {adapterInfo: adapter.info ? {vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description} : null,
          configured:error===null,error:error?.message??null,physicalMonitorQualified:false};
      } finally {ctx?.unconfigure();device.destroy();owners.devicesDestroyed++;}
    });
    for (const codec of ['avc1.6e0028','hvc1.2.4.L120.B0','vp09.02.40.10.01.09.16.09.00','av01.0.08M.10']) {
      for (const hardwareAcceleration of ['no-preference','prefer-hardware','prefer-software']) {
        await probe(`encoder-config-${codec}-${hardwareAcceleration}`, async () => {
          const requested={codec,width:1920,height:1080,framerate:30,bitrate:8000000,hardwareAcceleration};
          const result=await VideoEncoder.isConfigSupported(requested);
          return {requested,supported:result.supported,returnedConfig:result.config,encodedFrames:0};
        });
      }
      await probe(`decoder-config-${codec}`, async () => {
        const requested={codec,codedWidth:1920,codedHeight:1080};
        const result=await VideoDecoder.isConfigSupported(requested);
        return {requested,supported:result.supported,returnedConfig:result.config,decodedFrames:0};
      });
    }
    return {userAgent:navigator.userAgent,mediaQueries:{dynamicRangeHigh:matchMedia('(dynamic-range: high)').matches,colorGamutP3:matchMedia('(color-gamut: p3)').matches},rows,owners};
  });
  const evidence={kind:'issue202-bounded-api-probe',collectedAt:new Date().toISOString(),browserVersion:browser.version(),headless:true,flags:['--mute-audio'],
    scriptSha256:crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    hostEvidence:'orchestrator-supplied Mac17,6 / Apple M5 Max / 64 GiB; macOS 26.6.2',
    qualification:'Tiny raw-frame/canvas readback and configuration probes only. No encode/decode, timings, resident/native/GPU memory measurement or physical monitor qualification.',
    ...result,consoleErrors};
  fs.writeFileSync(outputPath,JSON.stringify(evidence,null,2)+'\n');
  process.stdout.write(JSON.stringify({browser:evidence.browserVersion,rows:result.rows.length,rejected:result.rows.filter(r=>r.status==='rejected').map(r=>r.id),owners:result.owners,consoleErrors})+'\n');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
