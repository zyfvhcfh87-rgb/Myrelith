// Public compositor cost baseline; no application/store/UI entry or alternate renderer.
import {compositeFrame} from '../../../src/pipeline/render.ts';
import {createTimelineDoc, DEFAULT_PROJECT_SETTINGS} from '../../../src/domain/projectSettings.ts';
import {clipFromAssetRange} from '../../../src/domain/operations.ts';
import {resolveBlendMode} from '../../../src/domain/blendModes.ts';
import {imagePlan} from './r3-ledger.mjs';

export class BaselineOwner {
  constructor(ledger, width, height, phase) {
    this.ledger = ledger; this.width = width; this.height = height; this.phase = phase;
    this.plan = imagePlan('baseline', width, height, phase);
    this.allocations = new Map(); this.bitmaps = new Map(); this.closed = false;
  }
  release(id) {
    const entry = this.allocations.get(id);
    if (!entry) return;
    entry.destroy(entry.value); entry.value = null;
    this.allocations.delete(id); this.ledger.release(id);
  }
  surface(id) {
    this.ledger.reserve(id, this.width * this.height * 4, 'rgba8-canvas');
    let canvas;
    try { canvas = new OffscreenCanvas(this.width, this.height); }
    catch (error) { this.ledger.release(id); throw error; }
    this.allocations.set(id, {value: canvas, destroy: value => { value.width = 0; value.height = 0; }});
    // Same context settings as the existing render worker; no readback tuning.
    const ctx = canvas.getContext('2d', {colorSpace: 'srgb'});
    if (!ctx) throw new Error('Baseline Canvas2D unavailable');
    const attrs = ctx.getContextAttributes();
    this.support[id] = attrs;
    if (attrs.colorSpace !== 'srgb' || (attrs.colorType !== undefined && attrs.colorType !== 'unorm8')) {
      throw new Error('Baseline SDR format not confirmed');
    }
    return {canvas, ctx};
  }
  async init(fixture) {
    if (!this.plan.allowed) throw new Error('Baseline image plan rejected before allocation');
    const start = performance.now(); this.support = {};
    this.doc = createTimelineDoc('Issue 202 resident baseline',
      {...DEFAULT_PROJECT_SETTINGS, width: this.width, height: this.height}, 'issue202-baseline');
    this.clips = ['a', 'b'].map(id => ({...clipFromAssetRange({id, fileName: id, kind: 'image'}, 0, 0, 150), id}));
    this.destination = this.surface('baseline.destination');
    this.surfaces = {leg: this.surface('baseline.leg'), group: this.surface('baseline.group')};
    let paint = this.surface('baseline.paint');
    for (const [id, palette] of [['a', fixture.legacyA], ['b', fixture.legacyB]]) {
      const ctx = paint.ctx; ctx.clearRect(0, 0, this.width, this.height);
      for (let y = 0; y < this.height; y += 64) for (let x = 0; x < this.width; x += 64) {
        const [r, g, b, a] = palette[(Math.floor(x / 64) + Math.floor(y / 64)) % 8];
        ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
        ctx.fillRect(x, y, Math.min(64, this.width - x), Math.min(64, this.height - y));
      }
      const key = `baseline.bitmap.${id}`;
      this.ledger.reserve(key, this.width * this.height * 4, 'rgba8-bitmap');
      let bitmap;
      try { bitmap = await createImageBitmap(paint.canvas); }
      catch (error) { this.ledger.release(key); throw error; }
      this.allocations.set(key, {value: bitmap, destroy: value => { value.close(); this.bitmaps.delete(id); }});
      this.bitmaps.set(id, bitmap);
    }
    paint = null; this.release('baseline.paint');
    this.source = {getFrame: async id => this.bitmaps.get(id) ?? null};
    this.provider = {get: () => this.surfaces};
    this.setupMs = performance.now() - start;
  }
  async render(frame) {
    if (this.closed || !Number.isInteger(frame) || frame < 0 || frame > 119) throw new Error('Invalid baseline draw');
    const weight = frame / 119;
    const plan = {frame, items: [{kind: 'crossfade', trackId: this.doc.tracks.find(t => t.kind === 'video').id,
      transitionId: 'research-dissolve', frame, blendMode: resolveBlendMode('normal'),
      requests: this.clips.map((clip, index) => ({role: index === 0 ? 'from' : 'to', clip, sourceFrame: 0,
        opacity: 1, weight: index === 0 ? 1 - weight : weight}))}]};
    const start = performance.now();
    const result = await compositeFrame(this.doc, plan, this.destination.ctx, this.source, this.provider);
    const compositeEnd = performance.now();
    if (result.missing.length || result.drawn.length !== (frame === 0 || frame === 119 ? 1 : 2)) {
      throw new Error(`Incomplete baseline composition: ${JSON.stringify(result)}`);
    }
    const width = this.phase === 'export' ? this.width : 1;
    const height = this.phase === 'export' ? this.height : 1;
    this.ledger.reserve('baseline.readback', width * height * 4, 'rgba8-request-readback');
    let image;
    try {
      image = this.destination.ctx.getImageData(0, 0, width, height);
      if (image.data.byteLength !== width * height * 4 || this.destination.ctx.isContextLost()) {
        throw new Error('Baseline readback/context unavailable');
      }
    } finally { image = null; this.ledger.release('baseline.readback'); }
    return {compositorMs: compositeEnd - start, completionAndReadbackMs: performance.now() - compositeEnd};
  }
  dispose() {
    if (this.closed) return;
    const failures = [];
    for (const id of [...this.allocations.keys()].reverse()) {
      try { this.release(id); } catch (error) { failures.push(String(error)); }
    }
    this.closed = true;
    if (failures.length) throw new Error(`Incomplete baseline cleanup: ${failures.join('; ')}`);
    this.destination = this.surfaces = this.source = this.provider = null;
  }
}
