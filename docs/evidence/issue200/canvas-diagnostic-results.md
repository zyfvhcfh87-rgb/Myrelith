# Completed bounded canvas diagnostic

Exact source17d396fcecb374635d57b4d4b39811c2e869722e; unchanged product5458122.
Started2026-09-08T13:52:42Z; runner duration8.996s. Chromium151.0.7922.34,
macOS arm64, one muted headless worker, http://127.0.0.1:5200/, 1280x720.
All1008 preregistered samples and2160 comparisons completed. The final exact-zero
assertion failed. No early renderer/Upgrade/repeat/integrity/ownership stop and
no rerun or correction. Extra reporter error is solely its maxFailures1 stop.

| Comparison | Exact / total | Different | Maximum byte delta |
| --- | ---: | ---: | ---: |
| Same-host baseline/current | 324 / 324 | 0 | 0 |
| Same-host compact/Upgrade | 324 / 324 | 0 | 0 |
| Main/worker Offscreen | 324 / 324 | 0 | 0 |
| Planned render repeats | 486 / 486 | 0 | 0 |
| Planned export repeats | 18 / 18 | 0 | 0 |
| Same-main-realm HTML/Offscreen | 150 / 324 | 174 | 129 |
| Finite export vs all three hosts | 100 / 108 | 8 | 129 |
| Proof/production context policy | 224 / 252 | 28 | 4 |

All2160 line comparisons matched. All72 full-size Offscreen main/worker vs finite
export comparisons were exact. The8 export mismatches use HTML references for
sans-serif/crop-flip and fantasy/fractional, two policies and two planned samples.
All28 context-policy differences belong to monospace/caption-canary, including
unchanged baseline, current compact, expanded and finite export. Actual attributes
were available for every context: sRGB, expected willReadFrequently true/false.

Independent offline audit gunzipped and SHA-verified all1008 sample buffers,
checked dimensions and fixture hashes, and recalculated every2160 comparison.
No recorded comparison differed from raw recalculation. Uncompressed106272000
bytes, gzip3717626 bytes. All3024 context records and36 finite export ownership
records verified. Logical sorted metadata/compressed/raw hash:
c76e4f7d42149157a036a87078f275ea97afe3cc46cc2301c49a8fbf51fa514d.
All27 selected original worker counters and all9 selected export counters
reproduced exactly under the original proof settings.

Bounded conclusion: on these9 selected fixtures/three scales/two policies, the
mixed canvas-kind discrepancies also occur in the genuine unchanged baseline.
No new-renderer or Upgrade discrepancy was observed with like-for-like contexts;
no worker-realm discrepancy was observed with Offscreen in both realms. Settings
also affect existing caption pixels, so matching only canvas kind is insufficient.
These data do not prove equivalence for other fixtures or close the full G2 gate.

Browser warnings/errors/pageErrors each0. URL/title/body1041chars/positive1280x720
bounds/zero Vite overlays checked. Screenshot visually inspected: nonblank project
launcher, not a title-pixel oracle. UI fallback/status,720x800 and actual production
transferred bridge remain unrun. No encoded-codec claim.

Serial diagnostic-worker disposal was acknowledged. Native observer captured11
identities (launcher, npm/Vite, Playwright worker, Chromium/GPU/helpers); no observer
exception/native ps failure in separately preserved outer stderr. No forced
termination; runner remaining=[]. Fresh native ps at2026-09-08T13:53:30Z found no
recorded PIDs and no Playwright Chromium processes;5200 listener clear. Exclusive
slot explicitly released to supervisor. Fresh source guard remains clean17d396f,
unchanged5458122 product, all778 baseline blobs and18 fixture hashes. Original
first-failure artifacts and this complete failed diagnostic remain preserved.

The supervisor independently reproduced the raw audit and approved a test-only
correction for implementation and subsequent review: retain existing HTML
baseline/Upgrade controls; add production-Offscreen baseline/Upgrade controls;
compare worker/export with production-Offscreen main output; match production
policy in worker/export and animation/fallback/bridge reference paths. Keep exact0,
all six original flows and both UI viewports, and obtain a new reviewed checkpoint
and browser slot. Product source remains unchanged; G3 remains gated.

## Durable evidence and qualification

The archive [canvas-diagnostic-17d396f-evidence.tar.gz](canvas-diagnostic-17d396f-evidence.tar.gz)
contains every diagnostic raw sample and metadata record, comparison report,
browser observations/screenshots, runner/native logs, source guards/checkpoint,
fixture data, independent recalculation script and derived audits. The original
first-run matrix is included for counter reproduction; its original complete
artifact directory remains untouched. The original diagnostic implementation
checkpoint remains17d396f, and its exact-zero failure is preserved.

Archive SHA-256: `f09da7bfd88b66141b1b18ac6e2bba7136b06d9425b6e01e29475ff22c57d533`.
The adjacent .sha256 and the archive's evidence-files.sha256 support verification.
Extract into a disposable directory, then run from this worktree:

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
node docs/evidence/issue200/audit-canvas-diagnostic.mjs /path/to/extracted/issue200-canvas-diagnostic /private/tmp/issue200-fresh-audit.json
```

This is a test-reference problem established for the sampled failures: mixed
canvas kinds and settings already differ in the unchanged baseline. It is not a
blanket renderer pass. The corrected six-flow gate still requires exact pixels,
line facts, cleanup, actual transferred bridge presentation and both UI viewports.
