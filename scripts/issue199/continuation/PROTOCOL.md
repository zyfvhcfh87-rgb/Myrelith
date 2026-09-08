# Issue 199 — bounded Animation continuation

Status: **source-only large-fixture provenance correction; root review and an explicit native handoff are required.**
The supervisor accepted `095e6d9463580e3502ba7c210d3982bed548a52f` as the
six-checkpoint early pass, not all of Gate 3. The early runner and its attempt
evidence remain unchanged. This protocol implements the remaining scope in
`docs/evidence/issue199/gate3-browser-protocol.md` without relaxing its bounds.
Each selected segment needs source/protocol review and a separate explicit slot.

## Exact source and fixtures

Product source: `75b89ef6b70460a03ea99ca44d888b5ec06373ec`, on the frozen
`4340f9675ad56aa320f2498cf107fd55f8819568` integration lineage. There is no
midpoint integration or product/configuration edit in this checkpoint.
`../observation-source-hashes.json` pins all 242 source/test/configuration files.
`checkpoint-hashes.json` additionally pins this protocol, both manifests, all
four portable fixtures, their preparation scripts, and every continuation module.
The actual committed harness HEAD and every source/build hash are recorded at run
time. A dirty worktree, changed product/configuration file, mismatched hash, or
occupied port 5199 fails preflight before browser launch.

| Portable fixture | Bytes | SHA-256 |
| --- | ---: | --- |
| `mixed.myrelith` | 13,379 | `e510cb67197ed771049dea65cfccf02820d4550841f6b32dde9ac6c0f4618ac0` |
| `dense.myrelith` | 7,892,352 | `26814d074c6e94230b1e3004c863d32490bd84cd266123c27720f228b851c574` |
| `many-lanes.myrelith` | 1,070,249 | `2461ff539f8db3515c5845dbdbe1d3427fbe792d8a852906c6504f74221fda4c` |
| `continuation/dense-scalar.myrelith` | 7,892,325 | `2518406e6d2759bb7a8cdceb0d2d555ec460c0e34130325fa61f4b9b775dadbf` |

The original three fixtures retain their original bytes and generation provenance
at `87d8032f25ef469449d59741fba56d1b76eda6aa`. The supplemental generator uses
the canonical parser/serializer at b33b753 through a non-listening Vite SSR host.
It replaces one unavailable 1,024-key effect lane with an available opacity lane,
retaining exactly 100,000 authored keys and the other unavailable lanes. Generation
verified 1,024 exact scalar keys from 0 through 1,023, 255 canonical curve points,
32 glyphs under a budget of 32, and an exact canonical parse/serialize round trip.
These are fixture/domain checks, not browser or performance observations.

The large segment pins the supplemental generation identity explicitly to
`b33b7531027979b8886f5db979d57cd96b96175d`. Its independent runtime checks still
require executing product `75b89ef6b70460a03ea99ca44d888b5ec06373ec` and all frozen
source/checkpoint hashes. `report.largeFixtureSources` records both identities;
they describe different stages and are not compared for equality. The intervening
product diff contains only the accepted AnimationWorkspace cancellation fix and
its test; fixture generators and domain code did not change. No fixture or
generation manifest is regenerated or rewritten for this correction.

The mixed fixture includes video opacity, clip audio Volume/Balance, adjustment
scalar/effect keys, expanded-title element opacity, held mask paths, future
property versions, and orphan effect intent. Its media keyframes carry exact
`sourceTimeTicks`, including -150,000,000 at local frame -150 and 200,000,000 at
local frame 200. Its media source map retains a 60,000,000-tick span. Source
assets remain intentionally offline in the original portable files; Chromium is muted.

For the gestures segment only, `../prepare-playback-fixture.mjs` generates the
supplemental `../fixtures/playback/mixed-playback.myrelith` and a local PCM WAV.
The original audio descriptor has `size: 1`; canonical Relink requires exact byte
size, so the supplemental file changes only `audio-asset.size` to 5,760,044.
Canonical comparison restores that one field and requires full equality with
the original. All sequences, clips, animation, mute/enabled settings, history
expectations and the four original portable byte hashes are preserved.

The WAV is exactly 30 seconds, 48 kHz, stereo, signed 16-bit little-endian PCM:
1,440,000 sample frames, a 44-byte header and 5,760,000 data bytes. Its non-silent
250 Hz integer triangle has opposite stereo channels and peak 1536/32768.
SHA-256: `f674326cc658930dc9eb01b1388aca7e7f9a0e7bedc3fb58b49803f01a133859`.
The playback portable copy is 13,385 bytes, SHA-256
`8a067088cd5c007ea701d3af702626dc15aa880086e359a56c1629868dc8ae6b`.
The separate playback manifest records the exact generator, data hash, metadata
probe and canonical checks. Host demux/metadata validation is not native playback
or a PCM output oracle.

Setup opens that supplemental file through the existing Open UI, then supplies
the WAV to the existing audio row's actual **Relink once** file input. This invokes
`connectActiveAssetMedia` and its canonical browser inspection/matching path.
There is no direct store connection or document mutation API in browser setup.
Require the row online, one connected source, exact audio metadata, the original
enabled clip/gain, zero history, and unchanged project/history/clipboard references
across relink. This precedes the gesture history checkpoints. Native Play/Pause
and every cancellation/immutability assertion remain unchanged. The final project
departure still reopens the original two-offline file, with no later playback.
Editing and large segments retain their original setup and separate gates.

The canonical project audio plan contains only `ordinary-audio` / `audio-asset`
on root frames [0,60); the dormant sequence has no audio dependency. Both titles
are procedural. The other offline asset, `fixture.mp4`, has no audio and its clip
begins at frame 120. Each playback cancellation is positioned at frame 1. The
existing preview path skips absent video source keys and reports offline visual
status if that later clip is reached; no audio resolver needs it. No additional
source is removed or muted. The strict warning/page-error gate still applies,
including to relink inspection, waveform generation and real transport startup.

## Three independently selectable runs

From this private worktree, after the corresponding explicit grant, set
`DEVELOPER_DIR=/Library/Developer/CommandLineTools` and
`NODE_OPTIONS=--no-experimental-webstorage`, then select **one**:

```sh
node scripts/issue199/run-animation-continuation.mjs --segment gestures
node scripts/issue199/run-animation-continuation.mjs --segment editing
node scripts/issue199/run-animation-continuation.mjs --segment large
```

There is no `all` mode and no automatic transition to the next segment. Each run
builds the pinned production source, opens only a private localhost 5199 preview,
and starts a fresh muted headless Chromium persistent context under its unique
`/private/tmp/issue199-continuation/<timestamp>-<segment>/chromium-profile`.
Persistent context is used to give OS process ownership an exact private-profile
identity. It does not use a saved user browser profile or create a visible window.

| Segment | Remaining acceptance exercised |
| --- | --- |
| `gestures` | Native key movement with exact frame delta, admitted preview without history, one release commit, undo/redo; both Bézier handles with preview/one commit/undo. Each of key/handle 1/handle 2 cancels under Escape, actual lost capture, Back, sheet/curve change, key selection, viewport zoom, playback, document undo, and sequence switch. Named sibling preview restoration, then deliberate project departure during capture and pristine portable reopen. |
| `editing` | Fresh Timeline and Inspector entry at 720×900, Back focus, native input A/C/V/Z, full-sequence and selected/animated/kind/text filters, exact negative and beyond-duration numeric edits, Home/End/previous/next/Shift/toggle. Native Set, scalar/audio values, Hold/Linear/Bézier, invalid draft reset and focus, curve holds and both axes, keyboard move/duplicate/delete, held-path timing and zero scalar samples, unavailable/future/title-effect guards. Complete paged scalar mapping across title clip/video/adjustment, compact mapping controls, incomplete/incompatible/collision refusal, title-element cut and original/relative paste, explicit video-effect to adjustment-effect mapping, locked edits, canonical save and real file reopen with full payload equality, sequence switch, and dock reopen. |
| `large` | Fresh 100,000-key portable open and first dock/index/render observation; exact last access and 1,024-key selection; refusal beyond 4,096 selections; ten playhead ticks; changed warm filters, native vertical scroll and pinned focus; available 1,024-key scalar curve at both viewports; native 1,024-selected preview/release/undo with ghosts counted. Then 1,280 effect lanes plus 1,000 empty owners, exact dormant -100/1,000,000 keys, bounded virtual rows with pinned focus, and a distant nonanimated owner beyond global frame 9,000,000. |

## Native versus API qualification

| Mechanism | What this qualifies |
| --- | --- |
| Playwright mouse down/move/up and keyboard press/down/up | Native browser input for gestures and shortcuts. A read-only document observer requires a trusted pointer-down and actual `hasPointerCapture`; no fabricated pointer event or direct animation edit command substitutes for the gesture. |
| Locator click/fill/selectOption/setChecked/focus/scrollIntoView and setInputFiles | Actual application DOM controls and portable-open flow. These are browser automation operations; they do not qualify an OS file picker, screen-reader speech, or a physical keyboard/IME. Accepted early evidence separately used Chromium `Input.imeSetComposition` and `Input.dispatchKeyEvent` for IME containment. |
| Actual captured element `releasePointerCapture`, then one native pointer move while held | The release request clears pending capture. The following real move processes pending capture; require trusted capture/loss on the same pointer and element, no mouseup, then a cleared preview and unchanged document/history/clipboard before release. This trigger combines a browser API call with native input. |
| Production `setPlayheadFrame` | Explicit transient scenario positioning and ten playhead updates. Native transport-button playback/pause is separate. This does not claim native Timeline seeking or continuous playback index measurement. |
| Production `setColorGradingPreview` / `setMaskPreview` | Explicit sibling-preview setup/restoration around a native Animation drag. It checks the three owners present at 75b89ef. It does not qualify native grading/mask authoring, the later fourth tracking owner, or later title-effect helper parity. |
| Already-requested production module exports | Read-only store/history/clipboard observations plus the explicitly named transient setup above. No dev module, product test route, bundled-code replacement, or document edit API is injected into the page. Diagnostic project/history references retain at most four checkpoints and are cleared on portable project replacement. |
| Canonical host snapshot/serializer/parser followed by UI reopen | Portable-file round trip of the actual mixed edits, with exact full project payload equality and explicit negative source-time intent. No native Save/Save As picker or downloaded-media claim. |
| Component spy and pure indexed-read tests | Exact index-build reuse across playhead updates and bounded indexed reads. The unmodified browser bundle exposes no public build counter, so browser checks establish stable document/history and DOM bounds, not a separately measured browser rebuild count. |

## Bounds, evidence, and stopping

The hard limits remain **40 mounted rows**, **512 total key glyphs including
preview ghosts**, and **256 samples per scalar curve**. They apply after settled
frames during the specified scroll, zoom, selection, preview, commit, and compact
layout observations. Document-level horizontal overflow fails. Exact keyboard
focus is checked through the real numeric field and active-descendant text,
including virtualized/pinned rows. No production limit or fixture scale is raised
or reduced to make a case pass.

Raw portable-open, first dock/index/render, changed filter, native wheel, preview,
and release durations include automation and two animation frames. They are
observations without an invented threshold, pure-index timing, heap measurement,
hardware-GPU assertion, or inference from Vitest duration.

Every successful checkpoint saves a screenshot, DOM text, raw detail and elapsed
wall time; the trace contains snapshots and screenshots. Console warnings/errors
and page errors fail acceptance. Only the exact private-fixture unsaved-changes
confirmation is accepted; any other dialog fails. The first failed assertion
stops the segment and preserves failure screenshot, DOM, full state, trace, source,
fixture, build, browser/runtime, and process evidence. A segment pass is not whole
Gate 3 acceptance.

Cleanup closes the context, stops the owned preview and records the current
private-profile process tree before/after. Any fallback signal requires a fresh
match on PID, start time, and command from the observed owned profile/tree; a
reused PID, unrelated profile, runner, or host process is never a target. Cleanup
must show no remaining owned process and no 5199 listener. It rechecks clean source
and all hashes plus final console problems before marking the slot released. A
cleanup failure denies acceptance. Process-selection unit tests are not a claim
that native browser cleanup has already executed.

A product or harness failure retains its original attempt. Corrections require a
separate source checkpoint and reviewed rerun; accepted commits are not amended.
No continuation, performance run, export, full suite, or audit is authorized by
this source checkpoint alone. Later Gate 4 still covers integrated retime/split,
title/path rendering, muted playback, exact pixel/PCM/export oracles and saved
project behavior after the required integrations. Gate 5 remains the full
canonical suite, build/lint, production audit, and final source checks.

## Capture-event correction after the first gestures attempt

The original gestures run at `379634405c15b1e553c1e36996aac6ac83e61d39`
passed six checkpoints and stopped on the first capture-loss assertion. Its
unchanged evidence remains at
`/private/tmp/issue199-continuation/2026-09-08T16-36-07.724Z-gestures/`.
It asserted cancellation after `releasePointerCapture` and two animation frames
without proving that `lostpointercapture` had been delivered. No confirmed product
defect or passing capture-loss result follows from that attempt.

[Pointer Events 3 section 9.3](https://www.w3.org/TR/pointerevents3/#releasing-pointer-capture)
clears the pending capture target; [section 4.1.3.2](https://www.w3.org/TR/pointerevents3/#process-pending-pointer-capture)
dispatches capture events when processing subsequent pointer input or implicit
release. The corrected capture case issues one real pointer move with the button
still held. It requires the same pointer/gesture and element identity, trusted
capture followed by trusted loss and a native move, and zero pointer-up events.
The original exact preview/document/history/clipboard assertions run before and
after eventual mouseup. It does not replace cancellation with mouseup, synthetic
DOM dispatch, or a longer wait.

The passive event ring remains bounded at 256 records. Monotonic event sequence
and gesture IDs distinguish previous events and reused mouse pointer IDs; records
include target identity comparison, trust, buttons and coordinates. Failure state
now preserves this ring and the current pointer/capture state, as success already
does. Product source, other gesture actions, bounds and slot rules remain unchanged.
This correction requires separate source review and a new native execution grant.

## Mode-fix source repin

Current product source is accepted `75b89ef6b70460a03ea99ca44d888b5ec06373ec`. The continuation
actions/assertions remain identical to reviewed `7e7cfade097446c6f68219919fac838a8134f664`;
only source identity and diagnostic provenance labels change. Prior source and
checkpoint manifests are preserved under `docs/evidence/issue199/mode-repin/`.
All earlier attempt evidence and all four fixture bytes are unchanged. Fixture
generation remains recorded at its original source, including the supplemental
b33b753 provenance. Only gestures is granted now; editing/large fixtures and
qualification are subject to their later separate review/slot.
