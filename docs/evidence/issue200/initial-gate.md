# Issue #200 initial gate evidence

Date: 2026-09-08. Baseline: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`.
Worktree: `/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue200`.
Branch: `codex/issue200`.

## Scope of this evidence

Source inspection and a small unchanged-baseline test run support the proposed
implementation contract. There is no product code, schema migration, browser
pixel proof, full-suite run, build, lint, audit, or implementation acceptance in
this gate. Those remain explicitly scheduled in `docs/ISSUE_200_PLAN.md`.

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
The orchestrator must accept that first-slice mode or require a reviewed local
font catalog before the font acceptance gate closes. No font has been fetched,
registered, licensed, bundled or added as a dependency in this gate.
