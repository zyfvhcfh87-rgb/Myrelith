export const IMAGE_LIMIT = 256 * 1024 * 1024;
export const WARMUP_FRAMES = 30;
export const MEASURED_FRAMES = 120;
export const REPETITIONS = 3;
export const FRAME_PERIOD_MS = 1000 / 30;

export function imagePlan(kind, width, height, phase) {
  if (!['candidate', 'baseline'].includes(kind) || !['preview', 'export', 'qualification'].includes(phase)) {
    throw new Error('Unreviewed image-plan kind or phase');
  }
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 16384)
      || width * height > 16 * 1024 * 1024) throw new Error('Unreviewed dimensions');
  const pixels = width * height;
  const resident = pixels * (kind === 'candidate' ? 28 : 20);
  const setupExtra = kind === 'candidate' ? width * Math.min(16, height) * 16 : pixels * 4;
  const frameExtra = kind === 'candidate'
    ? (phase === 'qualification' ? pixels * 24 : phase === 'export' ? pixels * 4 : 4)
    : (phase === 'export' ? pixels * 4 : 4);
  const uniformBytes = kind === 'candidate' ? 36 : 0;
  const peakBytes = resident + Math.max(setupExtra, frameExtra) + uniformBytes;
  return {kind, width, height, phase, residentBytes: resident, setupExtraBytes: setupExtra,
    frameExtraBytes: frameExtra, uniformBytes, peakBytes, limitBytes: IMAGE_LIMIT, allowed: peakBytes <= IMAGE_LIMIT};
}

export class ImageLedger {
  constructor(notify = () => {}) {
    this.entries = new Map();
    this.liveBytes = 0;
    this.peakBytes = 0;
    this.reservations = 0;
    this.releases = 0;
    this.rejected = [];
    this.notify = notify;
  }
  reserve(id, bytes, kind) {
    if (this.entries.has(id)) throw new Error(`Duplicate live reservation: ${id}`);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid byte reservation');
    if (this.liveBytes + bytes > IMAGE_LIMIT) {
      this.rejected.push({id, bytes, liveBytes: this.liveBytes, limitBytes: IMAGE_LIMIT});
      this.publish();
      throw new Error('Known image-storage ceiling exceeded before allocation');
    }
    this.entries.set(id, {id, bytes, kind});
    this.liveBytes += bytes;
    this.peakBytes = Math.max(this.peakBytes, this.liveBytes);
    this.reservations++;
    this.publish();
  }
  release(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.liveBytes -= entry.bytes;
    this.entries.delete(id);
    this.releases++;
    this.publish();
    return true;
  }
  snapshot() {
    return {liveBytes: this.liveBytes, peakBytes: this.peakBytes, limitBytes: IMAGE_LIMIT,
      reservations: this.reservations, releases: this.releases, live: [...this.entries.values()], rejected: [...this.rejected]};
  }
  publish() { this.notify(this.snapshot()); }
}

export function nearestRank(values, percentile) {
  if (!values.length || values.some(v => !Number.isFinite(v) || v < 0)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
}

export function earlyFailure(phase, width, rows) {
  if (phase === 'preview') {
    if (rows.some(row => row.totalMs > 100)) return 'measured-preview-stall-over-100ms';
    if (rows.filter(row => row.deadlineMissed).length >= 2) return 'two-deadline-misses-disprove-1percent-of-120';
  } else {
    const absoluteLimit = width === 1920 ? 250 : 1000;
    if (rows.filter(row => row.totalMs > absoluteLimit).length >= 7) return 'seven-over-limit-samples-disprove-120-frame-p95';
  }
  return null;
}
