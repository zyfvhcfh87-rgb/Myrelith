# Issue 199 — gestures segment passes 34 of 34 checkpoints

One explicitly granted gestures run passed at harness
`d16cca49617a8a32cc820d63345404133b70eb12`, product
`75b89ef6b70460a03ea99ca44d888b5ec06373ec`, on the frozen integration lineage.
The parent accepted the exact source/protocol/fixtures before execution and
accepted this result after reviewing the raw evidence and independent cleanup.
**This is gestures acceptance, not full Gate 3 acceptance.**

The run lasted 22.161 seconds, from 2026-09-08T18:30:49.647Z through
18:31:11.808Z. Chromium 151.0.7922.34 ran headless and muted with a fresh private
profile, a localhost 5199 production preview and command-scoped `caffeinate -is`.
The clean SHA, 242 product hashes and 55 checkpoint hashes were verified and
recorded in the owned report before launch. No reviewed action or assertion
changed during execution. The production build passed; its existing chunk-size
advisory remains in the build log.

## Observed acceptance

All 34 checkpoints passed, with zero console warnings/errors or page errors:

- Actual supplemental portable open and Media Pool Relink-once input connected
  the deterministic PCM under existing `audio-asset`. The real browser inspection
  and canonical relink path accepted its exact metadata and source extent.
  Project/history/clipboard references stayed unchanged across relink, with zero
  history and the original enabled audio clip/gain.
- Native key movement showed preview without history, an exact 40→49 frame move,
  one release commit, and exact undo/redo. Both Bézier handles showed preview,
  one release commit and exact undo.
- All 27 cancellation combinations passed: key/handle 1/handle 2 against Escape,
  capture loss, Back, mode change, selection, viewport zoom, actual playback,
  document undo and sequence change.
- Real Play/Pause button actions passed for all three targets, including playing
  state, cancellation, immutable document/history/clipboard and paused state.
  No offline-source warning was suppressed or waived.
- Named sibling preview ownership restored correctly, followed by captured
  project departure and real reopen of the original two-offline portable file.
  Original keys [0, 40, 80], cleared preview and cleared clipboard were verified.

Actual capture proof retains trusted capture/loss events on the same pointer and
element, followed by a native move while held, no intervening pointer-up, capture
false, and exact immutable state before and after release:

| Target | Gesture | Got capture | Lost capture | Following held move |
| --- | ---: | ---: | ---: | ---: |
| key | 5 | 61 | 66 | 67 |
| handle 1 | 14 | 202 | 207 | 208 |
| handle 2 | 23 | 357 | 362 | 363 |

Across 33 structural observations, maxima were 1 mounted row, 4 glyphs including
ghosts, and 254 samples in a scalar curve, with no horizontal page overflow.
These are this small gestures fixture's observations under the unchanged
40/512/256 limits; they do not qualify the separately gated large fixtures.

## Evidence and release

Raw evidence remains at:

`/private/tmp/issue199-continuation/2026-09-08T18-30-49.647Z-gestures/`

It includes 34 screenshots, 34 DOM snapshots, exact result/events/metadata,
build/server/console logs, source/build hashes, native process samples, a valid
trace ZIP and the preserved private profile. `artifacts.json` hashes 76 raw
top-level files; it does not claim a recursive profile hash. Exact JSON and
normalized text copies are in `gestures-attempt4/`; `evidence-copies.json` maps
42 copies to their raw and copied hashes. Raw originals remain untouched.
The worker inspected screenshots 02, 30 and 34; this is not an all-images review.
The parent independently inspected representative screenshots 12, 16, 25 and 33.

**Exclusive slot released at 18:31:11.771Z.** The context closed, preview exited
143, no fallback signals were needed, no owned process remained, and port 5199
was clear. Independent checks at 18:32:38.946Z and 18:34:21.889Z confirmed:

- Preview server 98032 and six Chromium processes
  98034/98035/98036/98037/98076/98077 absent.
- Runner 97958 and scoped awake helper 97969 absent; no matching private profile
  or awake command remained.
- All 242 product and 55 checkpoint hashes still matched, with clean observed
  source and no actual sleep/wake transition during the run.

The parent separately verified all nine PIDs and port 5199 clear. No persistent
power/display setting changed. An initial sandboxed post-run `ps` read was denied
by the filesystem/process sandbox; the authorized read-only identity check then
succeeded with escalation. This did not alter the run or its console result.

The original three failed gestures attempts, their source checkpoints and raw
evidence remain preserved. No further native run, editing/large segment, export,
full suite, performance run or integration sync occurred for this checkpoint.
Editing is queued for a separate explicit handoff after the other task's granted
build. Large-fixture acceptance, later integrations and full Gate 3 remain open.
