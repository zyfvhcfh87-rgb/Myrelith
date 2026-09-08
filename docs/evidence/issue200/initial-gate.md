# Issue #200 initial gate evidence

Date: 2026-09-08. Baseline: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`.
Worktree: `/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue200`.
Branch: `codex/issue200`.

## Scope of this evidence

Source inspection and a small unchanged-baseline test run support the proposed
implementation contract. There is no product code, schema migration, browser
pixel proof, full-suite run, build, lint, audit, or implementation acceptance in
this gate. Those remain explicitly scheduled in `docs/ISSUE_200_PLAN.md`.
The initial proposal was committed at `f096da4`; the amended-gate section below
records the review corrections and additional real baseline size experiment.

Read coordination instructions, worktree AGENTS.md and the full ARCHITECTURE.md;
reviewed HANDOFF's current status and working agreements, PLAN's #33/#43 gates,
and the complete saved #200/#199 issue bodies. Orchestrator confirmed the private
dependency copy is complete. It is a directory, not a shared symlink.

## Source observations

- `src/domain/textOverlay.ts`: supported generic family and hexadecimal color
  vocabulary; 20,000 text characters; 8–1,024 px font; 16–65,535 px box;
  padding/outline/shadow bounds and strictly positive inner geometry.
- `src/domain/schema.ts`: `TextProps`, `Clip.text`, `ClipAnimationKeyframe`
  with source intent, ordinary/effect track container and identity contracts.
- `src/domain/clipAnimation.ts`: 1,024 keys/track, ±1e9 local frames,
  100,000 project keys; text eligibility rejects animation; cloning, counting,
  replacement, removal and shifting explicitly rebuild known container fields.
  Adding a field only to the schema would lose it at these helpers.
- `src/domain/sourceTimeMap.ts`: intent/shift/retime helpers explicitly rebuild
  ordinary/effect arrays. Procedural origin changes need deliberate fixed-local
  title handling; media source intent must not be changed as a side effect.
- `src/domain/operations/geometry.ts`: split copies every track and shifts right
  frames; title source maps reset to zero; existing right text copy is shallow.
  Title element/target identities and deep owned data need deliberate remapping.
- `src/domain/operations/creation.ts`, `audioText.ts`, `visual.ts`, `animation.ts`:
  insertion/edit/lock/eligibility boundaries and existing static text editing.
- `src/domain/projectFile/{projectTypes,clipValidation,documentValidation,migrations,serialization}.ts`:
  timeline 21 / project 8, exact known keys, text budget, current-file source
  intent, complete project validation and explicit serialization branches.
- `src/domain/projectSequences.ts`, `clipAttributes.ts`, `selectors.ts`:
  dormant sequence aggregate budgets, fresh duplication identities, preserved
  animation targets and procedural-media exclusion need to include titles.
- `src/domain/videoCompositionPlan.ts`: one animation-resolved text item, no
  source request. Nested project planning and video buses must keep this order.
- `src/pipeline/render.ts`: text layout cache (64/context), 512-line limit,
  box-centered legacy painter shared with captions, one isolated/effected layer.
- `src/ui/TextOverlayControls.tsx`, `TextOverlayDialog.tsx`: existing pointer/
  keyboard move/resize, ephemeral text preview and one release commit. Per-element
  selection and exact animated-value previews must extend this ownership model.
- `src/domain/effectPresets.ts`, `app/localEffectPresetStorage.ts`, architecture:
  existing bounded local library and transaction ownership are a reusable pattern.
- `src/state/documentStore.ts`: 100-entry whole-project history and existing
  LUT retention preflight provide the retention-accounting integration point.

The contract was sent to #199 for review before product work. #201 was notified
that caption `TextProps` and legacy paint/wrap output must remain stable. No
schema number or production import exception was assigned.

## Focused baseline command and result

Working directory was the issue200 worktree for every shell invocation.

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
NODE_OPTIONS=--no-experimental-webstorage npm test -- \
  src/domain/textOverlay.test.ts \
  src/domain/textLayout.test.ts \
  src/domain/clipAnimation.test.ts \
  src/state/textOverlayStore.test.ts --maxWorkers=2
```

Observed result: **4 files / 19 Vitest tests passed**, then **17 benchmark-runner
tests passed** through the canonical `npm test` wrapper. Exit code 0. Vitest
reported 972 ms; no failing/unhandled console gate. Source remained unchanged
and clean at this run. This does not qualify new title behavior or the full suite.

Initial read-only `python3` invocation without the developer-directory environment
hit the Apple Xcode-license stub. Retried with the prescribed
`DEVELOPER_DIR=/Library/Developer/CommandLineTools`; JSON read succeeded. No
agreement was accepted and no system developer directory was changed. A few
exploratory candidate paths did not exist; source inventory located the actual
modules. These were read-only discovery misses, not test failures.

## Font evidence and limits

Primary sources consulted 2026-09-08 (CSSWG working drafts):

- [CSS Fonts: generic families](https://drafts.csswg.org/css-fonts/#generic-font-families):
  generics can resolve to different installed/composite faces across platforms,
  scripts, preferences and settings. A generic family name is not a font digest.
- [CSS Font Loading: check](https://drafts.csswg.org/css-font-loading/#font-face-set-check):
  `FontFaceSet.check` can return true when requested fonts are absent or have no
  matching character coverage, because the browser can render a fallback.

Therefore the plan does not treat `check()` or a width sentinel as proof of
font identity or complete glyph coverage. Generic compatibility is visibly
qualified; missing named intent cannot be silently sent through browser fallback.
The orchestrator accepted that first-slice generic compatibility mode on
2026-09-08, with real main/worker/export parity still required. A bundled custom
font catalog is not required for this issue. No font has been fetched,
registered, licensed, bundled or added as a dependency in this gate.

## Amended Gate 0 — semantic targets and exact file-size boundaries

The orchestrator requested two corrections before approval: semantic title lane
identity is `(elementId, property)` independent of propertyVersion; and valid
legacy text must not be forced into a larger title representation on open/save.
The amended plan now retains mutually exclusive supported `Clip.text` and
`Clip.title` variants, with title creation/upgrade requiring full candidate
validation. #199 was notified about semantic uniqueness and omission of empty
new collections/default-version metadata needed for zero-growth compatibility.

The orchestrator assigned pure titleElements first (no Clip/migration changes),
#199 animation foundation as timeline 22, then title ownership as timeline 23.
This is a reviewed order, not an implemented migration or approval to begin it.

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
NODE_OPTIONS=--no-experimental-webstorage node \
  docs/evidence/issue200/legacy-size-boundary.mjs
```

The evidence-only Node script uses Vite's in-process TypeScript loader with no
listening server, watcher or websocket; it closes that owner in `finally`.
It asserts it is running in its own worktree and that the production source
tree equals baseline `ce91074`. It writes only the small checked-in result,
not four 10 MB fixture files. Production source imports none of this fixture.

Observed final run: exit 0. Source tree
`5da2bb78f3d4aa7afa494fef2d487fa0cc0bca39`. Four deterministic real legacy projects
at exactly 9,999,614; 9,999,615; 9,999,999; and 10,000,000 serialized characters
passed actual baseline parse/serialize equality and equal-length content/color
editing plus save/reopen. The parser and serializer both rejected 10,000,001.
Each fixture contains 600 real text clips across root and dormant sequences,
bounded to 20,000 characters each; no unknown field or whitespace filler cheats.

The proposed single expanded title adds 386 characters in this fixture. The
exact character threshold is 9,999,614→10,000,000; the next input character would
make the upgrade exceed the cap. Forced expansion of all 600 adds 232,500.
Preserving legacy Clip.text and omitting new empty fields projects zero growth
for two-digit schema 21→22→23. See `legacy-size-boundary-result.json`.

Qualification: baseline parser/serializer/edit results are executed evidence.
The future compatibility and title-envelope sizes are data-shape projections,
not proof of a schema-23 parser, undo/recovery implementation or title renderer.
G1b must run the same fixtures against those actual production boundaries.

The script's first attempt resolved its root one directory too high and could
not load the domain module. It was corrected to resolve its own worktree and
assert the running directory. The rerun passed, then the fixture was expanded
with exact-fit/one-over upgrade thresholds and passed again. No product files or
schema limits changed. Node syntax and whitespace/diff checks also passed.
