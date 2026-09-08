# Issue #201 — semantic ASS, batch captions, and optional local speech

Stage: initial internal review, 2026-09-08. Product implementation has not
started. Starting tree: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`, branch
`codex/issue201`. This document requests the orchestrator's review; it does not
authorize the speech product path before its separate measured gate.

## Acceptance and existing authorities

The issue requires strict bounded ASS interchange, deterministic atomic batch
edits, semantic track/cue styles shared by preview/export, an optional local
speech path with disclosed provenance and exact lifecycle, accessible responsive
authoring, real Chromium acceptance, and the repository's completion checks.
Optional spellcheck/translation may ship only with explicit local language assets
and provenance. No caption/media/text upload, synthetic caption clips, arbitrary
ASS effects, or cloud service belongs in this change.

Current source inspection establishes these integration points:

| Authority | Reuse or change |
| --- | --- |
| `src/domain/captions.ts` | Owns validation, split/touching merge/shift and `captionPaintFor`; extend rather than duplicate cue math. |
| `src/domain/captionFiles.ts` | Keep existing SRT/VTT grammar, errors, identity rules and exact rational rounding unchanged. Add a sibling ASS authority. |
| `src/domain/schema.ts` | CaptionItem currently has id/range/plain text; CaptionTrack has language/role/preset/visibility/items. Add bounded resource-free metadata here. |
| `src/domain/projectFile/documentValidation.ts`, `migrations.ts`, `projectTypes.ts` | Exact-key validation needs an explicit coordinated timeline migration; current timeline 21 / project format 8. |
| `src/domain/projectSequences.ts`, `src/state/documentStore.ts` | Reserve identities across all sequences; validate full-project budgets before one history commit. |
| `src/domain/videoCompositionPlan.ts` | Keep `kind: 'caption'` and the existing sequence/bus ordering. |
| `src/pipeline/render.ts`, `src/domain/textLayout.ts` | Keep legacy `drawTextPayload`/`wrapTextLines` behavior; custom caption styles resolve to its existing inputs. |
| `src/app/captionFileController.ts` | Retain whole-input validation, explicit file ownership, latest-document check, one commit and download-URL cleanup. Extend with a reviewable ASS proposal. |
| `src/ui/CaptionEditor.tsx` | Retain lazy modal, keyboard navigation/focus return and bounded 200-row list. Add scoped selection, previews, styles, diagnostics and speech status through app/state facades. |
| `src/app/mediaJobScheduler.ts`, `mediaResourceAdmission.ts` | Scheduler already reserves shared analysis admission. One bounded speech job must use this authority and retain admission through cleanup. |
| `src/app/audioAlignmentService.ts`, `audioAlignmentWorkerBridge.ts` | Reference ownership patterns only; do not reuse the alignment feature cache or its 200 Hz audio as transcription PCM. |

The orchestrator allocated timeline **schema 24**, following #199's common
animation schema 22 and #200's title-owner schema 23. Do not edit migration
globals until those committed foundations are shared; independently approved
pure modules/lab work may proceed first. No project-format bump is proposed.
#200 confirms its title adapter will preserve the shared painter;
coordinate any extraction before either task edits that implementation. Caption
styles remain static and introduce no dependency on #199's scalar animation.

## Proposed portable style and provenance contracts

- Keep `stylePreset` and its exact current pixels when no override is present.
  Add optional track `style` and cue `style` descriptors shaped as
  `{ version: number, params: Record<string, string | number | boolean> }`.
  Version 1 is a closed partial override vocabulary. Resolution is preset →
  track override → cue override, without mutating any stored level.
- Proposed v1 fields: `fontFamily` from the existing six generic families;
  `fontSizePermille` (8–150 relative to canvas height); canonical RGBA `color`,
  `outlineColor`, `backgroundColor`; `bold`, `italic`, `backgroundEnabled`,
  `outlineEnabled`; `outlinePermille` (0–10); horizontal `align`; vertical
  `position` (`top`, `middle`, `bottom`); `marginXPermille` and
  `marginYPermille` (0–250). No per-span styling, arbitrary fonts, animation,
  shadows with new semantics, or unbounded CSS enters this descriptor.
- Shadow correction (2026-09-08 proposal): add optional boolean `shadowEnabled`
  to v1, inheriting the preset when omitted. Minimal and classic both have legacy
  shadow; boxed does not. Preserve legacy color/blur/offset parameters. ASS imports
  explicitly set false; full resolved export must reject/report enabled shadow.
  Neither a preset name nor the presence of an override implies no shadow.
  This pure contract needs review before schema/app/painter wiring.
- Known v1 values must validate before edits/persistence. Bound every descriptor
  to 24 primitive keys, 128-character keys/strings, 4 KiB serialized UTF-8, finite
  numbers, and 2 MiB aggregate styling/provenance per project before history.
  Add a conservative **32 MiB retained styling/provenance cap** across current
  project, complete proposed candidate, past/future snapshots and all app-owned
  clipboard/preview copies. Charge each retained project/copy occurrence without
  assuming shared-object deduplication or counting only the active sequence.
  Preflight this whole set **before clearing redo or mutating history/clipboard**;
  failure leaves all prior owners/history untouched. Check capture, import,
  split/merge, duplicate, Apply, save/recovery and undo/redo admission. This is a
  byte ceiling for new style/origin payloads, not total project or browser memory.
  Unknown future versions/keys within the envelope survive save, load, undo,
  split and duplicate unchanged. The entire unknown override is unavailable,
  not partly interpreted. Preview reports the fallback; burned-in export blocks
  enabled unavailable styling. Plain subtitle-file export reports style loss.
- New custom-style layout uses one caption-only resolver for supported canvas
  sizes. Respect margins and the existing eight-active-cue bound. Run visible
  overflow/contrast diagnostics; never claim that arbitrary 4,000-character
  cues fit. Do not change the wrapping or placement of historical presets.
- Optional `CaptionTrack.origin` will record one versioned transcription run:
  model id/revision and manifest digest, runtime version, explicitly requested
  language, source asset id/fingerprint, source sample range/rate and target
  frame offset. Optional cue `origin` keeps its source sample span and a run
  identifier. It contains no PCM, model bytes, file handles, cache addresses,
  object URLs, fabricated probability or confidence. Text/timing edits retain
  the historical origin; the UI labels it as generated origin, not present
  accuracy. Splits retain origin, compatible merges preserve it, mixed-origin
  merges require a visible provenance-loss choice or reject.

## ASS contract for review

Implement pure `src/domain/captionAss.ts`; do not add a renderer/library capable
of executing ASS effects. Use a discriminated parse/export report with bounded
diagnostics `{severity, code, line, cueIndex?, field?, detail}`. Retain at most
100 detailed diagnostics plus exact aggregate counts; cap individual excerpts.

The first supported profile is UTF-8 ASS v4+, with BOM/CRLF normalization,
`[Script Info]`, explicit positive `PlayResX`/`PlayResY`, `[V4+ Styles]`, and
`[Events]`. Require exact, duplicate-free supported `Format` columns; parse
Dialogue by its declared columns while allowing commas only in the final Text
field. Require valid nonnegative `h:mm:ss.cc`, exclusive positive ends, unique
bounded style names and references. Apply the existing 4 MB input-byte / 2 M
character limit, 20,000 cues per file, 4,000 text characters per cue and document
budgets. Add at most 256 styles, 256 characters per style name, 4 KiB per style
record and 32 whole-cue prefix tags / 512 characters per override block.

Supported style semantics are generic font family, size, primary/outline colors
including ASS alpha inversion and BGR ordering, bold, italic, bounded outline,
horizontal/vertical alignment and margins scaled from the declared script
resolution. The legacy caption box is not a promise of libass BorderStyle=3
pixel parity: opaque ASS boxes stay unsupported in this profile. Static
whole-cue prefix overrides for `b`, `i`, `fs`, `c`/`1c`, `3c`, `bord`, and `an`
may map to the same descriptor; changes after visible text, drawing/karaoke,
position/motion/clip/transform/fade tags, font attachments, nonzero layers,
scroll/banner effects and unknown sections must be reported explicitly.
`\N` is a supported hard line break. `\n` soft wraps and `\h` nonbreaking spaces
need a loss report where existing whitespace wrapping cannot preserve their
meaning. Literal braces/backslashes must have an unambiguous supported escape;
otherwise reject export of that cue with an actionable explanation.

Default import is strict and commits nothing on unsupported appearance/text
semantics. A separate explicit “Import supported fields” review may list and
accept losses, including a named font → selected generic-family substitution.
Never silently infer fonts, strip tags, change layer order, or execute raw data.
Metadata comments that do not affect output can be ignored with an informational
summary. Persist supported semantic data only after the loss review; do not
pretend unsupported source constructs have round-tripped. Language/role remain
explicit track metadata because ASS has no matching portable standard fields.

ASS time uses centiseconds, not the SRT/VTT millisecond path with a new separator.
For rate `num/den`, import starts as `floor(cs*num/(100*den))` and ends as
`ceil(cs*num/(100*den))`, using BigInt and checked integer frames. Export starts
with `ceil(frame*100*den/num)` and ends with
`floor(endFrame*100*den/num)`, then **re-import both boundaries to prove exact
frame equality and positive duration**. If that fails, strict export rejects;
an explicitly reviewed lossy export may instead round coverage outwards and
report original/exported frame ranges. Never promise arbitrary-frame exactness
above the centisecond grid. Supported round-trip means semantic text, supported
style values and frame ranges survive export→import; it does not mean original
bytes, comment/order formatting, source ids or pixels in another renderer.

Export uses deterministic style deduplication/names, stable cue order and
canonical colors/numbers. Verify representability of normalized size, margins
and outline values as well as time; values outside the declared style subset
must reject or enter the explicit loss report, never silently quantize.
SRT/VTT parsing stays unchanged; stripping newly added
styles/provenance during their export is disclosed without changing their
plain-text/timing payload. Test supported ASS at 24/25/30/50/60 and NTSC rates,
one-frame intervals, exact/end-exclusive boundaries and explicit high-rate loss.

## Pure batch authoring

Add `src/domain/captionBatch.ts` with one immutable proposal authority, accepting
an explicit ordered set of cue ids and a discriminated operation. Scope choices
are selected cues, selected-and-following, or all cues in one named track. Never
bind a proposal to transient DOM row indices. The proposal contains the candidate
doc plus a bounded before/after preview, counts and diagnostics; it owns no
resource. The app pins project generation, active sequence, exact document and
selection, then revalidates before the store commits once. Rejected, stale or
unchanged proposals preserve undo/redo by reference.

| Operation | Deterministic rule |
| --- | --- |
| Shift | Signed integer delta; no clamping across frame zero or the maximum. Preserve ids/styles/origin. |
| Stretch | Explicit integer anchor and positive reduced numerator/denominator, each ≤1,000, ratio 0.1–10. Transform both boundaries independently with signed BigInt floor/ceil. Reject overflow/invalid overlaps atomically. |
| Split | Explicit frame/text-boundary split plans, with an optional UI generator for maximum-duration/word-boundary splits. Preserve the left id; reserve right ids against the whole project before mutation. Show all generated timing/text changes before Apply. |
| Merge | Selected adjacent touching cues only. Earliest cue id survives; newline-join text. Require equal effective style and compatible provenance, or a separately explicit loss choice. Validate text/overlap budgets before history. |
| Find/replace | Bounded literal search/replacement; no user regex or unbounded backtracking. Preview hit/cue count and whole candidate before apply. |
| Case | Explicit Unicode `toUpperCase` / `toLowerCase`, independent of host locale; expanded output must remain within bounds. |
| Reading speed | Count Unicode code points including spaces but excluding line breaks; calculate characters per rational second from integer duration. Show the count rule and configurable advisory threshold (default 17 CPS), not a universal accessibility/quality guarantee. |

Keep existing single-cue actions usable. Expose keyboard multi-selection, a
visible scope summary, labelled inputs, focus-contained previews, Escape/cancel,
announced progress/results and 360/720/1280 px layouts. Small-screen scrolling
must keep the selected cue and Apply/Cancel reachable. No mouse-only operation.

## Speech decision and exact lifecycle

The measured candidate is documented in
[the model decision](evidence/issue201/MODEL_DECISION.md) and machine-readable
[replacement manifest](evidence/issue201/replacement-manifest.json). The current
lab candidate uses Transformers.js 4.2.0 and the exact WASM-only ORT closure
documented in [replacement preflight](evidence/issue201/REPLACEMENT_PREFLIGHT.md);
the initial 3.8.1 measurements are retained as superseded evidence.
This first review **does not grant speech enablement**: complete offline assets,
actual browser transfer/cache/resident measurements, transitive notice review,
real transcription and cancellation still require Gate 1's exclusive lab.

Proposed first product scope: one explicitly selected connected source with a
primary audio stream, a source-time window of 1–300 seconds and a user-chosen
integer insertion frame in the active sequence. This transcribes the named
source, not the finished sequence mix. It never guesses retimed clip placement.
Offer explicit language selection from the pinned model's supported language
tokens. Automatic language detection, word-level confidence and text translation
are not required for this first path. Disclose tested languages separately from
the model's advertised multilingual capabilities.

- `app/captionTranscriptionController.ts` owns the request generation, source
  binding, Files/Blobs, job admission, model selection/cache and review draft.
  `state/captionTranscriptionStore.ts` stores only serializable progress/status.
  UI calls the app facade and never imports a worker/pipeline directly.
- Proposed narrow architecture exception: a dedicated
  `workers/caption-transcription.worker.ts` imports only its reviewed
  `pipeline/captionTranscriptionProtocol.ts` and bounded audio-preparation
  implementation, domain data and the pinned external runtime. Obtain explicit
  review before updating ARCHITECTURE.md/its static guards. No lab import enters
  production.
- Stream native decoded samples sequentially and close each AudioData/Input/
  iterator in finally. Use existing canonical channel fold-down and a bounded
  anti-aliasing resampler to mono 16 kHz. Never full-file `decodeAudioData`,
  capture microphone audio, upload a URL, or feed the 200 Hz alignment signal.
  Retain at most two 30-second Float32 windows (3,840,000 bytes total) and at
  most 2 MiB preparation scratch. Submit one model window at a time; the SDK's
  whole-file chunker must not retain features for every window. Proposed overlap
  is five seconds with an explicit owned central interval and deterministic
  timestamp/text seam review; boundary uncertainty remains visible.
- One job, one decoder, one disposable model worker, batch size one, q8 WASM,
  one runtime thread, at most 448 generated tokens/window and a 120-second
  deadline/window. These are input/work limits, not total browser-memory caps.
  Essential playback/export preempts speech rather than losing capacity; the
  ordinary editor can run without a model.
- Treat model timestamps as approximate source evidence. Validate finite,
  ordered segment endpoints in the source window, convert at the declared
  timestamp/sample boundary to rational integer target frames, and reject or
  separately present untimed text when an endpoint is absent. Do not invent
  confidence, silent missing tails or source-time certainty. Output remains a
  review draft until one fresh budget-checked history operation creates ordinary
  editable cues. Cancellation produces no project edit.
- Cancel on retry/supersession, close, project or sequence replacement, source
  relink/change, clearing local derived data, or essential resource preemption.
  Terminate a busy WASM worker; otherwise await bounded cooperative disposal
  then terminate at a 100 ms deadline. Retain scheduler admission until worker
  termination and parent-owned cache transactions have drained/rolled back.
  Reject late request ids/generations, detach late transferred PCM, clear bounded
  results and revoke owned URLs. Record termination separately from an observed
  cooperative-zero ledger. The lazy teardown seam must not import speech on
  projects that never requested it.

## Optional spelling and translation

Propose no bundled dictionary/translation model in #201. Show explicit
“Local spellcheck unavailable — no reviewed language pack” status and preserve
manual editing. Set browser native spellcheck off for caption text: browser
enhanced checking cannot be treated as a proven no-upload local engine. No
browser/cloud translation or generic browser SpeechRecognition fallback.
Optional pack support needs its own asset/license/language/quality decision;
its absence is recorded as an optional omission, not called implemented.

## Gates, commits and proof

| Gate | Work and required evidence |
| --- | --- |
| 0 — this review | Bounded scope/contracts, current source evidence, measured candidate package/model hashes, focused unchanged-caption baseline; local plan commit and orchestration report. Stop before product changes. |
| 1 — separate speech lab | Exclusive slot; pinned asset/license/network audit, real source-bound English plus one non-English fixture, silence/unsupported input, cold/warm/offline/cache/quota/cancel/retry/teardown, transfer/cache/process-memory and deadlines. Record GO or NO-GO before speech is enabled. No production imports. |
| 2 — semantic/ASS foundation | Assigned migration, style/provenance validation, unknown-intent preservation, pure ASS and batch operations, project/sequence identity/history checks; focused tests/build/lint and local commit. |
| 3 — caption authoring | ASS loss review/import/export, track/cue controls, batch previews, diagnostics/accessibility/responsive surfaces, legacy caption pixel checks, preview/export parity; focused tests/build/lint/browser and local commit. |
| 4 — optional speech product | Only after Gate 1 approval: local selection/acquisition/cache, worker audio/runtime ownership, stale-safe editable cue review/apply, lifecycle and offline surface; focused tests/build/lint/browser and local commit. |
| 5 — full acceptance | Exclusive full suite and Chromium checks; build/typecheck, lint, production audit, diff checks, report source/fixture hashes and exact branch SHA. No push/PR/merge/issue closure by this worker. |

The model lab and independent caption foundations can be sequenced by the
orchestrator after Gate 0. A speech NO-GO does not silently complete #201; report
the unmet mandatory speech/browser criteria and request the actual scope decision.

Real Chromium must cover supported/lossy/malformed ASS; all batch operations and
stale-preview rejection; undo/redo; track/cue styles at landscape/portrait/small
canvases; cue editing and burn-in export through native decode; save/reopen;
local transcription; acquisition/local selection; cancel/retry; offline/no-model;
quota/corrupt cache; and project replacement with cleanup/network evidence.
Run muted headless Chromium on port 5201. Do not claim broader browser/hardware,
language quality, peak memory or baseline failures without direct evidence.

Gate 0 validation: unchanged source passes 5 focused caption files / 34 tests
plus all 17 repository runner checks. See
[initial evidence](evidence/issue201/INITIAL_GATE.md). Full tests, build, lint,
production audit and browser product acceptance remain future completion gates;
no product runtime or dependency changed in this initial commit.
