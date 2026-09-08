# Issue 199 — bounded Animation continuation

Status: **source and fixture checkpoint for review; no continuation has run.**
The supervisor accepted `095e6d9463580e3502ba7c210d3982bed548a52f` as the
six-checkpoint early pass, not all of Gate 3. The early runner and its attempt
evidence remain unchanged. This protocol implements the remaining scope in
`docs/evidence/issue199/gate3-browser-protocol.md` without relaxing its bounds.
Each selected segment needs source/protocol review and a separate explicit slot.

## Exact source and fixtures

Product source: `b33b7531027979b8886f5db979d57cd96b96175d`, on the frozen
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

The mixed fixture includes video opacity, clip audio Volume/Balance, adjustment
scalar/effect keys, expanded-title element opacity, held mask paths, future
property versions, and orphan effect intent. Its media keyframes carry exact
`sourceTimeTicks`, including -150,000,000 at local frame -150 and 200,000,000 at
local frame 200. Its media source map retains a 60,000,000-tick span. Source
assets remain intentionally offline; Chromium is muted.

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
| Actual captured element `releasePointerCapture` | Browser capture-loss behavior with the native lost-capture event. This cancellation trigger is a browser API call, not a physical pointer action. |
| Production `setPlayheadFrame` | Explicit transient scenario positioning and ten playhead updates. Native transport-button playback/pause is separate. This does not claim native Timeline seeking or continuous playback index measurement. |
| Production `setColorGradingPreview` / `setMaskPreview` | Explicit sibling-preview setup/restoration around a native Animation drag. It checks the three owners present at b33b753. It does not qualify native grading/mask authoring, the later fourth tracking owner, or later title-effect helper parity. |
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
