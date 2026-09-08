# G2 canvas-kind and realm diagnostic

Status: test/evidence-only checkpoint for supervisor review. **Not run.** A fresh
exclusive slot is required; G2 pixel acceptance and G3 remain gated. Product
source is unchanged from `54581222b3c46208efea47f71a0d865f52778bc9`. The first failed
run and all original artifacts remain preserved; see canvas-diagnostic-first-run.md.

## Question and controls

Distinguish a new renderer/Upgrade regression from HTMLCanvasElement versus
OffscreenCanvas behavior and from main versus worker realm behavior. No baseline
classification follows from source resemblance or matching aggregate counters.
Each baseline sample invokes the actual unchanged compositor and planner archived
from `ce91074c276ca6892a74addb7dd673b9a19c7eeb`, including inside a genuine worker.
No painter, raster algorithm or project geometry is reconstructed for the oracle.

Three renderer inputs: baseline compact, current compact, actual current Upgrade.
Three hosts: main HTML, main Offscreen, genuine worker Offscreen. Two explicit
context policies:

| Policy | Destination request | Leg/group request |
| --- | --- | --- |
| Original proof | sRGB, willReadFrequently=true | sRGB, willReadFrequently=true |
| Production settings | sRGB, willReadFrequently omitted | sRGB, willReadFrequently=true |

Production settings come from renderWorker/contracts.ts and core.ts, and
export-mediabunny-sink.ts. The test helper's original default remains unchanged;
its added optional policy affects only test-owned contexts. Production files and
actual rendering behavior are untouched. Requested and actual context attributes
are captured separately. If the browser lacks getContextAttributes, actual is
explicitly null, never inferred from the request. All samples retain dimensions,
realm, user agent, font readiness status, resolved presentation profile, observed
fillText/strokeText line facts, raw RGBA and ownership facts. Readback remains the
same destination getImageData path without drawImage conversion or color repair.

## Fixed input and work bounds

Nine fixture selectors reuse the frozen proof factory. Commit-pinned SHA-256
values cover JSON.stringify of each complete compact and upgraded project;
fixtures.json saves the exact input objects supplied to the browser and worker.

| Family | Case | Reason |
| --- | --- | --- |
| sans-serif | plain | Passing control |
| sans-serif | combining-emoji | Original first failing class |
| sans-serif | crop-flip | Largest full-quality discrepancies |
| sans-serif | background | Non-font-only reduced-resolution discrepancy |
| sans-serif | outline-shadow | Completed text paint behavior |
| monospace | caption-canary | Existing caption painter canary |
| fantasy | fractional | Full/reduced-resolution discrepancy |
| fantasy | anchor-zero | Rotated lower anchor boundary |
| fantasy | anchor-one | Rotated upper anchor boundary |

Each fixture runs Full/Half/Quarter at frame0, 320x180 project resolution and one
frame duration. Two planned samples per cell use fresh surface owners. This is
an explicit repeatability control in one fixed run, never a retry after failure.
Nine fixtures x3 scales x2 policies x3 renderers x3 hosts x2 samples =972 draws.
Nine full-resolution fixtures x2 policies x2 samples through actual finite
exportTimeline add36 draws. **Maximum1008 draws and2160 comparisons**, all serial
within one muted Chromium browser/one worker; each proof owns at most3 canvases,
zero media requests, zero surviving canvases, and cleared scratch. Each one-frame
export must finalize and close exactly one acquired lease. The worker acknowledges
disposal, then its owner terminates it. Native launcher descendants/listener are
verified separately after the process exits.

Losslessly gzipped RGBA files retain exact bytes with uncompressed SHA-256 and
metadata per sample. The complete raw byte bound is106,272,000 bytes before gzip.
Only one fixture/resolution's samples are retained in page memory at a time.
Trace recording is disabled for this diagnostic because it would duplicate about
142 MB of raw binding payloads; original failed-run trace remains intact. A page
screenshot, URL/title/nonblank/overlay checks, separate console warnings/errors
and page errors accompany the diagnostic. The page screenshot shows the launcher,
not a pixel oracle. No mobile/status acceptance is claimed by this diagnostic.

## Comparisons and stop policy

Record all comparisons at **zero differing RGBA bytes, zero maximum delta and
identical observable line facts**, preserving dimension checks and ownership.
Compare:

1. Baseline/current compact and compact/Upgrade within EACH identical host/policy.
2. HTML/Offscreen within EACH identical main realm, renderer and policy.
3. Main/worker Offscreen within EACH identical renderer and policy.
4. The two planned samples within EACH exact cell, including finite export.
5. Current expanded full-size HTML/main Offscreen/worker against finite export.
6. Proof versus production policy within EACH host/renderer at the first sample.

A newly measured same-host renderer or Upgrade discrepancy, repeat instability,
source/fixture mutation, context failure or ownership failure stops immediately
after the cell's already-produced raw evidence is saved. Known cross-kind,
cross-realm, context-policy and export discrepancies are measured throughout the
single bounded experiment; they are not accepted or corrected. After all data are
saved the test still fails if ANY comparison is nonexact. Thus “diagnostic
completed” cannot be confused with “parity passed”. No correction/rerun follows
without supervisor review and a fresh grant.

Even reproduced baseline differences cannot automatically waive G2 requirements.
A proposed harness correction or product correction must be reviewed separately.
Actual transferred RenderWorkerBridge presentation remains independently required;
this diagnostic worker calls production modules but is not that bridge. The finite
export captures pre-encoder pixels and does not prove encoded-file equivalence.

## Source pins and launch

verify-canvas-diagnostic.mjs rejects all changes relative to5458122 outside its
explicit test/evidence path allowlist, verifies all18 fixture payload hashes,
then invokes the original778-blob baseline and complete source fingerprint guard.
Capture after committing; launch requires that exact clean manifest. Before and
after the run the native runner preserves both checks. Never overwrite the first
run or reuse a diagnostic artifact directory.

Only after supervisor review/grant:

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
export NODE_OPTIONS=--no-experimental-webstorage
node docs/evidence/issue200/verify-canvas-diagnostic.mjs capture .tmp/issue200-canvas-diagnostic-source.json
export ISSUE200_DIAGNOSTIC_MANIFEST="$PWD/.tmp/issue200-canvas-diagnostic-source.json"
export ISSUE200_DIAGNOSTIC_ARTIFACTS=/private/tmp/issue200-canvas-diagnostic-UNIQUE
python3 docs/evidence/issue200/run-canvas-diagnostic.py
```

The artifact path must be fresh and not yet exist. The runner checks port5200
before launch, creates only its own new process session, records native PID,
parent/group/start-time/command identity, and terminates only matching surviving
owned descendants. It writes process-ownership.json and release-verification.json.
Explicit slot release to the supervisor follows fresh native verification.

This uses regular repository Playwright because the Browser plugin is unavailable.
No dependency installation, integration sync, product edit, G3 work, publication,
master merge or issue closure is part of this checkpoint or proposed diagnostic.

## Checkpoint validation

Three focused files /11 tests plus17 runner checks passed. Production build and
typecheck, lint, the diagnostic TypeScript project, native runner syntax, fixture
hash/source guards, production-output isolation and diff hygiene passed. Playwright
listed exactly one diagnostic test without launching a browser. The existing Vite
chunk advisory remains. Logs: canvas-diagnostic-source-checks.log. These checks
validate the preparation; they do not close the failed observable gate.
