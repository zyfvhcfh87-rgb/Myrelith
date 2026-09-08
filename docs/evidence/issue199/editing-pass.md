# Issue 199 — editing segment passes 13 of 13 checkpoints

One explicitly granted editing run passed at clean HEAD
`a70d0c24a57ca04fa488f3ae0a8819b4fc995f19`, with the unchanged
`d16cca49617a8a32cc820d63345404133b70eb12` harness and
`75b89ef6b70460a03ea99ca44d888b5ec06373ec` product. The parent accepted the
13-checkpoint result after reviewing raw steps, round-trip evidence, representative
images and independent release. **Full Gate 3 remains open.**

The run lasted 15.266 seconds, from 2026-09-08T18:43:43.397Z through
18:43:58.663Z. Chromium 151.0.7922.34 ran headless and muted with a fresh private
profile, localhost 5199 production preview and command-scoped `caffeinate -is`.
All 242 product and 55 checkpoint hashes, including the four original portable
fixtures, matched before launch and after release. The clean SHA was recorded
before launch. Product, harness, actions, assertions and fixtures were unchanged.
The production build passed with its existing chunk-size advisory retained.

## Observed acceptance

All 13 checkpoints passed, with zero console warnings/errors or page errors:

- Actual original mixed-fixture open and native clip selection.
- Timeline and Inspector entry at 720×900, reachable Animation controls and Back
  focus; native select/copy/paste/undo inside numeric input stayed contained.
- Full-sequence filters, exact negative and beyond-clip keys, Shift ranges and
  native selection toggle.
- Create, scalar/audio values, Hold/Linear/Bézier, invalid-draft reset, native
  numeric fields, and keyboard move/duplicate/delete.
- Held paths retained geometry-editing limits; unavailable, future-version and
  title-effect intent retained its guards.
- Complete cross-owner mapping, incomplete/incompatible/collision refusals,
  undo, title cut and original/relative paste, and explicit clip-effect to
  adjustment-effect mapping preserved parameter identity and authored spacing.
- Locked-track edits preserved document/history/clipboard references.
- Canonical portable save followed by actual file-open UI preserved the complete
  authored project payload, negative source-time intent, sequence switching and
  workspace reopen behavior.

Across 16 structural observations at widths 720 and 1440, maxima were 14 mounted
rows, 8 glyphs including ghosts and 252 curve samples, with no horizontal page
overflow. The native actions qualify Animation controls at 720 pixels. Clipping
in the surrounding workspace shell remains visible; this is not a full-workspace
responsive-layout pass. Large-fixture bounds and performance remain separate.

## Portable round trip

The actual edited project was snapshotted, serialized and parsed with canonical
host domain APIs, then reopened through the real portable-file UI. This is not a
native OS Save picker or media export claim. The sole dialog was the exact allowed
private-fixture unsaved-changes confirmation.

`animation-authored-roundtrip.myrelith` is 13,765 bytes, SHA-256
`3547859f01dccdba870d49250864813b159cbf5fd498fe2c219d3cb0a57d5751`.
Full project payload equality passed. The video key at local frame -150 retained
source time -150,000,000 ticks. Its source map retained start 0, duration
60,000,000 ticks, rate 1/1 and the original empty speed curve.

## Evidence and release

Raw evidence remains at:

`/private/tmp/issue199-continuation/2026-09-08T18-43-43.397Z-editing/`

It includes 15 screenshots, 13 step DOM snapshots, the authored portable file,
full result/state/source/build/process evidence, logs, a valid trace ZIP and the
preserved private profile. `artifacts.json` hashes 38 raw top-level files, without
a recursive profile hash claim. `editing-attempt1/evidence-copies.json` maps 23
exact JSON/portable or normalized text copies to raw/copied hashes. Raw files
remain preserved. Worker and parent inspected `step-03.png`,
`compact-mapping.png` and `portable-roundtrip.png`; no all-images review is claimed.

**Exclusive slot released at 18:43:58.625Z.** The context closed, preview exited
143, no fallback signals were needed, no owned process remained, and port 5199
was clear. Independent verification at 18:46:25.452Z confirmed all seven PIDs
absent: preview 1044, Chromium 1046/1048/1049/1050, runner 960 and scoped awake
helper 983. The parent independently verified all seven and port 5199 clear.
No actual sleep/wake transition occurred during the run, and no persistent
power/display setting changed. All 242 source and 55 checkpoint hashes matched.

The accepted 34/34 gestures evidence and all prior failures remain unchanged.
There was no native rerun, large segment, export, full suite, performance run or
integration sync. Later title-helper/five-preview-owner integration and mixed
pixel/PCM gates remain open.

Before a future large-segment grant, the existing source-provenance guard needs
review: `observations.mjs:514` compares the supplemental fixture's generation
`productSource` directly with the current product. Its preserved generation
manifest records `b33b753...`, while the current product is `75b89ef...`. Those
values differ. No assertion, fixture or provenance change was made here; the
large segment was not run.
