# Separate fallback first-paint diagnostic — executable source review

Implements the six-checkpoint slice A accepted from
`479b5b7141f0f7917219533811c655259b6827d5` in
[g4-follow-up-proposal.md](g4-follow-up-proposal.md). **No native execution yet.**
Production files, existing G3 test/config/runner and historical rendering guards
remain unchanged from tested `3d5b39fab76354f2a30f3d834cda3e40ba5461f7`.
Only new diagnostic/test/evidence files are added. No integration sync.

## Entry points and preserved behavior

- `tests/diagnostics/issue200/first-paint.gate.ts`: one real UI/canonical-reopen
  test. Its portable-open helper uses the same operations, arguments and selectors
  as accepted G3. There is no new launcher wait, seek, quality toggle, corrective
  remount or additional fallback reopen. Explicit serif is the actual UI choice.
- `first-paint-client.ts`: bounded passive completion/presentation/store/DOM ledger,
  transition and canvas identity pins, ten-second matching-presentation deadline,
  synchronous readback, retained captures and explicit subscription/timer cleanup.
  Completion-only, old requests, wrong generations/canvases/frames, missing clips
  and superseded draws cannot satisfy readiness. Historical session errors remain
  failures after the current state recovers. Exceeding 256 ledger events fails.
- `first-paint-reference.ts`: loaded only after all live checkpoints; actual shared
  planner/painter controls with production Offscreen context policy. Every required
  pixel comparison stays exactly zero. A serif reference must differ from its
  empty-text control and record the expected text lines. The full changed-pixel mask
  is retained as row-major uint8 data, plus count and sample coordinates. Context
  and surface cleanup failures are terminal and retained as comparison failures.
- `first-paint-model.ts`: fixture construction and pure ownership/pixel predicates.
  The fixture is the accepted expanded 1920×1080, 100-frame title with its dormant
  sequence; creating a 720p starter project does not change those portable bytes.
- `first-paint.playwright.config.ts`: one private muted headless Chromium worker,
  1280×720, port 5200, 60-second test timeout, zero retries, maxFailures 1.
  Trace is **on for both success and failure**. No playback/encoded export.

The six retained checkpoints are initial generic, unavailable font, explicit
fallback before reopen, reopened at the original status/portable boundary, reopened
after its matching presentation, and unchanged reopened pixels after two further
animation-frame opportunities. At the original boundary the raw sample precedes
the full-page screenshot; PNG encoding and reference work follow that screenshot.
Record the browser performance-clock capture time and separate Node wall-clock
screenshot interval. Passive subscriptions, readback and automation still add
instrumentation cost; this is not an uninstrumented latency measurement.

The original-boundary checkpoint is diagnostic. If its intrinsic canvas size has
not reached the resolved profile, retain that fact and its actual pixels without
misapplying a differently sized reference. Settled checkpoints must have the exact
resolved dimensions/context policy and exact pixels. A diagnostic-only early
buffer cannot qualify a settled comparison. Empty/invalid settled output fails;
no polling for a better pixel buffer or silent retry is implemented.

Each accepted capture pins the complete portable wire and history. Strict title
eligibility uses the actual `projectTitleExportError` predicate consumed by export
preflight: unavailable named intent gives a reason, explicit fallback gives null.
It does not invoke an encoder, export owner or codec capability probe.

## Native ownership and source freeze

`run-first-paint-browser.py` copies the accepted G3 ownership/timeout/release code
with only four diagnostic-name substitutions before a new final artifact-manifest
function. The 600-second outer deadline, nonblocking raw stdout, per-query bounds,
PID/start/command rechecks and owned TERM/KILL cleanup remain unchanged. Twelve
injected-process/filesystem unit checks cover the ten prior cases plus exact trace
hashing and symlink refusal; these checks launch no native process or browser.

After Playwright exits, the new artifact manifest includes every regular file,
including successful and failed trace ZIPs and framework attachments. It records
size/SHA256 and excludes itself. A manifest error fails the runner. Raw stdout,
source checks, ownership/release evidence, all six raw RGBA/PNG/metadata records,
page screenshots, reference and empty images, masks, exact comparisons, lifecycle
JSON and complete bounded observations remain available even when assertions fail.
An impossible capture/renderer/page failure is recorded as missing evidence rather
than manufactured pixels. The afterEach hook preserves remaining captures, releases
observer resources, awaits canonical project leave and explicitly closes the page
before saving the final browser problem arrays. Framework teardown and native
cleanup remain under the independent runner deadline.

`verify-first-paint-source.mjs` requires the exact issue200 directory/branch and a
clean tree. It rejects any change to frozen product/G3 paths except the explicitly
named new source-unit/diagnostic files. Its manifest hashes **all tracked files**,
including this executable protocol, runner, guard, fixtures and evidence. Record
against the review commit; verify immediately before and after the granted run.
The external manifest is not part of its own source fingerprint.

Only after supervisor review and an exclusive native grant:

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
export NODE_OPTIONS=--no-experimental-webstorage
node docs/evidence/issue200/verify-first-paint-source.mjs record /private/tmp/issue200-first-paint-REVIEWED-source.json
export ISSUE200_FIRST_PAINT_MANIFEST=/private/tmp/issue200-first-paint-REVIEWED-source.json
export ISSUE200_FIRST_PAINT_ARTIFACTS=/private/tmp/issue200-first-paint-UNIQUE
python3 docs/evidence/issue200/run-first-paint-browser.py
```

The artifact directory and source-manifest filename must be fresh. Preserve outer
launcher/awake ownership and stdout as in the accepted native protocol. On completion
or failure, inspect every screenshot and comparison, verify every artifact hash,
record fresh complete process/listener evidence including outer owners, release the
slot explicitly, and archive before any source correction. No automatic retry/sync.

## Source validation and remaining gates

The source review includes three focused suites (pure false-positive/fixture
admission, observer deadline/error/disposal, and the production architecture graph),
the canonical wrapper's 17 runner checks, diagnostic TypeScript, lint, Python/Node
syntax, twelve native-runner unit checks, one-test discovery and frozen-source/diff
hygiene. Exact results and raw logs are in `first-paint-source-validation/`.

During draft validation, one test assumed JSON property order; it now checks the
actual parsed font object. The original failed log is retained. Two draft TypeScript
issues were corrected: the optional Offscreen context-attribute method requires
an explicit capability check, and reference title access must use the canonical
definition reader. No product correction follows those harness issues.

No production build, full suite, browser, encoded export, benchmark or final G4
acceptance is claimed by this source-only checkpoint. Root owns the combined sync,
shared workspace clipping and final full/audit gates. Encoded title expectations
are being coordinated with #199's mixed export protocol so they use one reviewed
native run. Generic-font, reference-line, lossy-codec and historical-cause limits
from the accepted proposal remain in force.
