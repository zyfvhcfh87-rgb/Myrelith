# Issue 198 export attempt 1: failed and incomplete

The single approved export segment failed its unchanged decoded-pixel limit at frame 127 of the first completed export. It stopped immediately. No cancellation, retry, later cycle, or parity check at frames 255/299 ran. This is not an export acceptance result.

Tested clean SHA: `8129d4ef0f3fc4df9a204c291f1d52f1ee700c3d`. Relative to reviewed `52a64ba78c72e0e3a077c63c8d9b0c3c33e11245`, only the ten committed raster evidence files differ. Production source, harness, configuration, protocol, actions, assertions and tolerances are identical. The parent explicitly included that evidence-only commit in the grant. No detached checkout or reset occurred.

Run: 2026-09-08T19:44:44.767Z–19:44:55.265Z. Session 51355 exited with code 1. Original source/output MP4s and all raw records were saved before failure; no retry or source change followed.

## Observed outcome

| Check | Observed | Frozen limit / expectation |
| --- | ---: | ---: |
| First completed export | 300 frames, 1280×720, 10 seconds, no audio | Same |
| Frame 0 maximum RGB delta | 12 | ≤12: passed |
| Frame 0 mean RGB delta | 0.20083767361 | ≤2: passed |
| Frame 127 maximum RGB delta | 19 | ≤12: failed |
| Frame 127 mean RGB delta | 0.06854926215 | ≤2: passed |
| RGB channels compared per observed frame | 2,764,800 | Full image |

The lower mean does not override the maximum-error failure. The cause is unresolved; [source-diagnosis.md](source-diagnosis.md) distinguishes confirmed metadata/code facts from hypotheses and proposes a separately reviewed diagnostic.

All 301 actual production progress callbacks cover completed frames 0 through 300 using N/301. The first export finalized; its output is retained. No cancellation was requested and no attempt-complete record was emitted because parity failed.

Before decoded parity, the observed production owner checks passed for this attempt: 300 leases opened/closed, 300 composites/readbacks/encoded frames, one media source opened/closed, one sink finalized, peak live lease 1, and zero live lease/sink/composite/readback/grading bytes or ports. Actual readback peak was 3,686,400 bytes; three observed canvases peaked at 11,059,200 bytes and each reached 1×1 after release. Project/history equality is checked before parity and did not fail. This single observation does not qualify the unexecuted cancellation/retry sequence.

Eleven CDP + Darwin process-RSS samples were measured, none unavailable. Summed sampled RSS: baseline 472,481,792 bytes; peak 1,449,541,632; last observed 1,372,487,680. This includes the application's preview and browser/codec owners; it is not the 256 MiB logical render budget or an exact allocation peak. No native leak result is claimed. Private decoder allocation counters remain unavailable. Headless Chromium 151.0.7922.34 used software SwiftShader.

## Evidence and release

- [raw-evidence.tar.gz](raw-evidence.tar.gz) contains all 329 exact JSON records, both actual MP4s and the original manifest: 332 members. Every extracted member was verified against [raw-manifest.json](raw-manifest.json).
- Raw data: 331 manifest entries, 3,637,094 bytes. The 44,696-byte original manifest has SHA-256 `c0afb06b49ad88b68dcb64076805bee754062f8538d4d4656539026f8e74bace`.
- `source.mp4`: 1,069,647 bytes, SHA-256 `55a7094a0d645e5ec67c7d266890d9c6c8500a125f3454408bdd467ef8ed6264`.
- `export-complete-0.mp4`: 2,103,209 bytes, SHA-256 `f31104bd0a9d26d8ae1285bd15798b625281f8222268c79a34d006481eba0f2c`.
- Original directory remains unchanged: `/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue198/.tmp/issue198-8129d4e-export-attempt1`.
- Raw records 00321/00322 contain frame 0/127 comparisons; 00323 the failed attempt; 00324 actual released owners; 00325 the driver failure; 00327 teardown; 00328 evidence closure. No partial binary remained.
- [worker-cleanup.json](worker-cleanup.json): at 19:45:32.814203Z, runner 18579, awake 18608 and browser 18609/18610/18611/18613 were all absent by kill(pid,0) and ps; port 5198 refused connection with error 61.
- [parent-cleanup.json](parent-cleanup.json): independent parent confirmation at 19:46:16.817715Z of the same six absent PIDs and refused port. The exclusive slot was released.
- [artifact-index.json](artifact-index.json) records package sizes/hashes. [preflight.json](preflight.json) records the exact command and clean source; [audit.json](audit.json) records independently checked raw counts, owner bounds, progress and failure. [command.log](command.log) is the original command output.

No production export rerun, decoding experiment, admission matrix, build, implementation change or tolerance adjustment was made during evidence packaging.
