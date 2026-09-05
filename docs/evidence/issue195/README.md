# Issue #195 evidence

Read [the research decision](../../MULTICAM_MONITOR_RESEARCH.md) before treating
any row as product support. User approval is pending.

- `research.json`: final finite-native foreground experiment; 52 timed rows and
  34 fault observations. Normal Playwright hidden/frozen observations are invalid
  lifecycle proof because it forced visible focus. Direct source/cut/cancel/
  proxy faults and the isolated 4K GPU-process crash remain separately recorded.
- `lifecycle-avc-1080.json`: completed native Chromium/default-context probe;
  12 observations and no console errors. It demonstrates pre-freeze cleanup,
  while also exposing admission starting hidden and a GPU-crash observation
  without automatic retirement. Do not report all 12 as passing faults.
- `native-ws-freeze-interruption.json`: earlier native probe. Its genuine
  visible-to-hidden background drain precedes a Vite reload and later failure.
  Retained as partial evidence with that failure intact, not a passing run.
- `finite-cursor-matrix.json`: rejected v2; 64 measured rows. Wrapper closure
  sometimes preceded native decoder closure. Do not count forced termination
  as an observed cooperative native-zero acknowledgement.
- `validation.md`: repository checks, failures and isolated baseline comparison.

Each JSON records source identity and stability, browser/machine facts,
source/proxy provenance, raw-artifact SHA-256 and the projection's omissions.
Later lifecycle runs include per-file source digests, the tracked patch and
research source text. Older foreground runs have an aggregate source digest,
base commit and file list; they are not described as exact final-commit runs.
The scripts do not enter the ordinary production import graph.

The initial forward-cursor smoke remains local only: it lacks an end-of-run
source stability check and the summarizer intentionally refuses to promote it.
No generated media bytes are checked in. Codec configuration metadata and source
hashes are retained. Measurements are not promises of physical memory usage,
low-memory device support, sustained long-session behavior or universal codecs.
