# Issue #209 — Step 10 Drafts and reconnect

Date: 2026-09-28. Branch/worktree: `codex/issue209`, `.worktrees/issue209`.

## Delivered

The recordings directory (`myrelith-recordings-v1`, deliberately outside the
disposable `myrelith-derived/*` namespace) is an explicit product surface.

The pure domain layer (`domain/voiceoverDrafts`) combines remembered file
handles from every local project, capture-session ownership, and directory
metadata into `kept`, `live`, and `orphaned`. A null file size means a writer
still holds the OPFS sync-access lock, so the draft is treated as `live` even
when that writer belongs to another browser tab. Registry enumeration includes
both current and legacy keys; a registry read error still fails the survey
closed. Forgetting a project from Recents does not erase its media grants, so
its recording remains protected while no project is open.

The worker's metadata-only `list` reports exact sizes and journal presence
without reading whole takes. It reports a null size only for Chromium's
`NoModificationAllowedError` while a writer owns the file; other storage
errors surface. `discardStored(id)` is idempotent and never touches the
worker's own draft. The recovery feature has a dedicated worker, imports a
checkpoint through the ordinary media path, and keeps its file as the imported
asset's original. Recovery stops if the local project changes during an await.
The media import controller also checks project generation, protecting against
reopening the same portable project id while inspection is in progress.

Removing a kept original proves that the remembered file handle is the same
OPFS directory entry, so a same-named ordinary local WAV cannot be mistaken for
the recording. It checks media use in the current project and every undo/redo
snapshot, including dormant/nested sequences and multicam angles. It blocks if
another project remembers the recording, and when same-project assets share an
original it clears each grant and disconnects each asset together. Content or
project changes during asynchronous checks cancel removal before the delete.
The project descriptors remain after safe removal, enabling the existing
missing-source and manual-relink flow.

## Browser-only findings

- A pre-commit change had tried to transfer the finalized file handle in its
  worker reply. Chromium rejects that with `Value at index 0 does not have a
  transferable type`; the worker now posts without a transfer list, and the
  main thread receives a working cloned handle.
- `createSyncAccessHandle()` fails with `NoModificationAllowedError` while
  another access handle holds the file open. The listing now records a null
  size, and the classifier protects that draft as live, including across tabs.
- Real Chromium verified the registry can enumerate handles from separate
  local project bindings, an OPFS handle matches its directory entry with
  `isSameEntry`, another project's grant blocks removal, and removal succeeds
  after that grant is forgotten.

## Verification

- Full Vitest: 5,502 tests passed across 417 files.
- Focused recovery, registry, writer, and media-import tests: 106 passed.
- Real Chromium: all 10 Issue 209 browser tests passed, including the new
  cross-project ownership and OPFS identity gate.
- `npm run build` passed TypeScript and the production build. It retains the
  existing large-chunk notice.
- `npm run lint` passed with five existing warnings in caption tests and export
  cleanup code. `git diff --check` passed.

Commands:

```text
NODE_OPTIONS=--no-experimental-webstorage npm test
npx playwright test tests/browser/issue-209-*.spec.ts
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
