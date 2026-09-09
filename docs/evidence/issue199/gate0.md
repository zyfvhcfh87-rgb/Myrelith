# Issue #199 Gate 0 evidence

Date: 2026-09-08. Stage: plan proposal only; no product implementation.
Baseline source: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`.
Branch: `codex/issue199`. All shell work used the isolated issue199 worktree.
Private `node_modules` was confirmed as a directory, not a symlink.
Runtime: Node `v26.8.1`, repository Vitest `4.1.9`.

## Baseline checks

- Passed 7 focused Vitest files / 65 tests, plus all 17 canonical repository runner checks, with one worker.
- Passed `npm run build` (TypeScript build and production Vite build). Vite reports the existing >500 kB chunk advisory; it is not a build failure.
- Passed `npm run lint` with no emitted findings.
- No full suite, production audit, new-feature browser acceptance, or timing benchmark was run at this docs-only gate. These remain required product-completion gates.
- The tests ran against unchanged baseline source; the only worker changes are the plan and evidence. This proves existing focused contracts, not the unimplemented issue criteria.

Exact commands, from the issue worktree:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/clipAnimation.test.ts src/domain/clipAnimationOperations.test.ts src/state/clipAnimationStore.test.ts src/domain/sourceTimeMap.test.ts src/domain/audioMixPlan.test.ts src/domain/pluginVideoEffectStagePlan.test.ts src/ui/AnimationCurveEditor.test.tsx --maxWorkers=1
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run build
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run lint
DEVELOPER_DIR=/Library/Developer/CommandLineTools git diff --check
```

Captured outputs (trailing whitespace and terminal blank lines normalized): [tests](gate0-baseline-tests.log), [build](gate0-baseline-build.log), [lint](gate0-baseline-lint.log).
The logs are intentionally force-added because the repository ignores `*.log`.

## Source provenance

| Inspected baseline file | SHA-256 |
| --- | --- |
| `src/domain/clipAnimation.ts` | `884f607f6021bbabc3a4866a34a34ea91a805915c41d38f87073f3182df49383` |
| `src/domain/schema.ts` | `2c8e2981f70357606ab7f7d98334e15f655f0bc0c5fd2756e698fca27c0915c2` |
| `src/domain/sourceTimeMap.ts` | `9e7d4d230cfe76d6b2e35b4a56db736844d829c28c17a82000fb66a5882890cd` |
| `src/domain/operations/animation.ts` | `96047d164d23faf91bb50f41f06a832b548972e07b235fe27fae0d6f1591fff9` |
| `src/domain/audioMixPlan.ts` | `5fb3ac433facac21645cba3b6c65894ead6cd9e6266de6ef35874abdd6c496dd` |
| `src/domain/pluginVideoEffectStagePlan.ts` | `3233c14dc3dc6e38fdda06602cb2bb68fb31ff183fe65dd2775d4e7b2da3a615` |
| `src/domain/effectStack.ts` | `c23ebb4e2d732b7ae74abde29d7a6d002d29476dc7b027b1966b7734a9b2a76e` |
| `src/domain/clipInspector.ts` | `e3422adc82634b4aae8dce4d5797b7ef81dfac740f4c5404186b9714697c0fa2` |
| `src/domain/projectSequences.ts` | `76b5d1da5fb8822f55966b8f8609d8fdcc87ceaffb5d8bfdd60b60f3a954be11` |
| `src/domain/projectFile/projectTypes.ts` | `8564384977479ef54ebd228d6aed4e10f35ff4b908f9062b289e6c378def94fb` |
| `src/state/documentStore.ts` | `f655cfefb93235f94a30b9fccfdf25a4449f41b866d4027e68f31fe79d031609` |
| `src/ui/AnimationCurveEditor.tsx` | `9b7b77aafaf7560199a50bc17d5f7a31da0d6439728941b90475c0fe4ab9c14a` |

## Cross-worker proposal provenance

- #198: read its local `docs/ISSUE_198_PLAN.md` during this gate while its Git HEAD was still the frozen baseline. This was a working proposal, not an approved committed foundation. SHA-256 at capture: `ff9e3fdea93b7fb083ca3f5e0e283ce0e9eb65b0f1324c2ea5d764f28172d2be`.
- #198 offered `effectPathTracks`, held M/C/Z strings, typed value/version identity, 256 keys/track, 4,096 project path keys, 1,048,576 value code units and 32 MiB retained-animation allowance. The plan uses that proposed structure and requests joint review.
- #200: received its title-contract message directly in this task on 2026-09-08. It proposes stable element ids and `titleTracks` keyed by `elementId/propertyVersion/property`, and ordinary position keys for roll/crawl. Its complete on-disk plan became available after the first plan commit and was reviewed before final handoff. SHA-256 at review: `a0a1d8125d7b93a56d9eac5c22ea416e7b5fe9b8d3a95df0645e462db2cc61c9`. The final proposal incorporates its exact property/budget table and fixed-local source-tick reanchor on title split/head trim; orchestrator approval is still pending.
- Initial orchestrator review arrived before final handoff: shared semantic targets cannot have competing versions or scalar/path kinds; crop proof must use outward error bounds covering fixed Bézier bisection, with no permissive epsilon at 0.99; new plugin identities may bind immutable package/contribution/descriptor facts but legacy provenance is never inferred. The plan incorporates these corrections. #198 plan `0c0ab7b` was reported approved for independent geometry/path work only, while common schema/traversal remains pending.
- Final schema versions and implementation ownership remain subject to orchestrator review. No other worktree was edited.

## Honest environment/coordination notes

- An initial `python3` read attempt without `DEVELOPER_DIR` hit the Xcode agreement prompt. No agreement was accepted. Node performed the read successfully; Git/test/build calls used Command Line Tools.
- Two direct `send_message_to_thread` attempts to the supervisor were rejected by automatic approval review as disclosure to an unverified/unauthorized destination. The second attempt followed a read-only identity check confirming the local supervisor task and originating user request. No further notification workaround was attempted. The separately authorized local report and this task's final handoff remain the deliverables.
- A few exploratory searches named absent paths; the actual split project-file and audio/plugin module paths were subsequently located with `rg --files`/source references. These were navigation misses, not test failures.

## Issue snapshot

Source: orchestration `issues.json`, issue #199, last updated `2026-08-25T21:37:09Z`.
Full issue title: [Feature]: Expand keyframes with a unified curve and dope-sheet editor

Roadmap tracker: #185

### Editing problem

Myrelith keyframes cover visual position/scale/rotation/opacity and selected effect parameters, but crop, text styling/geometry, audio gain/pan, and many future declared parameters cannot be animated. Editing is distributed across small Inspector lanes rather than one timeline-wide curve/dope-sheet workflow.

### Desired outcome

Extend one canonical scalar/property animation contract and add a unified curve/dope-sheet editor for exact selection, timing, easing, copy/paste, and multi-property navigation.

### Feasible slices

- Add safe property tracks for crop edges, text geometry/style scalars, and audio gain/pan after their owning render/audio contracts exist.
- Let built-in/plugin manifests expose explicitly animatable bounded numeric parameters; never infer animation from arbitrary JSON.
- One dope sheet showing clip/effect/text/audio keys with filtering, multi-select, move/duplicate/delete, snapping, and exact collision rules.
- One curve editor with hold/linear/CSS-bezier easing, bounded handles, zoom/pan, numeric values, and keyboard operation.
- Copy/paste keys with a documented absolute/relative-time policy and full budget preflight.

### Acceptance criteria

- [ ] Every added track has stable identity, bounds/units/defaults, split/trim/slip/retime/source-time semantics, migration, and preview/export parity.
- [ ] Dope sheet and curve editor read/write the same pure evaluator used by scrub/playback/export; no UI-only interpolation exists.
- [ ] Multi-key edits are atomic, preserve selection/history rules, reject duplicate/unsafe frames deterministically, and enforce the document-wide key budget before mutation.
- [ ] Unsupported/future/plugin parameters remain portable; manifest changes cannot reinterpret old units silently.
- [ ] Keyboard/screen-reader paths cover property/filter selection, key navigation, add/move/delete, easing, zoom, focus, and value entry.
- [ ] Large-key fixtures keep mounted/rendered UI bounded and planning indexed.
- [ ] Real Chromium verifies mixed transform/effect/text/audio curves, copy/paste, retime/split, undo/redo, save/reopen, playback/export parity, and clean console.
- [ ] Focused/full tests, build/typecheck, lint, production audit, and diff checks pass.

### Dependencies

Builds on #43 and effect tracks. Audio tracks depend on the Milestone 7 audio issue; text tracks depend on the title schema chosen below.

### Out of scope

- Expression scripting, arbitrary code, unbounded vector properties, or a second animation model for plugins.

### Evidence

Kdenlive, Shotcut, OpenShot, Flowblade, and Olive all document curve/keyframe editing as a central animation workflow; this issue extends Myrelith's existing exact evaluator instead of replacing it.

### Local-first boundary

- [x] Animation remains portable bounded project data and executes locally.
