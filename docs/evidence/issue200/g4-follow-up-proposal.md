# Title first-paint investigation and remaining G4 proposal

Status: **proposal for supervisor review; no new harness, product correction or
native execution is included.** Source inspected at evidence-only checkpoint
`773f9039fc7324c9e24ab02713551d9d7f9a159e`; product and G3 harness still match
tested `3d5b39fab76354f2a30f3d834cda3e40ba5461f7` exactly. No integration sync has
occurred. The supervisor accepted the six G3 functional flows with the explicit
qualifications in [g3-functional-results.md](g3-functional-results.md).

## What the source establishes

1. `tests/browser/issue-200-title-authoring.spec.ts:191–208` chooses the fallback,
   reopens the exact portable file, waits for the notice and takes a screenshot.
   It never awaits a matching worker draw or asserts canvas pixels. The retained
   reopen PNG has a notice and title outline but no visible glyphs.
2. `src/app/previewController.ts:658–785` publishes title notices in the scheduled
   animation-frame callback **before** calling the asynchronous bridge render.
   This is the only production writer of title notices. Therefore the notice is
   evidence of a planned render, not completed glyph presentation.
3. `src/workers/renderWorker/core.ts:1927–1967` awaits composition, rejects a stale
   generation, draws the completed scratch surface to the visible canvas, then
   posts `compositeDone`. `src/engine/render-bridge.ts:913–922` resolves the matching
   request. Even `status: drawn` is not an independent glyph-pixel assertion.
4. Existing passive app subscriptions distinguish worker completion from a later
   presentation opportunity: `subscribePreviewRenderCompletions` and
   `subscribePreviewRenderDiagnostics`. The latter runs after two animation-frame
   callbacks and rejects superseded/replaced presentations. Completion observations
   themselves are not filtered by the current controller generation. A follow-up
   must retain old/superseded completions without mistaking them for the new canvas.
5. Canonical leave and activation await preview disposal. Disposal clears notices,
   subscriptions, planner, canvas and scheduled render, and advances generations
   (`projectControllerCore.ts:304–402`, `previewController.ts:1191–1224`). App switches
   editor/launcher by session screen (`src/app/App.tsx:96–112`); Preview initializes
   on mount (`src/ui/Preview.tsx:85–88`). Initialization schedules its initial frame.
   Viewport changes also schedule a render after changing the presentation profile
   (`previewController.ts:459–500, 1043–1188`).
6. The supported fallback resolver is synchronous explicit intent. The planner
   passes the chosen generic family to the existing text painter
   (`titleElements.ts:225–232`, `titleComposition.ts:97–112`); there is no asynchronous
   custom-font load that this fixture needs to await.

**Finding:** the original readiness assertion permits a screenshot before the
fresh draw/presentation, so a first-paint timing explanation is plausible. There
is no source-proven persistent rendering defect. A wholly absent reinitialization
is less consistent with the new notice: disposal resets it and its sole writer
is the scheduled renderer. These facts still do not prove the canvas was replaced
or received a completed frame in this run. React commit timing, worker startup,
supersession, resize and actual pixels were not recorded at that boundary. No
production change is proposed from the screenshot alone.

## A — bounded fallback observation to prepare after review

Prepare a separate diagnostic test/observer/config and current-checkpoint source
guard under `tests/diagnostics/issue200/` and `docs/evidence/issue200/`. Preserve the
accepted G3 test and historical G2 guards/archives unchanged. Review the executable
harness and its discovery/typecheck results before requesting a native slot.

One test, one private muted headless Chromium worker at 1280×720 on port 5200;
60-second test deadline, no retries, maxFailures 1. Use the already reviewed
bounded ownership-runner logic with a 600-second outer ceiling and a fresh external
artifact directory. No extra browser, interactive window, playback or performance
workload. This is a functional deadline, not a startup-speed acceptance target.

Use the same expanded fixture, literal `Missing G3 Face`, serif choice, frame 0,
and canonical lifecycle as the accepted G3 flow. Keep its actual UI choice, exact
portable reopen and healthy persistence/session assertions. Do not insert a seek,
quality toggle, remount, font substitution or second reopen to make a blank result
pass. Do not add a launcher wait to the existing sequence that could conceal its
mount timing. Observe intermediate screens and canvas identities passively.

Before transitions, subscribe to both existing render diagnostics and store
changes. Keep a bounded event ledger with performance timestamps, session phase,
project generation, active sequence/clip, exact frame, quality/profile/dimensions,
canvas identity/connection, notices and draw/missing/superseded/error results.
Observe canvas replacement using DOM identities and a MutationObserver; attach the
complete sequence rather than only its final state. Fail on ledger overflow
(256 events), observer failure, console warning/error or page error. Record Node
runner advisories separately. Never instrument or change production canvas policy.

Capture the actual `.preview-canvas` into a separate sRGB readback-only Offscreen
canvas at its intrinsic size, following the existing production-bridge proof's
`drawImage(canvas, 0, 0)` method. Keep raw RGBA (compressed losslessly), exact canvas
PNG, full-page PNG and metadata at these six named checkpoints:

1. Initial supported generic title after its matching presentation.
2. Missing named font with no fallback after its matching presentation.
3. UI-selected serif fallback before reopen, after its matching presentation.
4. Reopened notice/portable state at the original G3 screenshot boundary, without
   introducing a presentation wait before this capture.
5. Reopened canvas after the matching current-owner `drawn` presentation event.
6. The same reopened canvas after two additional animation-frame opportunities,
   with no document, playhead or user interaction between checkpoints 5 and 6.

Register observers before the lifecycle starts so an early completion is retained.
Gate on the internally generation-checked presentation event, target generation,
canvas identity, frame 0, expected drawn clip and no missing clips; retain all
completion events as diagnostic evidence. Record the transition start before
activation and verify the accepted request belongs to that transition. A same-frame
old completion or status notice cannot satisfy the gate. Await the first matching
presentation for at most 10 seconds, under the test deadline. Capture timeout state
and fail if it is absent; do not force a render or silently repeat the sequence.

Create comparison references only after the live checkpoints, so their work cannot
alter the measured initial scheduling. Use the shared production planner/painter,
matching output profile and Offscreen destination/leg/group context settings from
the accepted G2 proof. Record requested and actual context attributes. Check the
resolved profile against observed canvas dimensions; fail a mismatch. Compare the
actual fallback pixels against a control with the same title and direct generic
serif intent, and against an otherwise identical empty-text control. Require:

- checkpoints 3, 5 and 6 have exactly zero differing RGBA bytes and zero maximum
  delta against the generic serif reference; 5 and 6 remain exactly identical;
- the generic reference differs from its empty-text control in the title glyph
  region, with retained line/text facts and changed-pixel coordinates, so two
  blank buffers cannot pass; verify the initial supported title likewise;
- checkpoint 2 is the unavailable/empty-glyph control and retains the literal
  missing family; checkpoints 3–6 retain literal intent and explicit serif fallback;
- the exact `projectTitleExportError` predicate consumed by export preflight
  returns the missing-font reason without fallback and null after fallback;
  this is title eligibility only, with no encoder or new export owner launched.

Checkpoint 4 is diagnostic: preserve whether it was blank, already correct or
different. If it is blank but 5–6 pass, report an observed early capture followed
by correct automatic rendering. If 5 or 6 fails, preserve the ledger/pixels and
report a candidate scheduling/rendering failure; do not infer its cause or correct
it during the run. A later pass establishes this run only, not the cause of the
historical PNG. No cross-platform font identity or complete glyph-coverage claim.

Keep success **and** failure traces, all explicitly requested artifacts, and all
attachments in a hashed manifest; do not cite deleted internal trace PNGs as
retained evidence. Finally unsubscribe, disconnect observers, release capture
surfaces, leave the project through its lifecycle and close owned browser/server
processes. Verify source before/after, inspect all screenshots, record fresh full
PID/start/command and listener evidence, and explicitly release the slot. A failed
assertion or cleanup is terminal for that grant. Archive before any correction.

## B — remaining title acceptance after the accepted integration sync

The supervisor owns #199 title/property/dope-sheet and five-owner seam integration.
Do not implement a parallel editor or pull another branch into this worker now.
After the exact sync is reviewed, produce one final acceptance matrix that maps
the issue/plan criteria to existing evidence and these remaining checks:

| Slice | Concrete remaining proof and boundary |
| --- | --- |
| Shared #199 title keys | Actual element/property selection, key insertion/value/time/easing edit, nonsequential seek, cancel, one-commit Apply and Undo/Redo through the shared workspace. Retain ordinary `titleTracks` and future/orphan intent; exercise scalar edit after generated roll/crawl, then trim/split/extend and consented Reapply. Coordinate exact cases with #199 to avoid duplicate or conflicting ownership. |
| Five preview owners | `title-authoring` alongside `animation-gesture`, `mask-gesture`, `color-grading` and `mask-tracking`: priority and replacement, hidden payload accounting, project/sequence/selection/playhead/lock invalidation, cancellation/disposal and fresh retry. Exact project/history equality on rejection; one edit on accepted Apply. Re-run changed shared admission seams on the integrated source. |
| Accessibility and narrow layout | At 1280×720 and 720×800, use actual keyboard element selection/order/add/delete, numeric alternatives, focus trap/return and Escape, readable labels/status/safe guides. Measure title controls/dialog bounds and review screenshots. Existing shared workspace clipping is an unresolved plan criterion; report it separately and ask the supervisor to assign any correction. Do not relabel modal containment as whole-workspace no-overflow. |
| Templates and persistence | Carry the accepted real IDB capture/use/delete evidence; add native checks only for changed integrated template/key behavior. Preserve focus and interruption checks, independent IDs, future-envelope/quota rejection, exact portable save/reopen and completed recovery. Carry source budget/identity boundary evidence with exact provenance. |
| Rendering and export | Complete slice A, then run the relevant existing exact main/worker/raw-export matrix on the final integrated tree, including changed title/#199 paths. Keep generic/context, warning and pre-encoder qualifications explicit. Prepare a separate bounded encoded-file protocol using the existing supported export and import owners: retain output bytes, codec/container, dimensions/rate/duration, reopen/decode and inspect selected glyph/motion frames. Codec availability must be preflighted; absence or failure cannot become a silent skip. Lossy decoded pixels must not be called exact raw-render equivalence. Review codec-specific predicates before the native grant. |

## C — final engineering and timing gate

On the exact committed integrated tree, record an immutable source manifest and
private dependency/runtime identity. Run changed-seam focused tests, then the full
canonical `npm test -- --maxWorkers=2` with
`NODE_OPTIONS=--no-experimental-webstorage` in the supervisor's exclusive slot.
Run `npm run build` (including TypeScript), `npm run lint`, `npm audit --omit=dev`,
architecture/import-boundary checks, `git diff --check`, and production-output
exclusion of diagnostic/baseline fixture modules. No dependency fix or update is
implied by an audit. Keep focused acceptance and full-suite failures distinct;
baseline classification requires an unchanged `ce91074` reproduction in its own
reviewed slot, preserving source/version qualification.

Final timing/performance evidence needs its own reviewed bounded fixture matrix,
sample counts, warmup policy, thresholds and exclusive grant. Agree that matrix
with the supervisor after integration; do not use G3 wall time or this diagnostic's
10-second deadline as performance acceptance. No full suite, build, browser,
benchmark or encoded export runs concurrently with another task's native slot.

**Requested next decision:** review the source finding and slice A predicates,
then authorize preparation of that evidence-only harness. Its executable source
and bounds require review before a native grant. Slices B/C remain dependent on
supervisor-approved integration and separately reviewed final protocols. This
proposal does not close G4 or request permission to fix an unproven product bug.
