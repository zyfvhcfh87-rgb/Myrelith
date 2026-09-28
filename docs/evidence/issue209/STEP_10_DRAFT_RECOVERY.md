# Issue #209 — Step 10 Drafts and reconnect

Date: 2026-09-28. Branch/worktree: `codex/issue209`, `.worktrees/issue209`.

## Delivered

The recordings directory (`myrelith-recordings-v1`, deliberately outside the
disposable `myrelith-derived/*` namespace) is now an explicit product surface.

The pure domain layer (`domain/voiceoverDrafts`) classifies every `.wav` entry
from three browser facts: remembered registry handles (a draft whose name a
handle points at is `kept`, even when a finished Keep session still lingers),
the capture session (an unfinished session makes its own draft `live`), and
everything else `orphaned`. Discard is legal for `orphaned` drafts only; a
kept original may be removed only when none of its referencing assets appears
in any clip of any project sequence, dormant or nested.

The worker gained a metadata-only `list` (sync-access `getSize()` per entry,
journal existence, sorted) and `discardStored(id)`, which removes a stored
draft without touching the worker's own draft and is idempotent after a partial
removal. The bridge exposes `list()` and `discardId()` valid in every
non-closed phase.

The app feature (`app/voiceoverDraftRecovery`) owns one dedicated worker and
never the capture session's writer. Its survey reads the directory and every
asset's registry handle in parallel; a registry read failure fails the whole
survey rather than silently reclassifying a kept draft as discardable.
`recoverDraft` accepts an orphaned draft with a checkpoint, replays the last
durable checkpoint through the dedicated worker, and imports through the
ordinary media import path, whose handle memory makes the file the kept
original of the imported asset on the next survey. `discardDraft` deletes
orphaned drafts only. `removeKeptOriginal` requires the asset to be in the
project, unreferenced by clips, and visibly present in the recordings
directory; it then deletes the file, forgets the registry grant (IndexedDB
only), and marks the source offline in the current session. The project
descriptor remains, so a reload reports the source missing and the existing
manual relink reconnects it. A remembered source that is not visible in the
directory is rejected — never forgotten or disconnected — because a moved or
externally deleted file, or a non-voiceover asset, must not be mistaken for a
gone recording original.

## Browser-only findings

- A pre-commit working-tree change had made the worker transfer the finalized
  handle in its reply. Real Chromium rejects that:
  `Value at index 0 does not have a transferable type`, and the main thread
  waits forever. `FileSystemFileHandle` crosses `postMessage` by cloning, not
  transferring; the reply is posted without a transfer list (as in Steps 5–9),
  and the main thread receives a working handle.
- `createSyncAccessHandle()` fails with `NoModificationAllowedError` while
  another access handle holds the same file open, so a listing while a
  recording is in progress cannot measure that file. The directory read now
  reports that entry with a `null` size instead of failing the listing; the
  entry still classifies normally (size is not used for classification).

## Verification

- Focused Vitest: 112 cases passed across draft classification, storage
  separation, draft writer list/discardStored, bridge list/discardId, the
  recovery feature (14 cases: survey classification, registry-failure survey,
  recover-through-import with the file retained and reclassified kept,
  incomplete-import no-op, kept/live rejections, discard gating and failure,
  removal eligibility, shared-original protection, non-directory rejection),
  and the architecture guard with the new imports.
- Real Playwright Chromium: all nine issue-209 specs passed. The wav-writer
  spec additionally proves the new worker path on real OPFS: a listing while
  the writer's handle is open reports the live draft with a `null` size, a
  listing after the files are closed reports the exact recovered length
  (262188 bytes) with its journal, and the finalized reply (cloned handle)
  still reaches the main thread and decodes.
- `npm run build` passed TypeScript and the production build, with the
  existing large-chunk notice. `npm run lint` passed with five existing
  unrelated warnings. `git diff --check` passed.

Commands:

```text
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/voiceoverDrafts.test.ts src/pipeline/voiceoverWavDraft.test.ts src/app/voiceoverWavBridge.test.ts src/app/voiceoverDraftRecovery.test.ts src/test/architecture.test.ts
npx playwright test tests/browser/issue-209-wav-writer.spec.ts tests/browser/issue-209-keep-place.spec.ts tests/browser/issue-209-transport-join.spec.ts tests/browser/issue-209-capture-owner.spec.ts tests/browser/issue-209-microphone-bridge.spec.ts
npm run build
npm run lint
git diff --check
```

## Qualification limit and next step

The recovery feature has no UI yet; Step 11 adds the voiceover controls
including the draft list with per-draft recover/discard/remove actions.
Physical microphone behavior remains for Step 12, which also runs the full
Vitest suite. Crash/reload, missing-file relink, save/reload, and
local-project-forget behaviors are covered by the focused cases above without
deleting any referenced media.
