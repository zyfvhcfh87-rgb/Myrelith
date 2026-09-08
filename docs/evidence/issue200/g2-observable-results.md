# Corrected G2 observable gate: six flows passed

Tested exact `9bddfc5248c8b8af26e7e45150272c2d3306af17`, product unchanged from
`54581222b3c46208efea47f71a0d865f52778bc9`, fingerprint
`sha256:83de7ef8716b855b5c6e0251cc10c41ca2af2254da2363f34f4f204fb88d670f`.
All778 unchanged baseline source blobs and18 diagnostic fixture hashes verified
before and after. Run started2026-09-08T14:14:35Z and completed in19.720s.
One muted headless Chromium151.0.7922.34 worker on macOS arm64, no retries,
maxFailures1, http://127.0.0.1:5200/. No source edit/sync occurred during the run.

**6 passed; 0 failed/skipped/flaky.** The supervisor independently audited every
saved matrix and inspected all three actual title UI screenshots. This records
the focused observable result for review; G3, encoded-file, broad/full-suite and
final integration gates remain outstanding.

| Flow | Rows | Exact pixel comparisons | Result |
| --- | ---: | ---: | --- |
| HTML and production Offscreen baseline/current/Upgrade, worker, raw export | 396 | 2112 | Pass |
| 13 scalar properties, three easings, seeks, nested buses, worker/raw export | 234 | 546 | Pass |
| Actual transferred RenderWorkerBridge replacement/resize/seek/disposal | 18 | 18 | Pass |
| Imported compact animated mask baseline/refusal | 54 | 54 | Pass |
| Explicit generic fallback and portable reopen, main/worker/raw export | 18 | 42 | Pass |
| Actual preview unavailable -> explicit fallback transaction -> reopen | Two viewports | UI assertions | Pass within scoped title/status behavior |

Total2772 pixel comparisons: zero differing bytes and zero maximum delta.
All2754 directly observed line comparisons matched; the18 actual bridge rows
observe presentation pixels only. All recorded context/cleanup/lease/refusal and
retained-intent assertions pass. `nested=false` is a fixture input, not a failed
assertion. Matrices are retained in full; their in-browser raw equality checks
were audited by source and result. Full-gate RGBA buffers are not separately
retained. The earlier diagnostic's1008 lossless samples remain committed in
canvas-diagnostic-17d396f-evidence.tar.gz with their original failed status.

## Console and page qualifications

All six page-error and console-error arrays are empty, including through final
screenshots. **Six browser warnings exist**, all identical Canvas2D performance
advisories in the animation proof's repeated getImageData capture. That proof
performs six13-frame finite exports on destinations whose settings deliberately
match production (willReadFrequently omitted). The other five warning arrays
are empty. These are test-readback advisories, not a zero-warning console result;
no production setting was changed and no rerun hid them. The supervisor accepted
this bounded qualification for the core pixel gate. Separate Node runner
NO_COLOR/FORCE_COLOR notices are also retained in outer stdout/stderr.

All15 recorded screenshot identities have the expected URL/title, nonblank body,
positive bounds and zero Vite overlays. Nine requested PNGs are retained. Six
additional internal Playwright screenshot identities are recorded, while their
passing-trace temporary PNGs were automatically discarded by retain-on-failure.
The algorithm-only mask/fallback end snapshots show the initial plugin-recovery
screen; they do not prove editor readiness. Their actual pixel operations execute
through imported production modules. The separate UI flow reaches the real editor.

The three actual UI screenshots were visually inspected: unavailable title and
its named reason at1280x720; rendered serif fallback and platform notice after
one transaction at1280x720; restored title/notice at720x800. The notice stays
readable at both sizes. Some shared controls are clipped at720px; this evidence
qualifies title/status readability, not whole-workspace responsive usability or
G3 authoring controls. The raw export sink is pre-encoder and proves no encoded
codec/native playback equivalence.

## Native teardown and preservation

Native observer recorded20 process identities and ancestry for launcher,Vite,
Playwright,Chromium/helpers and per-flow renderers. Outer stdout/stderr contains
no observer-thread exception or native ps failure. All exited naturally:
requiredTermination=[], remaining=[]. Fresh complete native ps at
2026-09-08T14:15:38Z found none of the20 recorded PIDs and no Playwright Chromium
processes; lsof confirmed5200 clear. Explicit slot release was sent to supervisor,
who independently checked the clear listener. Fresh source guard still matched.

Original artifact directory:
`/private/tmp/issue200-g2-corrected-9bddfc5-03ba2617`.
Outer log: `/private/tmp/issue200-g2-corrected-9bddfc5-03ba2617.native.log`.
Committed runner: `docs/evidence/issue200/run-g2-browser.py`, with the exact
manifest and a fresh artifact directory supplied through ISSUE200_G2_MANIFEST
and ISSUE200_G2_ARTIFACTS. The full protocol is rendering-protocol.md. Browser
plugin unavailable; regular repository Playwright was used.

## Durable result archive

[g2-9bddfc5-evidence.tar.gz](g2-9bddfc5-evidence.tar.gz) contains all matrices,
observations, nine retained screenshots, logs, input/source guards, native release
evidence, the tested harness/protocol snapshot and the derived result audit.

Archive SHA-256: `073c13d597e9276fb064dc5bc095135d62d2b52a80a5b14a91a12443506f6c69`.
The adjacent .sha256 and archive evidence-files.sha256 pin the complete result.
This result commit changes only evidence and the guard allowlist for these files.
