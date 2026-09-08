# Immutable export pixel diagnostic

The parent must review the exact clean commit and grant each diagnostic before
the command runs. The accepted raster result and
failed/incomplete export result remain unchanged. No cause or export pass is
inferred from preparing this harness.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue198/run-export-diagnostic.mjs --expected-sha <reviewed-full-sha> --output <fresh-owned-worktree-.tmp-directory>
```

## Immutable inputs and isolation

Only the two existing files under `.tmp/issue198-8129d4e-export-attempt1` may be
read. File size is checked before bounded allocation and again after reading;
SHA-256 is checked on the host and browser. The owned server serves exactly two
GET requests from those verified bytes. There is no input override.

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| source.mp4 | 1,069,647 | 55a7094a0d645e5ec67c7d266890d9c6c8500a125f3454408bdd467ef8ed6264 |
| export-complete-0.mp4 | 2,103,209 | f31104bd0a9d26d8ae1285bd15798b625281f8222268c79a34d006481eba0f2c |

The driver requires a clean full SHA, an unoccupied strict port 5198 and a
fresh owned output directory. It opens one muted headless Chromium instance
on the existing blank harness page. It never opens the application editor or
imports application/state mutation controllers. The production check constructs
an isolated local document with the same pure clip factory, settings, 300-frame
mapping and 256 held paths. Its identity is checked after composition.

The immutable route is registered in Vite's `configureServer` hook before its
SPA/terminal handlers. Admission failures retain the requested fixed path,
response status and Content-Length/Content-Type headers capped at 128 characters
each, without reading an inadmissible body or adding another evidence record.

No encoder, export sink, export controller or new source video is constructed.
No existing project, original video, raw run, tolerance or accepted harness
file is changed. The driver records exact source, input hashes, command,
Chromium/GPU provenance and owned process IDs.

## Frozen work and observations

`DiagnosticWorkOwner` claims each request before dispatch and fails before any
request beyond its limit. Successful collection requires every exact count.

| Work | Exact limit |
| --- | ---: |
| Ordinal returned-sample requests | 600: 300 per immutable video |
| Sparse returned-sample requests | 12: six per video |
| Actual production source requests/leases | 128: source frames 0 through 127 |
| Total public sample/source requests | 740 |
| Actual unencoded production composites | 1: frame 127 only |
| Frame-127 candidate comparisons | 6: source 126/127/128 × held path 0/1 |

Both videos are read in ordinal order through frame 299; the iterator is then
closed without requesting a 301st sample. Six targets, 0/126/127/128/255/299,
retain pixels and returned timestamps/durations. Each target is also read with
`getSample(frame / 30)`, recording exact RGBA hashes, VideoFrame timestamps,
color metadata and ordinal/sparse differences. The complete 300-entry ordinal
timestamp/duration list is retained per video. All samples and all 24 selected
VideoFrames close; input readers dispose. Internal decoder prefetch/allocation
counts are not exposed and are not equated with the 740 public requests.

The six candidate comparisons retain histograms of absolute RGB error (256
bins), full aggregate counts, mean/maximum error, counts above 12 and attribution
to opaque/feather/outside regions from the reference alpha. Each of the first
above-limit and maximum-error coordinate lists is capped at 64; aggregate
counts remain exact. The original maximum 12 / mean 2 limits are recorded as
unchanged comparison fields. Differences are observations, not diagnostic
abort triggers or permission to relax the failed export gate.

The actual production source requires ordered consumption. The diagnostic opens
and closes its real leases for frames 0–126 without compositing, then obtains
frame 127. That same decoded ImageBitmap supplies both the matching-input oracle
readback and one call to the actual `compositeFrame`; it is borrowed until the
composite settles and then closed by its real lease. The actual plan, selected
path, all source request indices and source/lease/graded-resource cleanup are
recorded. The main canvas requests sRGB; the two scratch canvases request sRGB
and `willReadFrequently: true`, matching the production export sink's policies
without constructing that sink. Returned context attributes are recorded when
available, explicitly marked unavailable otherwise; readback color spaces are
also recorded.

Three final comparisons connect the stages: actual production input versus
ordinal source 127, unencoded production output versus the oracle made from
that exact input, and saved decoded output 127 versus the unencoded production
output. The last comparison uses static-oracle coverage only for region labels;
its reference RGB is the actual production result. The code does not assign a
renderer, reference, canvas or codec cause automatically.

## Pixel, artifact and time bounds

Caller-owned RGBA arrays have a 64 MiB cap, checked before each readback or
copy allocation. The ledger records actual admitted bytes, peak, allocation and
release counts; every array is wiped and released on completion or failure.
Unneeded target arrays are released before candidate/production work. Mask
scratch, browser/native canvas storage and private codec queues are separate
from that array-owner cap; this is not a native memory or leak qualification.

At most 256 numbered JSON records may be written, each capped at the shared
store's 2 MiB. The producer gets 253 slots and three are reserved for failure,
teardown and evidence closure. Normal observations use the existing serialized
exclusive-file/fsync store and exact manifest. Original inputs remain retained
in their original and committed evidence packages; no new binary is generated.

The 120-second host limit bounds **diagnostic evaluation only**. Setup and
teardown have separate deadlines. Browser elapsed time is checked against
90 seconds between work units. Each decode/lease/read/hash operation is bounded
at 5 seconds; the single composite at 10 seconds. Browser/server setup steps
are bounded at 30 seconds, GPU provenance at 10 seconds and awake spawn at
5 seconds. These are failure ceilings, not performance targets.

Diagnostic evidence writes are bounded at 5 seconds and final store/manifest
closure at 10 seconds. `runWithDiagnosticEvidence` always proceeds from a
failed write to the actual owner cleanup callback. A failed or stalled store
produces explicit partial receipts on stdout; each receipt is capped at about
32 KiB and its writer at 1 second. Later writes fail promptly after store
failure. A late manifest failure changes the overall result to failed/incomplete,
even if observation collection completed. These wrappers do not modify the
accepted shared store. Missing durable data remains unqualified.

Every host owner gets a 10-second close; the owned browser server gets a separate
10-second forced-close bound if needed. Scoped awake release and PID-settle
checks each get 5 seconds. Console warnings/errors and page errors interrupt the
owned browser; signal handling is bounded. Raw observations/partial receipts
remain. The parent independently verifies runner/descendant/awake termination
and port release. Failed command exit uses the already tested lifecycle helper,
so retained Node handles cannot keep the command alive after teardown.

## Source checks before review

The focused inert tests cover unchanged document/path mapping, exact statistics
and capped coordinate lists, 740-request/single-composite/six-candidate claims,
pre-allocation refusal at 64 MiB, byte mutation and size rejection, stalled
decode waits, stalled record/manifest/fallback writers, actual cleanup control
flow and retention of raw evidence/partial receipts. They never decode, encode,
open a server/browser or run the production composite.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx tsc -p scripts/issue198/tsconfig.json
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage npx vitest run --config scripts/issue198/vitest.config.ts scripts/issue198/diagnosticPixels.test.ts scripts/issue198/diagnosticComposite.test.ts --maxWorkers=2
DEVELOPER_DIR=/Library/Developer/CommandLineTools node --test scripts/issue198/diagnosticDriver.test.mjs scripts/issue198/diagnosticEvidence.test.mjs
```

No browser diagnostic, extra decoding, production export, native matrix or
build has run during this preparation. Execution requires a separate grant
after exact-source/protocol review.

The freeze source gate passed eight focused Vitest checks in 698 ms and five
Node checks in 188 ms, plus isolated TypeScript, lint, JavaScript syntax and
diff hygiene. Initial preparation exposed unavailable OffscreenCanvas context
attribute typings and unsafe-finally lint warnings; feature detection and
first-failure-preserving cleanup resolved those before freeze. The final gate
includes actual stalled-store cleanup flow and late-closure failure checks.
These are source/inert results only; no diagnostic/native execution occurred.

## Routing correction after attempt 1

The single native diagnostic at clean `12449aafa3c5a84bf44f3071cc14a5b954b2880a`
failed during its first response extent check; every decode/composite/pixel
counter was zero. Failure evidence is committed at
`32ae47a3b800a0b273dba7685fe45c766105e69c`. The parent independently confirmed
all recorded processes and port 5198 released. The original export remains
failed/incomplete and its pixel cause unresolved.

The corrected driver moves the same immutable handler before Vite's internal
fallbacks. Two inert tests exercise the actual registration helper and handler
against a small in-memory model of the inspected Vite8.1.2 hook/fallback order.
They fail with the old placement and pass with the correction. They cover both
exact binary bodies/headers, unknown/nonexact paths, invalid methods, normal
route fallthrough and refusal of a third admitted request. They do not start
Vite, open a socket, launch a browser or decode video, so actual Vite/browser
integration still requires a separate approved native run. All immutable
inputs, request/work limits, pixel bounds, deadlines and tolerances above remain
unchanged. See the [routing source evidence](../../docs/evidence/issue198/diagnostic-route-source/results.md).
