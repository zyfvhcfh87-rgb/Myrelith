# R3 run 1: retained evidence and completion limitation

The single reviewed run finished; its raw result is immutable. **Candidate
preview completion is unqualified**, despite raw timing labels saying pass.
Chromium's `finish()` is a flush, so those samples do not measure completed
rendering. Full readback timing, tiny correctness and owned-resource release
remain separately useful. No managed product/HDR promotion follows.

## Identity and teardown

Run commit: `d7b900a396c5a5cf004e1ddc7cc9fe5aeaae424f`.
Runner SHA256: `571c9d856573da44a5a99ec361f655bf2a0a60274322bd35cdc10b1bdbfd7e48`.
Raw [r3-run-1.json](r3-run-1.json) SHA256:
`e04b854961c742f90f89546ae712c9743ab36b92097b797a8f37271da9bd2e6f`.
Started 2026-09-08 11:05:34.015 UTC; completed 11:07:14.346 UTC;
controller elapsed 99,968.2 ms. Starting/completion sources match.

Actual browser: Chromium 151.0.7922.34, ANGLE/SwiftShader driver 5.0.0.
Native Apple GPU acceleration and physical HDR remain unqualified. Additional
flag `--mute-audio`; full command-line retrieval was refused because
`--enable-automation` was absent. The flag was not changed. Console contains
only two Vite debug messages; no warning/error/pageerror.

All 32 workers terminated, with zero active and zero owned ledger at every
job acknowledgement. Browser/server close was awaited before process exit;
`lsof -nP -iTCP:5202 -sTCP:LISTEN` returned no listener. The slot was explicitly
released before the audit/correction preparation. No timeout or forced teardown
occurred. Owned API resources are distinct from immediate native reclamation/RSS.

## Saved numerical and timing results

Tiny Float32 shader/RGBA16F readback: **40/40 cases pass**, then another 40/40 on
the fresh owner after context loss. Maximum continuous view error is
0.24179671793365287 on the 10-bit scale; maximum alpha error is
0.00022157300420166948; maximum working RGB error is 0.00044314600840333895.
Fragment highp reports precision 23, range ±127; maximum texture size 8192.
This is the fixed 8×1 representative fixture, not an exhaustive full-size oracle.

All 24 timing runs retain 30 warm-up and 120 measured frames: **2,880 samples**.
Each number below is one repetition's nearest-rank p95 in milliseconds.

| Size / phase | SDR baseline p95, reps 0/1/2 | Candidate p95, reps 0/1/2 | Qualified interpretation |
| --- | --- | --- | --- |
| 1080p preview | 9.6 / 6.0 / 9.6 | 0.3 / 0.4 / 0.3 | Candidate API return only; completed-frame/deadline decision unqualified |
| 4K preview | 21.8 / 22.2 / 21.9 | 0.3 / 0.3 / 0.3 | Same completion limitation; no real-time preview claim |
| 1080p export-stage readback | 7.7 / 7.8 / 7.7 | 8.1 / 8.1 / 8.0 | Bounded resident composition + full SDR readback timing; threshold passes |
| 4K export-stage readback | 27.1 / 28.4 / 29.0 | 31.0 / 32.3 / 32.3 | Same narrow timing evidence; threshold passes |

Export p95 ratios are 1.05195 / 1.03846 / 1.03896 at 1080p and
1.14391 / 1.13732 / 1.11379 at 4K, below the unchanged 4× limit. Candidate
export maxima are 8.7 / 8.9 / 8.8 ms and 31.6 / 33.5 / 34.3 ms respectively.
No encoder, media-file output, decode, per-video-frame upload, physical
presentation or complete managed renderer is timed. Full-size readback bytes
were returned but not independently compared pixel-by-pixel; numerical
correctness is qualified only by the separately recorded tiny fixture.

Setup is outside frame timing. Candidate recorded setup ranges 65.9–70.4 ms
at 1080p and 252.3–258.9 ms at 4K, but its original finish-only boundary does
not establish completed GPU upload. Baseline setup ranges 2.4–2.8 and 8.0–9.2 ms.
The correction must report actual setup completion separately.

No early no-go timing certificates or incomplete pairs occur in run 1.
For any later result, an absolute no-go certificate must remain no-go even if
its paired ratio is unqualified. That reporting rule never changes thresholds.
Here the separate measurement-prerequisite defect disqualifies six candidate
preview completion claims; it does not rewrite their raw values or labels.

## Version-specific source and every affected use

The [pinned Chromium source](https://chromium.googlesource.com/chromium/src/+/782af9cb30a53f54487e5d2e44738645a8ec457c/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc#3539)
at revision `782af9cb30a53f54487e5d2e44738645a8ec457c` implements `finish()` by
calling `Flush()`. The public `151.0.7922.34` tag and installed Chrome for Testing
Info.plist SCMRevision both identify that commit. Source SHA256, Git blob,
tag response, local plist identity and the short function excerpt are retained
in [r3-completion-source-audit.json](r3-completion-source-audit.json).
Run 1 records browser version but lacks runtime CDP revision; the corrected
runner must capture/check that revision before opening an experiment worker.

The [WebGL2 readback contract](https://registry.khronos.org/webgl/specs/latest/2.0/)
requires the typed-array `readPixels` call to complete previous rendering into
its source framebuffer before returning. This supports a separately charged
one-pixel readback correction; a new reviewed slot is required to measure it.

| Harness use | Consequence for run 1 |
| --- | --- |
| Upload setup calls `finish()` before releasing the client tile | Recorded setup does not prove completed GPU upload. Known client/texture reservations remain auditable; opaque queued/native copies were never measured. |
| Candidate preview `render()` uses `finish()` | API-return timing/deadlines only. Raw pass does not establish completed frames or a valid speedup over the readback baseline. |
| Ten start/draw/stop cycles use preview rendering | Ten start/submit/release API lifecycles pass; ten completed GPU draws are unqualified. |
| Context-loss test's initial preview draw | Loss/rejection may interrupt an in-flight draw. Rejection is observed; the fresh owner's 40 readback comparisons remain valid. |
| `dispose()` deletes objects, requests context loss, zeroes canvas dimensions | Evidence of release calls and zero owned ledger, followed by worker/browser teardown. No fence, immediate native reclamation or native-zero claim. |
| Export/cancellation frames use full `readPixels` | Blocking returned-frame readback is distinct from the finish-only preview defect. Five cancellation acknowledgements are 68.9 / 67.7 / 67.9 / 68.2 / 70.3 ms, all within 250 ms and zero owned ledger. |
| Tiny working/view qualification uses Float32 `readPixels` | The recorded 40 + 40 numerical cases remain actual readbacks. |

## Allocation and verification

| Owner / phase | 1080p peak bytes | 4K peak bytes |
| --- | --- | --- |
| Candidate preview, including setup tile | 58,552,356 | 233,226,276 |
| Candidate export-stage readback | 66,355,236 | 265,420,836 |
| SDR baseline, including paint/readback peak | 49,766,400 | 199,065,600 |

All declared peaks fit 268,435,456 bytes. The seven-surface 4K16F direct swap
remains a static no-go at 464,486,400 bytes. Browser/driver duplication,
native memory, process RSS and GC timing are not measured by this ledger.

[verify-r3-run1.mjs](verify-r3-run1.mjs) independently recomputes saved percentile
arithmetic, ratios, reference comparisons, sample counts and cleanup ledgers,
and checks 99 source entries against immutable `d7b900a` Git objects. Its
[qualified analysis](r3-analysis-1.json) preserves raw outcomes and separately
marks preview completion unqualified. The parent independently reports the
same 2,880-row/24-p95/12-ratio/80-case/10-cycle/5-cancel/32-ledger audit. No
numeric, export or browser work was repeated to write this report.

The binary16 scope failure, P3 extended transfer changes, unavailable WebGPU,
native GPU/HDR-display unknowns, incomplete mastering/independent codec evidence
and unchanged legacy SDR contract remain. The next authorized work is narrow
completion correction preparation, tests and review; no retry has been granted.
