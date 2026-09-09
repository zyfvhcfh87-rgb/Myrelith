# Issue 199 — atomic animation editing (Gate 2)

Date: 2026-09-08. This gate is submitted for exact-commit review. Stop before
Gate 3 unified UI; the supervisor owns acceptance and integration.

## Accepted base

Gate 1 `f555a043074ca8e8f54cb312a1372d061fd881eb` was accepted and integrated at
`f9945c44f75a4818bc939d8b6e63c09db353e669`. This branch fast-forwarded cleanly to
that exact integration before Gate 2. Its shared portable preflight and mask
commit guards remain in place. This gate adds no schema or project-file version.

## Atomic edit contract

`animationAddresses` uses structural owner/lane/key addresses, escaped JSON
tuples and exact version/declaration metadata. Semantic competition is separate
from version applicability. Selection is bounded to 4,096 keys in 128 lanes;
wire identifiers retain the shared 256-character bound.

`animationBatch` is a pure immutable planner for move, duplicate, delete, scalar
value and easing edits. It resolves owners once, checks selected keys and locks,
removes all selected sources before checking move destinations, and rejects the
complete candidate on a collision. Duplicate preserves originals, including
rejection at zero offset. Move zero and identical value/easing edits preserve
the original project reference. The final selected key order and actual focus
are mapped; deleting a final lane reveals the unchanged static fallback and
focuses a surviving logical neighbor.

Explicit single-key Set creates an available lane or replaces one exact-time
key. Multi-key insertion cannot enable this replacement policy. Existing
Inspector single-key frame moves keep their old replacement behavior, now
labelled at both frame editors. The new batch API never calls that move loop.

Every changed owner is validated through the existing scalar, adjustment and
typed path boundaries. Final lane, project, crop, path and title bounds apply
before a candidate is returned. Optional absent collections and compact scalar
v1 encoding remain absent when the edit does not need them. Unsupported bounded
lanes can move, duplicate, delete and copy without gaining numeric applicability
or losing their metadata. Current value/easing editing requires the explicit
property authority. Path values stay strings with hold easing.

Moves and insertions recompute each destination owner's source intent through
the canonical time map. Procedural titles use fixed local ticks; adjustments
have no source ticks. Local key frames, global destinations, paste offsets and
source ticks must all remain safe integers within their applicable bounds.

## Clipboard ownership and compatibility

`animationClipboard` copies selected data into a deeply frozen, data-only
clipboard. It captures exact lane metadata, outgoing easing, frame rate,
per-key global times and the explicit property contract. The earliest global
key is the anchor. Default paste moves that anchor to the playhead; original-time
paste retains global positions. Relative signed spacing is preserved across
owners, and destination local frames/source ticks are recomputed.

Cross-lane paste needs a complete explicit mapping with compatible scalar/path
kind, version, units and bounds. Effect type/parameter and plugin declaration
identity must also match. Missing effects and title elements are never created.
Unavailable payloads can paste only to their unchanged exact existing address
when both contracts remain unavailable. A previously available declaration that
drifts to unavailable rejects. Frame-rate mismatches, incomplete mappings,
competing versions, destination collisions and malformed timing reject the
whole paste. There is no rate resampling, truncation or OS clipboard access.

The app owns the clipboard for one project generation. Same-id project reload
and unmount clear it; undo retains copied data without restoring deleted key
selection. Cut builds the clipboard and deletion candidate, checks both, then
performs one history commit. Old clipboard data and populated redo participate
in admission before replacement. Path retention uses the shared 32 MiB ledger;
title retention uses the shared 64 MiB ledger and full copied addresses,
contracts, global times, track data and envelope metadata. Tests leave enough
space for bare title tracks but reject the complete clipboard envelope, proving
that metadata is included. These are accounting bounds, not measured heap usage.

## Gesture and commit boundary

`animationEditingController` owns one active gesture and one clipboard, mounted
by `EditorShell`. It coalesces preview commands through one pending animation
frame callback. Preview is a data-only candidate in the existing named effect
preview registry, so cancellation restores another owner's preview. Replacing
a preview releases the old animation preview before admitting the new one.

A gesture pins project reference/generation, active sequence, key selection and
focus, selected clips/adjustment, playhead, playback/scrub state, transport reset
revision, media descriptor/collection/asset references, plugin snapshot and title
adapter. Document, transport, media and declaration observers cancel stale work.
Escape, explicit cancellation and unmount clear queued callbacks and preview
without history. Reentrant cleanup, synchronous subscription notification,
external undo and disposal during store notification cannot revive stale edits,
selection or clipboard ownership. Mount revisions protect a later remount from
an older disposer.

Commit cancels preview ownership, creates a fresh candidate from the pinned
source and final command, checks the complete production portable-file envelope,
then calls the source/generation/sequence-pinned store action exactly once. The
store independently repeats project and retention admission. A synchronous
external edit during notification is left intact and reported stale; this
controller does not overwrite that edit with its own selection mapping.

The existing real-file fixture now exercises the new controller at 9,999,999 and
10,000,000 characters for both compact-text and old-scalar variants. An oversized
key edit is rejected before changing the exact store object or populated redo.
The earlier parse/migration/serialize, mask, undo/redo and 10,000,001-character
rejection assertions remain active.

## Gate 2 review correction — same-ID effect type drift

The supervisor reproduced a contract defect at `ec12258`: copying the built-in
RGB-curves `strength` lane, then replacing its descriptor with Lift / Gamma /
Gain under the same effect ID, incorrectly allowed paste because numeric bounds
matched. Exact lane identity did not include the owner effect type. The same
bypass also admitted unavailable path data after its same-ID owner changed type.

Paste now compares the captured effect type with the destination descriptor for
both scalar-effect and path lanes, including exact-address paste. It rejects
changed, removed or newly appeared effect types before constructing insertions.
Unchanged same-type descriptors still paste. Unavailable future and orphan data
still support copying and timing edits; an exact orphan paste remains allowed
when both copied and destination descriptors are absent. This correction adds
no value applicability or schema fields.

Four regression cases first failed against the unchanged `ec12258` product
code (40 passed / 4 failed), then all 44 domain/controller tests passed after
the fix. Tests cover equal-bound built-in type drift, same-type acceptance,
unavailable path owner drift, unchanged future/missing owner preservation,
and app refusal with the exact old clipboard, selection, project and populated
past/future history unchanged. Undoing the descriptor replacement restores
compatibility with that same clipboard. Final full focused evidence below is
refreshed for the correction; the 188-file source manifest also matches it.

## #200 integration handoff

The pure `AnimationTitleOwnerAdapter` accepts `isTitleClip(clip)` and
`readElement(clip, elementId)`. #200 G1b offered canonical
`textOverlay.isProceduralTitleClip` and `titleOwnership.readTitleClipElement`.
After both gates are accepted, compose them in `app/animationEditorController`.
The predicate must recognize compact text and bounded unsupported expanded
titles; the reader must return only the exact supported requested element,
including a disabled supported element. #200 retains schema 23 title-plus-track
budget ownership and exclusion of inactive outer crop lanes from certification.

The current default recognizes legacy text and resolves no expanded element.
No dirty peer implementation or invented Clip.title parser is consumed here.
An injected adapter test proves title static-padding bounds, exact element
identity, disabled-element authorability, outer-opacity-only eligibility and
fixed local source intent even when a timed-media map would differ.

## Validation and remaining gates

- **50 focused files / 678 Vitest tests**, plus **17/17 runner checks**, pass on
  the final source. `gate2-focused-files.txt` lists the exact verified paths;
  `gate2-final-tests.log` records the expanded command and result.
- TypeScript and Vite production build pass; the existing large-chunk advisory
  remains. Lint and diff checks pass. Final logs and source/test SHA-256 manifest
  accompany this report; development failures are recorded separately.
- Coverage includes legacy scalar/timing oracles, all-sequence crop/title/path
  bounds, clipboard compatibility, history and real file limits, app stale and
  reentrant ownership, existing Inspector and EditorShell component behavior,
  preview owners, architecture and affected composition/project boundaries.
- No heavy slot was used. No full suite, browser capture, decoder/export pixel
  or PCM comparison, performance benchmark, or complete-feature acceptance is
  claimed. Existing Inspector explanatory text is component-tested only.
- Gate 3 must supply the lazy workspace, indexed/virtualized lane planning,
  dope sheet and scalar curve view, pointer-capture/lost-capture bindings to this
  cancellation API, keyboard controls, command errors/announcements and browser
  interaction validation. No native pointer event binding is claimed in Gate 2.
- Gate 4 retains mixed-feature browser/export and measured performance work;
  Gate 5 retains final issue acceptance and publication by the supervisor.
