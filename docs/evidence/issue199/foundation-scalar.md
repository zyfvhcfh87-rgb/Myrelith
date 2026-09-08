# Issue #199 — independent scalar/timing foundation

Date: 2026-09-08. Scope: representation-neutral extraction approved by the
Milestone 9 supervisor after Gate 0, before any schema 22 change.
Starting worker HEAD: `6a2ae5a705a5733798f77f1ee9ccb5aa52094bc8`.
Reference master: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`.

## Delivered boundary

- `domain/scalarAnimation.ts` contains the existing scalar key validator,
  easing clone/validation, fixed 24-bisection evaluator and unchanged bounds.
  It has only schema type imports and no property registry/browser dependencies.
- `clipAnimation.ts` preserves its existing public exports as references to
  that leaf. Existing Inspector, audio, plugin and composition consumers retain
  one evaluator. No new curve formula, clamping, property, type or field is added.
- `animationTiming.ts` traverses typed timed keys while preserving payload
  and metadata. Existing origin shift, slip-source shift and retime use it.
  Ordinary shifts retain ordering; retime requests sorting and rejects duplicate
  destinations per lane. Callers still own bounds/value/source-map validation.
  The helper never mutates input or returns a partial candidate on rejection.
- `sourceTimeMap.ts` now imports frame bounds directly from the scalar leaf,
  removing its unnecessary effect-registry dependency. Its source arithmetic,
  integer inversion, errors and public return shapes remain unchanged.
- No schema/migration/serializer, Clip owner, property vocabulary, plugin
  identity, store, UI, worker protocol, renderer or audio clock was changed.

## Exact regression evidence

`scripts/issue199/capture-animation-baseline.mjs` reads source from the
immutable reference commit, transpiles only trusted baseline source in a bounded
VM setup and captures outputs. It does not execute current production code to
invent expected values. The baseline source/extracted hashes are in the fixtures.
The generator is build-unreferenced; only tests read its inert JSON results.

- 144 easing outputs and 756 integer/sample-boundary scalar outputs match the
  baseline's IEEE-754 bit patterns exactly: 900 total comparisons, with signed
  large frame ranges, exact keys, holds, degenerate/crossed Bézier controls and
  fractional audio positions. The scalar fixture passed against the old
  evaluator before the extraction and the same fixture passes afterward.
- 36 complete source-shift/retime outcomes match baseline JSON structures,
  including null rejection, missing durable ticks, unknown effect target names,
  rate changes, collapsed keyframes and safe-integer overflow.
- Additional focused tests prove payload/type metadata preservation, immutable
  input, per-lane collision scope, rejection without a partial result, original
  source-tick retention for local origin shifts and unsafe-frame refusal.
- These are exact regression fixtures, not a proof of monotonicity or enclosure
  over every floating-point input. Crop interval admission remains unimplemented.

The baseline cubic primitive deliberately retains finite-bisection endpoint
error: for (0.25,0.1,0.25,1), progress 0 returns approximately
8.940698847936756e-9 and progress 1 returns 0.9999999999999976. The track evaluator
short-circuits exact key/held boundaries. Future crop proof must use this actual
behavior with conservative outward numeric bounds, not replace it or assert
ideal Bézier endpoints.

## Validation

- Passed the canonical focused runner: **14 files / 121 Vitest tests**, plus
  **17/17 repository runner checks**, one worker.
- Passed `npm run build`: TypeScript and Vite production build, with the existing
  large-chunk advisory.
- Passed `npm run lint` without findings.
- Final timing test rerun after a type-only fixture annotation: **4/4 tests**
  plus **17/17 runner checks**. Product behavior did not change after the larger
  focused run.
- Diff checks and source/fixture provenance recorded for this commit.
- No full suite, production audit, Chromium, timing benchmark or feature
  acceptance is claimed. This internal extraction has no intended observable
  UI/pixel/PCM behavior change; shared production consumers and architecture are
  in the focused matrix. Full/browser gates remain required before issue
  completion and require an exclusive supervisor slot.

Captured logs (trailing whitespace normalized): [focused tests](foundation-scalar-tests.log),
[build](foundation-scalar-build.log), [lint](foundation-scalar-lint.log),
[final timing tests](foundation-scalar-final-test.log).

The focused command was:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/scalarAnimation.test.ts src/domain/animationTiming.test.ts src/domain/clipAnimation.test.ts src/domain/clipAnimationOperations.test.ts src/state/clipAnimationStore.test.ts src/domain/sourceTimeMap.test.ts src/domain/audioMixPlan.test.ts src/domain/pluginVideoEffectStagePlan.test.ts src/ui/AnimationCurveEditor.test.tsx src/domain/effectStack.test.ts src/domain/clipAttributes.test.ts src/domain/adjustmentItems.test.ts src/domain/videoCompositionPlan.test.ts src/test/architecture.test.ts --maxWorkers=1
```

Honest first attempts: the initial new scalar test failed before collecting
cases because its fixture URL resolved to a non-file scheme in jsdom. Using an
explicit repository fixture path fixed it, and the baseline test passed before
product extraction. The first extraction build caught a frozen test fixture
inferred as literal frame types rather than mutable numeric time; an explicit
readonly numeric payload annotation fixed that test-only compile error.
The [first build output](foundation-scalar-build-first.log) is retained.
No baseline/runtime defect was concealed or classified as unrelated.

## Cross-issue review and next gate

Reviewed #200 committed proposal `f096da42d4cff1ce8aa148a23ae16c5de0441307`.
Its property/read/apply adapter split, scalar eligibility and fixed-local title
ticks align with #199. That commit still defined uniqueness with propertyVersion;
#200 then reported amendment `1e23f14bc4aeebeeb26f10d0847abb6a30d7ecb9` to one
semantic element+property lane, preserving a lone unknown version and rejecting
mixed versions. The supervisor's same requirement is binding here.

The supervisor assigned schema 22 to #199 after reviewed pure title/path adapters,
title-owner 23 to #200 and caption 24 to #201. Legacy Clip.text remains a supported
mutually exclusive variant until explicit budget-checked upgrade. Schema 22 must
omit absent new collections and implicit scalar v1 metadata instead of growing
unchanged old files. Future serializer tests must include actual no-animation
and old-scalar files at the original 10,000,000-character boundary; the current
extraction does not implement or claim that proof.

Request review of this committed neutral foundation. Do not start schema 22
until the two adapter contracts have been committed, reviewed and shared.

## Source and fixture hashes

| File | SHA-256 |
| --- | --- |
| `src/domain/scalarAnimation.ts` | `9e2a6dde82ca0e48a833d44c7eedbaa99b3c07f31fef705b750a12353219cd3b` |
| `src/domain/animationTiming.ts` | `ddbbcac09a99fd87cd141a481f6bfb61eb36221610d1af5c682022b2330d8b6f` |
| `src/domain/clipAnimation.ts` | `9421f7eea2e3728b862fd06cdf04b0769351a0b4c8ed71f25e47ea92975047dc` |
| `src/domain/sourceTimeMap.ts` | `f6a863b407a8c6d76d4769e7126701922dbd672d6bdcec50cfb3d5ce9581c021` |
| `src/test/fixtures/animation-scalar-baseline.json` | `e94adb7a2a12f395f17a405138fec929083b3cc1ac903d1c957e5a678dc9caba` |
| `src/test/fixtures/animation-timing-baseline.json` | `8c334a2b614522b9dd4d2716ca5ea833f1bc949235463f4cddb70f2456b1b3d6` |
