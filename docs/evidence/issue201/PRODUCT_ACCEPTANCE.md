# Local transcription product acceptance

**Accepted locally on 9 September 2026.** The separate [model gate](MODEL_DECISION.md)
passed 23 cases before product integration. The built product now passes all 13
checks below on source `5f05a8a`; its production code includes the keyboard repair
in `e1cd146`. The committed worker branch `a6cb012` matches the reviewed 39-file
source snapshot and is merged into `codex/issue201-completion` without changing
the tested integration tree. The later test-only worker commit `3d917be` adds
Source/export retirement regressions. Publication remains a separate GitHub gate.

## Shipped behavior

The caption editor lazily opens optional English/French transcription. Select one
connected original source, 1–300 seconds, and a timeline insertion frame. The
exact Whisper tiny Q8 model is explicitly downloaded or installed from the exact
local file, verified by hash, and kept in a separate 96 MiB browser-cache budget.
Audio and text remain on-device. The UI and public privacy/license pages explain
model requests, storage/removal, provenance, language and work limits.

Continuous mono/stereo audio at 8–96 kHz uses the shared channel fold and bounded
streaming resampling. Only two 30-second 16 kHz PCM buffers plus bounded scratch
are allowed. Native cue endpoints project directly onto the document's rational
frame rate with floor-start/ceil-end coverage. Invalid endpoint coverage keeps
the complete window text without fabricated cue times; the user must time or
exclude it before Apply. Overlap text is preserved for review. Apply creates
ordinary portable captions through one fresh, budget-checked history edit.

Cancellation retains the worker and analysis admission through cooperative
cleanup. Program starts/restarts, new Source preparation/playback, and export
request that retirement before replacement work. Unknown cleanup stays blocked
with a reload message. A completed review holds text only. Focus follows Cancel,
Close, and the review heading so disabling asynchronous controls cannot strand
Escape outside the dialog. Spellcheck and translation remain explicitly
unavailable because no reviewed local language assets are bundled.

## Built-product browser result

The [single-purpose runner](../../../scripts/issue201/product-acceptance/run.mjs)
serves the actual `dist`, uses visible app controls, and observes worker replies
without editing app state. Native file-picker UI is replaced with the product's
real download/file-input fallback. The pinned model request is redirected to an
exact local HTTP fixture; this verifies the download workflow, not a live hosted
transfer. A separate [HEAD receipt](product-acceptance/model-host-headers.json)
confirms the pinned host returns the expected 43,537,433 bytes and CORS headers.

| Check | Result | Seconds |
|---|---|---:|
| no model lazy path | PASS | 1.130 |
| import connected audio | PASS | 0.158 |
| explicit download | PASS | 0.135 |
| remove and local file install | PASS | 0.176 |
| 48khz stereo nonzero window review | PASS | 4.055 |
| atomic apply undo redo save open | PASS | 0.518 |
| short untimed manual review | PASS | 2.972 |
| french explicit language | PASS | 2.879 |
| cancel inference play pause and retry | PASS | 11.175 |
| 300 second production window | PASS | 81.534 |
| warmed runtime offline cached model | PASS | 3.997 |
| app reload retains model provenance | PASS | 2.868 |
| remove model final cleanup | PASS | 0.044 |

The stereo fixture derives from the pinned English recording with one second of
leading silence, deterministic linear 3× interpolation to 48 kHz, and distinct
left/right amplitudes. Its [receipt](product-acceptance/stereo-fixture.json)
records its exact hash. The tested source range is 1–6.855 seconds, inserted at
frame 17. The 300-second fixture repeats that original recording with silence;
it tests workload coverage, not natural long-form accuracy. Its 12 windows retain
8 timed and 4 untimed results. The one-second case requires manual timing.

Seven completed/cancelled worker receipts independently pass cooperative-zero,
all acquired samples closed, zero model/input/sample/PCM owners, and no more than
3,840,000 PCM bytes. Actual cancellation occurs during the newly created job's
inference; Escape restores focus through both dialogs, Program waits, Pause
cancels its pending start, and a fresh transcription succeeds afterward.

Chromium 151.0.7922.34 ran muted/headless on the Apple Silicon development Mac.
The idle loaded editor baseline was **535,642,112 bytes**; peak browser-tree RSS
was **1,416,675,328 bytes**, an **881,033,216-byte increase**, below the unchanged
1 GiB bound. All **1,108 samples** have complete bracketed process coverage;
maximum active gap is **122 ms** against the 250 ms limit. Browser close took
86 ms. Root independently verified all five observed PIDs absent, port 5201
refusing connections, and the owned profile removed. No awake helper was used.

The loaded app succeeds offline after its speech app/runtime files are warm.
App reload serves the app again while preserving the exact cached model without
another model request. Final model removal leaves no model cache and disables
transcription. This is not an offline application-shell or browser-storage
persistence guarantee. Full browser-process reopening was qualified in the
separate model gate; this product run qualifies page reload and portable project
reopening. Other browsers, devices, codecs/channel layouts, live hosted model
transfer, and physical OS file pickers are not newly qualified here.

Root inspected the [normal review](product-acceptance/attempt-06/stereo-review.png)
and [390px manual controls](product-acceptance/attempt-06/manual-review-390.png).
The review is readable without horizontal overflow and its footer remains
reachable. Saved [applied](product-acceptance/attempt-06/applied.myrelith),
[undone](product-acceptance/attempt-06/undone.myrelith),
[redone](product-acceptance/attempt-06/redone.myrelith), and
[reopened](product-acceptance/attempt-06/reopened.myrelith) files preserve the
expected project equality and exclude runtime/cache handles. The actual
[SRT download](product-acceptance/attempt-06/transcript.srt) contains the edited
text. Existing [caption workflow acceptance](../milestone9/caption-workflows.md)
continues to cover ASS/batch styling and shared caption rendering; a new broad
browser suite or renderer matrix was not claimed.

## Preserved stopped attempts

| Attempt | Preserved outcome | Resolution |
|---|---|---|
| 01 | No-model passed; exact source-label locator failed before inference. | Scope the locator and allow option text inside its label. |
| 02 | Two cases passed; sending a 43.5 MB fixture through CDP exceeded inventory/sampling deadlines. | Transfer fixture bytes over local HTTP; keep all original limits. |
| 03 | Four cases passed and actual stereo transcription returned with 138/138 samples closed; exact textarea-label locator failed. | Match its stable label prefix. |
| 04 | Eight cases passed; disabling Start left focus on body, so Escape missed the dialog. | Repair production phase focus and add its regression. |
| 05 | Eight cases and repaired keyboard exit passed; the inference wait could accept a previous completed job. | Require a new pending job before cancellation. |
| 06 | All 13 cases passed, no errors, qualified memory and verified release. | Accepted. |

Every earlier result remains unchanged. Gzipped start/result/progress records and
screenshots live under `product-acceptance/attempt-01` through `attempt-06`.
[Receipts](product-acceptance/receipts.json) pin original and archived bytes;
every gzip was decompressed and compared to its raw source. Attempt 02's memory
coverage remains explicitly unqualified. Each run's browser/profile/port release
was independently checked before the next run.

## Engineering validation

- Focused acceptance: 185 existing affected cases plus the new phase-focus
  regression pass; 17 runner checks pass.
- Full suite: **5,226 tests in 384 files**, 92.97 seconds, plus **17 runner checks**.
- Two subsequent Source/export regressions pass in a **75-test focused rerun**,
  with 17 runner checks and a fresh typecheck. Source replacement waits for
  retirement and starts only the current source; export cancellation during
  retirement allocates no replacement resources and permits a later retry.
  These controller tests complement the actual native Program handoff above;
  no additional native Source/export browser qualification is claimed.
- Production build/typecheck passes with the existing chunk-size advisory.
- Lint passes with the three existing test-only ownership-alias warnings. The
  exact immutable generated JavaScript file is excluded; its hash is checked.
- Production dependency audit: **zero vulnerabilities**.
- Final diff checks and remote CI/review are recorded with publication.

Compact build/test/audit logs are archived alongside these records. The first
focus test used the wrong matcher name; it was corrected, the focused regression
and build were rerun successfully, and the final full suite above includes it.

## PR #227 review fixes

Bugbot found two actionable issues on `f815383`: native browser spellcheck was
not disabled on transcript text, and the default source window ignored delayed
audio coverage. The review textarea now has `spellCheck={false}`. Source defaults
use the connected asset's exact audio bounds, rounded inward to the displayed
millisecond grid and capped at 300 seconds. The controller rejects pre-roll and
video-only tails before model lookup or worker creation. Source timestamps and
the strict streaming coverage check are unchanged; no silence is fabricated.

Three new regressions cover the privacy attribute, delayed/long source defaults,
and early range rejection followed by a valid unchanged request. All **13 tests
in the three affected files**, **17 runner checks**, build and lint pass. The
initial PR CI also passed **5,228 tests in 384 files**, 17 runner checks, build,
lint and audit; the three new tests await the next CI head. Existing warnings
are unchanged. No dependency or native runtime bytes changed.

A focused built-product Chromium check imported a real delayed PCM Matroska
fixture. Its defaults correctly show **0.25–6.018 seconds**; no model was
installed and no speech worker was created. Root inspected the
[screenshot](product-acceptance/review-fixes/delayed-window.png) and independently
verified all four browser PIDs gone, port 5201 closed and the profile removed.
This checks real import/default selection, not new AAC/native inference or
resident-memory qualification. The earlier 13-case product/model gates remain
the accepted runtime evidence. Raw result, fixture identity, runner, release
receipt and focused engineering logs are in `product-acceptance/review-fixes`.
