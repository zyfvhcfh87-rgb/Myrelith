# Issue #209 — Step 9 Keep and place

Date: 2026-09-23. Branch/worktree: `codex/issue209`, `.worktrees/issue209`.

## Delivered

The app capture owner now executes Keep from the reviewed state. The stopped
writer reopens and verifies its finalized WAV header and physical length; the
owner additionally checks the committed PCM length against the reviewed sample
count and refuses an empty take. The ordinary media import controller probes
the `File`, commits a ready audio asset to the Media Pool, and receives its OPFS
handle. Keep also awaits the local handle registry so a successful binding is
confirmed before reporting completion.

The owner checks the pinned project before import, then checks the live
destination and imported duration immediately before optional placement.
`mediaPlacementController` performs the final lane/collision/commit check and
inserts one undoable clip. A stale edit, overlap, interrupted or mismatched
take, or late placement rejection leaves the imported asset in the Pool with a
diagnostic. A failed import leaves the draft in review for retry. Once import
has committed, a later failure reports the asset as kept in the Pool, avoiding
a duplicate-import retry. Project activation cancels a pending import and waits
for Keep to settle before replacing project/media state.

The OPFS original remains outside disposable media caches. If local handle
persistence fails after import, the asset stays in the current session's Pool
and the status reports the reconnect risk. Step 10 owns a full recovery,
reconnect, safe removal, and local-project-forget policy.

## Verification

- Focused Vitest: 110 cases passed across capture/Keep, pinned destination,
  session rules, placement, import, and WAV bridge. The test runner's 28 Node
  checks also passed. Keep tests cover valid WAV, corrupt final length, failed
  import/retry, stale project/edit, collision at final commit, duration mismatch,
  failed handle persistence, post-import failure, cancellation during import,
  and one-history undo/redo.
- Real Playwright Chromium recorded a generated live audio stream through the
  production worklet and OPFS writer. Keep finalized and decoded its WAV via
  the ordinary import path, registered the OPFS handle under a local project
  binding, and placed the audio asset at the selected frame. The saved handle
  reopened to the same file size. One undo removed the clip and redo restored
  it while the Media Pool asset remained. That Step 9 case and seven adjacent
  capture/clock browser cases passed.
- `npm run build` passed TypeScript and production build, with the existing
  large-chunk notice. `npm run lint` passed with five existing unrelated
  warnings. `git diff --check` passed.

Commands:

```text
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/app/voiceoverKeep.test.ts src/app/voiceoverCaptureOwner.test.ts src/domain/voiceoverDestination.test.ts src/domain/voiceoverSession.test.ts src/app/mediaPlacementController.test.ts src/app/mediaImportController.test.ts src/app/voiceoverWavBridge.test.ts
npx playwright test tests/browser/issue-209-keep-place.spec.ts tests/browser/issue-209-transport-join.spec.ts tests/browser/issue-209-capture-owner.spec.ts tests/browser/issue-209-microphone-bridge.spec.ts
npm run build
npm run lint
git diff --check
```

## Qualification limit and next step

The Chromium capture used a generated audio stream and proves the app's file,
probe, registry, placement, and history path. Physical microphone timing and
native permission behavior remain for Step 12. There is no product Keep UI yet;
Step 11 adds it. Step 10 must make interrupted drafts discoverable after reload
and define how kept OPFS originals reconnect or are safely removed.
