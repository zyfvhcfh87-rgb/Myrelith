# Issue 198 raster segment result

PASS for the single preregistered raster and canonical held-selection segment. Parent acceptance of this result is pending; parent independently confirmed process/port release at 19:39:37.930Z. Production export and native renderer admission remain separate gates.

Tested clean source: `52a64ba78c72e0e3a077c63c8d9b0c3c33e11245`. Product source remains accepted `d9759917d202c39b1faa0df91ea90adad3603218`. One attempt, no retries, no source/protocol changes. Run from 2026-09-08T19:31:04.856Z to 2026-09-08T19:34:34.218Z (209.362 seconds), command/session 6485 exit 0.

## Scope and outcome

- 180 unique cells across 720p, 1080p and 4K, five shapes, three feathers, inversion and on/off-canvas placement.
- Six timed calls per cell: 1,080 actual raster trials. Frames 0/127/255 each compare static and canonical held results over every RGBA byte.
- 540 comparisons, 8,128,512,000 compared bytes: zero mismatches and zero maximum channel delta.
- All 256 canonical selections in every cell were recorded and checked: 46,080 selections. Rectangle/ellipse retain dormant path data; Bezier cells alternate two valid paths with the exact 1/4/8 cubic counts.
- Resolver: 1,000 warmups and 5,000 timed canonical calls. p95 0.10000000894 ms <1 ms; checksum 1,876,852. Raw values are retained.
- All 180 input-buffer releases recorded zero retained bytes. Zero browser console/page/evidence/cleanup failures. Source fingerprint and clean SHA match before and after.

| Output | Cells / calls | Slowest measured raster call |
| --- | ---: | ---: |
| 1280 × 720 | 60 / 360 | 296.8 ms |
| 1920 × 1080 | 60 / 360 | 674.0 ms |
| 3840 × 2160 | 60 / 360 | 2765.5 ms |

The slowest 4K call was the first static sample at frame 0 of the eight-cubic, feather 1, inverted, on-canvas cell: 2,765.5 ms <10,000 ms. The safety ceiling is checked after each call returns; the independent host cell deadline remained 90 seconds. Three samples per variant make p95 the observed maximum, not a stable tail-latency estimate.

## Process memory and qualification

Chromium 151.0.7922.34, Apple M5 Max/arm64, headless software SwiftShader. The page was not cross-origin isolated; minimum positive timer delta was about 0.1 ms. Resolver p50=0 reflects timer quantization, not zero work.

All 210 CDP + Darwin ps-rss samples were measured; none unavailable. Summed sampled process RSS: baseline 288,718,848 bytes (275.34 MiB), sampled peak 617,037,824 (588.45 MiB), final pre-close 474,890,240 (452.89 MiB). Peak is raw record 02251.json.

Process RSS includes browser/renderer/GPU/network owners and is sampled rather than an exact allocation peak. The higher final pre-close RSS does not establish a native leak or leak-free behavior. It is not compared with the separate 256 MiB logical render admission allowance. Native export, renderer-admission combinations, repeated native cleanup behavior and hardware real-time playback remain unqualified.

Actual per-call mask scratch peak: 41,472,000 bytes. The harness separately owns up to 66,355,200 input bytes (two 4K RGBA arrays). These are separate from sampled process RSS and the later full-renderer admission exercise.

## Durable evidence and physical release

Raw directory: `/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue198/.tmp/issue198-52a64ba-raster-attempt1`. All 2,559 numbered JSON files (11,764,177 bytes) matched exact recorded size/SHA-256; no missing/extra records, failures or partial binaries. The original directory is unchanged.
Manifest: 343,701 bytes; SHA-256 `7269effa6878ab748d3e17c6cb0f75ccbf5a0c896b9ca9e6e5dab7ec937eb7fb`.

- run-teardown 02557.json: all four owners closed, no alive PIDs, port false, no problems. evidence-closed 02558.json: no partial binaries.
- Independent worker check 2026-09-08T19:35:25.660665Z: runner 11230, scoped awake 11259 and browser 11260/11261/11262/11264 all absent by kill(pid,0) and ps. Port 5198 refused connection error 61. Session 6485 exited 0.
- Exclusive slot explicitly released to parent. Parent independently rechecked all six PIDs and port 5198 at 19:39:37.930Z; receipt is [parent-cleanup.json](parent-cleanup.json). Result acceptance remains pending.
- Audit JSON: issue198-52a64ba-raster-attempt1-audit.json; cleanup JSON: issue198-52a64ba-raster-attempt1-cleanup.json; original command log: issue198-52a64ba-raster-attempt1.log.
- Reproducible read-only artifact audit: issue198-raster-audit.py. Initial postprocessing hit an older Python fromisoformat limitation on Z timestamps after hash/count/parity checks; UTC parsing was corrected and the artifact audit passed. No native rerun occurred.

## Committed evidence package

[raw-evidence.tar.gz](raw-evidence.tar.gz) contains all 2,559 exact numbered JSON files and the original manifest, with deterministic archive metadata. Every extracted member was checked against [raw-manifest.json](raw-manifest.json). The original run directory remains untouched.

[artifact-index.json](artifact-index.json) records exact package file sizes/hashes, tested SHA, command and scope. [audit.json](audit.json) contains recomputed counts/timings and resource summaries; [artifact-audit.py](artifact-audit.py) preserves the exact read-only checker against the original run directory. [worker-cleanup.json](worker-cleanup.json) and [parent-cleanup.json](parent-cleanup.json) retain both independent release checks. [command.log](command.log) is the exact completed command output.

This commit contains evidence only. Production src/, ARCHITECTURE.md and the entire scripts/issue198 harness remain byte-identical to tested `52a64ba78c72e0e3a077c63c8d9b0c3c33e11245`. No native rerun, export, build or integration sync was performed.
