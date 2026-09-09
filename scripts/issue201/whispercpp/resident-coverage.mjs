// Proposed runner seam only. The failed ORT runner/evidence stay untouched.
export const RSS_INTERVAL_MS = 100;
export const RSS_MAX_GAP_MS = 250;
export const RSS_DELTA_CAP = 1_073_741_824;

export function createResidentCoverage() {
  let baseline = null, lastAt = null, peak = null, maxGap = 0;
  const failures = new Set(); let samples = 0;
  return {
    observe({ startedAt, at, beforePids, afterPids, rss }) {
      samples++;
      if (!Number.isFinite(startedAt) || !Number.isFinite(at) || at < startedAt) failures.add('invalid-time');
      if (lastAt !== null) {
        const gap = at - lastAt;
        maxGap = Math.max(maxGap, gap);
        if (gap < 0 || gap > RSS_MAX_GAP_MS) failures.add('sample-gap');
      }
      if (at - startedAt > RSS_MAX_GAP_MS) failures.add('capture-gap');
      lastAt = at;
      const validPids = value => Array.isArray(value) && value.length > 0
        && value.every(x => Number.isSafeInteger(x) && x > 0) && new Set(value).size === value.length;
      const sorted = value => value.slice().sort((a, b) => a - b).join(',');
      const complete = validPids(beforePids) && validPids(afterPids) && sorted(beforePids) === sorted(afterPids)
        && Array.isArray(rss) && rss.every(row => Array.isArray(row) && row.length === 2
          && Number.isSafeInteger(row[1]) && row[1] >= 0)
        && validPids(rss.map(row => row[0])) && sorted(rss.map(row => row[0])) === sorted(beforePids);
      if (!complete) { failures.add('incomplete-process-coverage'); return this.snapshot(); }
      const bytes = rss.reduce((sum, row) => sum + row[1], 0);
      if (!Number.isSafeInteger(bytes)) { failures.add('invalid-rss'); return this.snapshot(); }
      baseline ??= bytes; peak = Math.max(peak ?? bytes, bytes);
      if (bytes - baseline > RSS_DELTA_CAP) failures.add('resident-ceiling');
      return this.snapshot();
    },
    checkGap(at) {
      if (lastAt === null || !Number.isFinite(at) || at < lastAt || at - lastAt > RSS_MAX_GAP_MS) failures.add('sample-gap');
      if (lastAt !== null) maxGap = Math.max(maxGap, at - lastAt);
      return this.snapshot();
    },
    snapshot() { return { samples, baseline, peak, maxGap, failures: [...failures], qualified: samples >= 2 && failures.size === 0 }; },
  };
}

// getProcessIds must use Chromium SystemInfo.getProcessInfo; readRssBytes must
// return complete ps rows converted from KiB to bytes. Both inventories bracket
// each RSS read, so churn invalidates coverage rather than dropping a process.
export async function captureCompleteResident({ getProcessIds, readRssBytes, now }) {
  const startedAt = now(), beforePids = await getProcessIds();
  const rss = await readRssBytes(beforePids);
  const afterPids = await getProcessIds();
  return { startedAt, at: now(), beforePids, afterPids, rss };
}
