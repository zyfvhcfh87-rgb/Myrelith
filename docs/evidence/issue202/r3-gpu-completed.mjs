// Completion correction only. Run1's owner, shader, inputs and goldens stay immutable.
import {GpuOwner as OriginalGpuOwner} from './r3-gpu.mjs';

export class GpuOwner extends OriginalGpuOwner {
  async init(fixture) {
    const started = performance.now();
    await super.init(fixture);
    const submissionSetupMs = this.setupMs;
    if (this.phase === 'preview') {
      this.completionProbe = this.allocate('gpu.completionProbe', 4, 'rgba8-completion-probe',
        () => new Uint8Array(4), () => {});
    }
    // Both uploads precede this first composition. A returned readback, rather
    // than base init's finish/flush, establishes its completed setup boundary.
    if (this.phase === 'qualification') this.qualify(0);
    else await this.render(0);
    this.setupMs = performance.now() - started;
    this.support.completion = {submissionSetupMs, completedSetupMs: this.setupMs,
      setup: 'first resident composition returned through readPixels',
      preview: 'one charged RGBA8 pixel readPixels from the final output',
      export: 'existing full RGBA8 readPixels', qualification: 'existing Float32 working/view readPixels',
      nativeReclamation: 'unmeasured; release calls and worker/browser teardown are separate'};
  }
  async render(frame) {
    const parts = await super.render(frame);
    if (this.phase !== 'preview') return parts;
    const started = performance.now(), gl = this.gl;
    // super.render leaves the final output framebuffer bound. WebGL typed-array
    // readPixels must finish prior rendering into that framebuffer before return.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.completionProbe);
    this.checkError('preview-completion-readback');
    return {...parts, completionAndReadbackMs: parts.completionAndReadbackMs + performance.now() - started};
  }
  dispose() {
    try { super.dispose(); } finally { this.completionProbe = null; }
  }
}
