# Remaining #200 acceptance — scoped evidence map

Read against the actual issue body in the orchestration `issues.json` snapshot
(issue updated 2026-08-25T21:36:47Z) and `docs/ISSUE_200_PLAN.md`. Current worker
evidence checkpoint: `f8e7370188c32607050bf399981eee22bcce6690`. This matrix does
not claim final combined-branch acceptance or close the issue.
Root reports E integrated at `93eb98f7d6af48bdef1cefba4084a3620ec2aae5`, with its
existing production-source hashes unchanged. Subsequently the supervisor assigned
`580de54f85c877d1d746c9a5b201b1aa4ac3ef4d` for the keyboard gate's surrounding UI.
The worker merged that exact integration without conflicts at `5bca9bf`; the
[executable protocol](keyboard-executable-protocol.md) records the resulting scope.

Evidence keys:

- **A — pure data/budgets:** accepted `381836fa3b45d83f7b7c1f932413b6ac067a154a`
  and corrected `94e95eaa9ce4ba72cc51f9dfdb00d81aec231635`;
  [foundation](pure-foundation.md), [budget evidence](pure-budgets.md).
- **B — portable ownership:** `ecc9db13ebc81c409dd774b538ae63a5012d40a8`;
  [schema23 evidence](schema23-owners.md), 38 focused files/839 tests plus 17 runner
  checks, build/typecheck and lint. Its later shared integration preserves schema24.
- **C — rendering:** tested `9bddfc5248c8b8af26e7e45150272c2d3306af17`, product
  `54581222b3c46208efea47f71a0d865f52778bc9`, accepted result `24eb4e2`;
  [G2 evidence](g2-observable-results.md), 2,772 exact pixel comparisons and 2,754
  line comparisons. Same-runtime generic/context and six readback-warning limits
  apply. Finite exports are pre-encoder.
- **D — authoring:** tested `3d5b39fab76354f2a30f3d834cda3e40ba5461f7`, evidence
  `773f9039fc7324c9e24ab02713551d9d7f9a159e`;
  [six native flows](g3-functional-results.md), including actual recovery, local
  IndexedDB, gestures/capture-loss, generated motion and narrow-dialog staleness.
- **E — fallback first paint:** tested `b7a097707ca1c5bfadc8ba047e9596daf320fcc2`,
  evidence `f8e7370188c32607050bf399981eee22bcce6690`;
  [accepted result](first-paint-results.md), five exact settled comparisons,
  nonblank controls, retained success trace and independently verified teardown.

| Actual issue criterion | Existing exact evidence | Remaining acceptance and owner |
| --- | --- | --- |
| Existing text migrates identically and remains editable | B preserves compact text, exact file/history/recovery boundaries and explicit upgrade. C compares unchanged legacy/current/upgrade pixels and wrapping. D exercises real Upgrade, edits and Undo/Redo. | Covered in staged evidence; root verifies the final integrated source and engineering gates. No repeat migration redesign or forced expansion. |
| Element/order/count/string/font/style/geometry budgets reject before allocation | A validates bounded future-safe data, coupled geometry, 1 MiB title-plus-keys and 64 MiB reference-aware retention. B covers actual all-sequence/file/history admission. C covers pre-layout visible-element bounds and bounded scratch/cache ownership. D adds all-five-preview admission. Root's assigned 580de54 includes the accepted shared preview corrections. | Root owns final combined coverage of the five-owner priority/currentness seam. The retention metric remains serialized-data admission, not measured JS heap. |
| Versioned local templates, fresh identities, no executable content | B proves clone/split/paste/sequence ownership. D and its source tests cover all three builtins, editable lanes, fresh IDs, strict data envelopes, unknown/quota behavior and actual local save/read/use/delete without changing used copies. | Keyboard dialog/selection paths below. Existing real IDB evidence is carried; no duplicate native template lifecycle matrix unless integration changes it. |
| Roll/crawl and all scalars use exact frames across scrub/playback/export | C covers all 13 scalars, three easings, sequential/arbitrary seeks, nested owners and raw finite export. D covers real two-key Preview/Cancel/Apply and consented Reapply; domain tests cover trim/split/extend semantics. The accepted shared workspace is now synced from 580de54. | #199's single mixed playback/encoded export/reopen gate, including edited title keys and generated crawl. Title-specific false-positive checks are listed below. No second animation editor or duplicate export run. |
| Font measurement/wrapping/fallback is deterministic or visibly unavailable; portable intent persists | C covers six generic families, complex text, main/worker/raw-export parity and explicit fallback. D preserves literal family/fallback and exact reopen. E proves actual reopened glyph presentation after its early uninitialized buffer. | Carry qualifications; #199 mixed encoded fixture retains the same explicit intent and strict missing-fallback refusal. No remote font fetch, font-byte identity, complete glyph coverage or historical-cause claim. |
| Keyboard, focus, reading order, contrast/status, safe areas, responsive dialogs and accessible manipulation alternatives | Source component evidence covers numeric editing, selection/order, keyboard move/resize and StrictMode lifecycle. D covers actual pointer/capture-loss and one 720×800 motion dialog. | **Open #200 native slice:** [keyboard/focus/title-control protocol](keyboard-focus-proposal.md) at 1280×720 and 720×800. Scope is title control reachability/readability and dialogs; surrounding workspace clipping is recorded separately for root disposition. |
| Real Chromium verifies migrated text, elements, templates, motion, keys, fonts, reopen, export pixels and cleanup | C/D/E jointly cover the listed title paths except final shared #199 UI/encoded integration and the remaining accessibility slice. All completed native runs have explicit cleanup receipts and preserved failures. | Complete the preceding #199 and #200 native slices on their reviewed sources, then root decides combined acceptance. Do not turn focused component evidence into a native UI claim. |
| Focused/full tests, build/typecheck, lint, production audit and diff checks | Each staged checkpoint has focused results and corresponding build/typecheck/lint where required; E adds source-only diagnostic validation. | Root owns the final combined full suite, production build, lint/audit/diff and any baseline reproductions. No worker duplicate full/build/audit run. |

The feasible first-slice title/lower-third/card presets, ordered text/shape styles,
editor-only 90%/95% guides and local-only boundary are included in A–D and the
remaining keyboard slice. No original issue acceptance criterion is dropped.

## Coordination with #199's single mixed export gate

Root relayed the source proposal: one second/30 frames at 1280×720/30 fps, VP9
video retimed 2× and split at 15, 48 kHz stereo, final VP9 WebM 5 Mbps/Opus 192 kbps.
Probes 0/7/14/15/22/29 include MOVE text with named intent/explicit serif, a colored
rectangle, ordinary title tracks and canonical left-crawl keys 0..29. Proposed
decoded/Program limits are RGB MAE ≤8, p95 ≤20, glyph centroid ≤3 px and white
coverage within 15% where present. These remain **unexecuted proposed thresholds**;
the supervisor must review the executable before any grant.

#200's requested safeguards, relayed through root:

1. Fix expected-present/absent probes from canonical geometry before rendering.
   Require nonzero reference glyph coverage at interior frames 14 and 15; never
   let two blank images skip every glyph assertion. Explicitly check the offscreen
   endpoints 0/29 with a preregistered small codec-noise bound and no undefined
   centroid calculation.
2. Isolate glyph evidence from the moving video and colored rectangle using a
   title ROI/mask and independent nonblank text-versus-empty control or controlled
   nonwhite background. Whole-frame average error can miss a small absent title.
3. Bind every Program reference to current project/canvas/generation and exact
   requested frame. Record decoded timestamps and frame selection; a stale or
   adjacent frame cannot qualify the reference.
4. Preserve literal font/fallback, ordinary keys and generated endpoints through
   actual portable save/reopen. Missing-fallback preflight refuses before encoded
   output and releases its owner. Keep encoded-pixel tolerances distinct from C's
   exact raw-render proof.

Root's latest scope clarification supersedes the optional benchmark language in
the earlier broad G4 proposal: **no standalone title timing benchmark is required**.
Existing budget/renderer evidence, the mixed playback/export gate and root's final
engineering checks cover the obligation unless an actual regression warrants more.
