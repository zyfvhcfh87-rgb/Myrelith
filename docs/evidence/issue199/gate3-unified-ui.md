# Issue 199 — unified Animation workspace source (Gate 3)

Date: 2026-09-08. Review this document at its containing commit. Direct accepted
base: `4340f9675ad56aa320f2498cf107fd55f8819568`, including corrected Gate2
`971b511` and schema23 title ownership. No new schema version or peer merge.

## Result

A first-use lazy Animation dock replaces the timeline area when opened from
Timeline, Inspector, effect/grading controls or held-path timing. The workspace
shows the active sequence by track, owner, element/effect and property. Selected
items, animated-only, property-kind and text filters retain full-sequence access.
The old separate scalar curve editor and effect key lists are removed. Existing
mask geometry authoring stays with its accepted mask controller.

The main sheet uses the shared pixels-per-frame zoom, integer timeline origin
and bounded native scroll surface. It mounts at most40 rows including overscan
and one pinned focused row. Across normal and ghost keys it paints at most512
glyphs; dense buckets show total and selected counts. An exact logical focus
with aria-activedescendant survives virtual rows, dense keys and keys outside
clip bounds, including negative local/global frames. Negative global keys stay
reachable through navigation/numeric controls even though the shared viewport
origin remains nonnegative.

The immutable document/declaration index stores owner and sorted key arrays.
Text/selection filters do not re-index keys; playhead ticks are isolated to the
playhead overlay. Visible ranges and dense buckets use binary search. A focused
scalar curve samples only the canonical evaluator, at most256 points, splitting
hold discontinuities instead of drawing diagonal ramps. Dense discontinuities
are labelled and never joined across skipped holds. Curve vertical zoom/pan is
local UI state. Bézier pointer handles are clamped to the existing0..1 contract;
only admitted rAF previews are shown, with one final controller commit.

Selection supports exact previous/next/Home/End navigation, property navigation,
Shift ranges, Ctrl/Cmd toggles, select-all with4,096-key/128-lane rejection,
Set-at-playhead, numeric local frame/value, outgoing easing presets/custom
handles, signed move/duplicate offsets and explicit±1/±10 moves. Copy/cut/paste,
original-time paste and complete paged destination mapping use the Gate2 app
clipboard. No OS clipboard permission or new key compatibility policy is added.
Workspace shortcuts stop before global clip commands; native inputs, IME and
button activation keep their normal behavior. Success/refusal is announced.
Rejected numeric drafts reset to the committed value without remounting inputs.

Pointer capture, no-motion clicks, lost capture, Escape, unmount, playback,
focus/selection changes, document/declaration changes and viewport changes
exercise the existing cancellation owner. A data-only preview carries selected
key addresses and accepted easing for painting. Snap candidates are indexed
once per gesture, excluding selected keys and ineligible tracks. The canonical
resolver retains its existing deterministic tie order and8px threshold, with
Alt bypass; each moving point reads at most six nearest indexed candidates.

## Availability and integration seams

All numeric eligibility comes from `scalarLaneProperty` and the canonical title
adapter. Unsupported stored lanes keep copy/timing/delete controls with their
reason visible. Explicit entry into an unavailable empty lane never falls back
to a different editable property; an entry for a current version resolves an
existing future semantic lane as unavailable. Title outer transforms and the
provisional title-effect authoring guard remain unchanged pending #200's shared
supported-expanded-title/post-composite helper. Held paths never acquire scalar
value/easing authoring here.

Root reports tracking integration `08805c570fb60f739e3414e4d76eff861cc89343`
adds a fourth named preview owner and passive visibility suppression preserving
activation order. This source intentionally stays on4340f96. At integration,
preserve that owner/order behavior alongside animation selection/easing metadata.
No rejected peer/upward message was retried; the owned local report is the
coordination surface and root is coordinating #200 directly.

## Validation and limits

Final focused matrix:56 files /726 Vitest tests, plus17/17 runner checks.
TypeScript/Vite production build, lint and diff checks pass. Existing Vite
chunk-size advisory remains. `gate3-focused-files.txt` lists every test;
`gate3-final-tests.log`, `gate3-final-build.log` and `gate3-final-lint.log` retain
the final commands/results. `gate3-source-hashes.json` pins source and focused
tests changed since frozen master plus build configuration. Development failures
and corrections are retained in `gate3-failures.txt`.

The12 new component tests use the actual composed controller and store. They
cover editing/history, collisions, native keyboard/IME containment, locked and
unavailable lanes, title filters,100,000-key bounded DOM, exact dense navigation,
no index rebuild across playhead ticks, multi-lane mapping, captured key/handle
drags, admitted rAF previews, cancellation, and read-only entry/close. Six pure
view tests cover actual supported titles, dense buckets, bounded indexed reads,
canonical hold curves and exhaustive-versus-indexed snap equivalence. Existing
controller regressions now include workspace/focused-lane cancellation; accepted
portable10m-character, retention, source timing, crop, plugin and title tests
remain in the matrix. Architecture tests pin the lazy UI/index exclusion from
the eager EditorShell graph.

These are component/pure/app qualifications. No real browser layout, native
pointer capture, screen-reader speech, network waterfall, export pixel/PCM,
full suite, production audit or measured performance acceptance is claimed.
The [browser protocol](gate3-browser-protocol.md) requests review and an exclusive
slot before those runs. Gate3 source completion is not Gate3 observable approval
or whole-issue completion.
