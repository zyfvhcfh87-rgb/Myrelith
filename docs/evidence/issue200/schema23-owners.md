# Issue #200 — schema23 title ownership gate

Date: 2026-09-08. Branch: `codex/issue200`.
Exact accepted parent: `f9945c44f75a4818bc939d8b6e63c09db353e669`.
Scope: G1b implementation for orchestrator review. G2 rendering and G3 authoring
are separate, unapproved gates. The project format remains 8.

## Portable owner and upgrade

Timeline schema23 adds optional `Clip.title`, mutually exclusive with compact
`Clip.text`. The 22→23 migration changes only the version number. Supported title
definitions/elements use the accepted bounded reader; future data stays opaque.
Expanded owners require a video track, their own reserved procedural asset ID,
fixed local 1x source map, identity outer transform/default visual geometry, and
no lens correction. Geometry and text styling belong to the elements. Clip
opacity, blend and effect descriptors remain outside the title definition.

`upgradeLegacyTextTitle` constructs an immutable candidate. It moves the exact
legacy text, transform and visual values into one element, sets element opacity
to one and restores outer geometry to identity. Its injected ID allocator
reserves live elements and every orphan target across all sequences. Repeated
upgrade is a no-op. Locked/stale/missing owners and invalid or excessive
candidates return reasons. No automatic upgrade occurs during load/save.

`createTitleUpgradeController` captures project identity, generation, active
sequence and clip. It uses `commitPortableProjectEdit` with the complete live
media envelope and serializer, then the existing store repeats identity and
retention checks before one history edit. Reentrant project changes, rejection
and no-op leave the relevant original state/history unchanged.

## Shared seams and applicability

| Export | Consumer contract |
| --- | --- |
| `textOverlay.isProceduralTitleClip(clip)` | Includes compact text and expanded supported/unsupported owners. Use for procedural time and media/source eligibility. |
| `titleOwnership.readTitleClipElement(clip, elementId)` | Returns only the exact requested supported parsed element; supported disabled elements remain readable. Unknown definition/element or absent target returns `undefined`. |
| `createTitleElementIdAllocator(project, factory)` | Reserves actual and dangling IDs across current and dormant sequences, checks nonempty IDs up to 256 characters, bounds attempts at 64. |
| `copyTitleForNewOwner(clip, allocate)` | Copies supported owners and tracks-only orphan owners; remaps live, future-element-header and orphan IDs in one map. |

These exports fit #199's proposed `AnimationTitleOwnerAdapter` structurally;
this gate imports no unreviewed editor adapter. When the reviewed #198
`maskPathEditing` branch meets this commit, replace its text-only static mask
guard with `isProceduralTitleClip`. The orchestrator owns that merge seam.

Outer title scalar authoring/evaluation permits opacity. Bounded incoming outer
geometry/crop/audio lanes survive inactive, including coupled crop lanes that
would be invalid if evaluated. The crop certificate skips expanded owners;
scalar resolution also skips their non-opacity lanes. Attribute paste supports
outer opacity/blend/effect groups and preserves existing unavailable lanes;
outer geometry groups reject. Legacy text's existing rules remain in place.
Safe text-stage effect authoring and visible unavailable status await the
reviewed #199/G2/G3 integration; this gate conservatively leaves the old effect
key authoring helpers unavailable for procedural titles. It preserves incoming
effect intent, with no new effect registry or interpolator.

## Copy, source and lifecycle behavior

Sequence duplicate, explicit split, split at playhead and implicit three-point
range splits reserve project-wide title IDs. The right split gets its own
reserved procedural asset ID. Orphan lane targets on media or legacy clips are
also reminted when copied; their keys/version metadata stay intact. Two old
schema22 test expectations were updated to assert that intentional new identity
contract instead of expecting orphan IDs to remain shared.

Split/head trim, roll and slide shift all four animation collections and then
recompute procedural source intent as `frame * SOURCE_TIME_TICKS_PER_FRAME`.
Outside negative and tail keys survive. Tail trim preserves authored values;
no motion is regenerated. Media retains its existing absolute source semantics.
Retime, slip, source replacement, lens correction, stabilization and motion
analysis treat title owners as procedural. Media usage/audio selectors and
preview reference tracking exclude title asset IDs. Transition endpoints reject
titles as they already reject compact text.

A future element has a known bounded header ID and can be remapped while its
payload stays opaque. A whole future definition has unknown identity semantics:
duplicate and split return unchanged input rather than guessing IDs inside that
envelope. Save/reopen and non-copying geometry lifecycle preserve it. This is an
explicit unsupported-operation boundary, not future-data loss.

## Actual project and retained-data boundaries

`projectTitleAnimationOwners` pairs the actual title and its tracks in the same
owner. Track-only orphans still count. Portable validation and live all-sequence
admission use that same 1 MiB title-plus-tracks cap. The existing accepted
retention helper receives actual candidate/current/past/future/clipboard owners;
compact legacy text has no new expanded-title cost. Both history branches retain
their separate 100-snapshot cap. No cap was increased or history pruned.

The new production-boundary fixtures prove:

- Actual 600-clip, two-sequence schema22 files at 9,999,614; 9,999,615;
  9,999,999; and 10,000,000 serialized characters migrate and save with no growth.
  They contain Unicode, escaped NUL, a media descriptor and dormant scalar/future
  orphan intent. Equal-size edits, save, undo, redo and reopen retain compact text.
- A schema21 file at exactly 10m also round-trips without optional collection or
  implicit version metadata. Parser and serializer reject 10,000,001 characters.
- Upgrade tests measure the real implementation's candidate delta, then test
  exact-fit and one-over inputs. No 386-character projection is hardcoded. Exact
  fit commits once; undo restores compact representation. Over-cap upgrade keeps
  project, history and populated redo unchanged. Repetition is idempotent.
- The actual project recovery controller activates a 10m schema22 compact file
  and an expanded title file. Its storage I/O is mocked; parser/controller/store
  paths are real. Procedural owners cause no media inspection request.
- One actual title plus orphan lanes fits exactly 1 MiB; adding one byte fails
  portable/store admission even though title and lanes each fit separately.
- Four independently constructed portable snapshots each contain eight opaque
  title owners across active/dormant sequences and serialize below 10m. Two past
  snapshots, one redo snapshot and one title clipboard snapshot total exactly
  64 MiB of conservatively priced title data. A new explicit upgrade rejects
  before redo changes. An ordinary compact-text edit at the same pressure passes.
- 6,249 future definitions plus 16 compact text clips occupy exactly 100,000
  logical elements across two sequences and pass actual portable round-trip.
  One additional compact clip fails. Unknown definitions reserve 16 elements.
- An independent all-sequence counter test combines 499 opaque 20k-string
  owners with one compact 20k text owner at exactly 10m text characters; one
  further opaque character fails. This counter test is separate from file-cap
  acceptance. Disabled/future element strings remain conservatively counted.

The 64 MiB figure is twice retained UTF-8 JSON contributions with immutable
object sharing accounted for; it is not measured JavaScript/browser heap usage.
Accepted invocation-local nested-subtree accounting remains unchanged.

## Validation and open gates

The final focused command and results are recorded in `schema23-tests.log`;
`schema23-build.log` records TypeScript plus Vite; `schema23-lint.log` records
oxlint. All run from the issue200 worktree with
`DEVELOPER_DIR=/Library/Developer/CommandLineTools`. Tests use
`NODE_OPTIONS=--no-experimental-webstorage` and `--maxWorkers=2`.

Final: **38 files /839 Vitest tests plus 17 runner checks passed**, test exit0.
Build/typecheck and lint also exited0; diff check passed. New gate tests include
27 cases plus the real recovery case added to the existing recovery suite. No full suite,
browser, raw-pixel/export parity, performance benchmark or production audit was
run for this owner gate. Vite retains its existing large-chunk advisory. Earlier
checkpoint failures were corrected fixture/API expectations and the two
intentional orphan-remap contract changes, not classified as baseline failures.

Expanded title owners are deliberately omitted by the current composition plan
so they cannot trigger media requests before G2 supplies their renderer. This
commit is **not complete title rendering or release acceptance**. It does not
claim preview/export font status, export blocking, painter parity, UI editing or
template library behavior. G1b proves immutable conversion/copying and legacy
source preservation; actual template capture remains open for G3, where its
library capacity and template envelope exist. The plan's early template-capture
criterion is not claimed as completed here. HANDOFF/PLAN consolidation belongs
to the orchestrator. Stop for review before G2/G3.
