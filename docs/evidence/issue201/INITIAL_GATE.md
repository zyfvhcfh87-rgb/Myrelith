# Initial gate evidence — issue #201

2026-09-08. Worktree: `.worktrees/issue201`; branch: `codex/issue201`.
Source baseline: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`.
Only the plan and issue-owned evidence are changed. No source code, product
schema, dependency manifest/lock, root HANDOFF/PLAN, or other worktree is edited.

## Source and isolation checks

`pwd`, `git branch --show-current`, and `git status --short` confirmed the
requested issue worktree, expected branch and clean starting tree. Git commands
use `DEVELOPER_DIR=/Library/Developer/CommandLineTools`. The private
`node_modules` is a directory, not a symlink (241 MiB at inspection).

Read COORDINATION.md, local AGENTS.md and architecture rules plus #68 caption,
working-agreement and current-state HANDOFF/PLAN context. Read the full issue
#201 body from the orchestration snapshot. Reviewed the current caption domain,
file controller, project validators/migrations, sequence identity handling,
shared painter/layout and media-job/admission authorities. Read the Transformers.js
skill and verified external library/model behavior against pinned source.

## Focused unchanged-caption baseline

Command, run in the issue worktree:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
NODE_OPTIONS=--no-experimental-webstorage npm test -- \
  src/domain/captions.test.ts src/domain/captionFiles.test.ts \
  src/state/captionStore.test.ts src/app/captionFileController.test.ts \
  src/ui/CaptionEditor.test.tsx --maxWorkers=2
```

Exit 0: **5 files / 34 Vitest tests passed**, plus **17 repository runner checks
passed**. Vitest duration 1.25 seconds; this is not a caption-performance
benchmark. Full output: [caption-baseline.txt](caption-baseline.txt).
No unrelated suite failure or full-suite pass is claimed.

## Candidate measurements

Reproduce the bounded read-only upstream measurements from this worktree:

```sh
node docs/evidence/issue201/measure-package.mjs
node docs/evidence/issue201/measure-upstream.mjs
```

Public network read permission is needed. Scripts write downloaded raw
archives/model files only to ignored `.tmp/issue201-package-probe` and summarized
measurements to the issue evidence folder. They do not run model inference,
execute dependency install scripts or mutate package.json/package-lock.json.

- All selected model assets were downloaded; graph hashes match upstream LFS.
- Both npm archive integrity checks passed; runtime member bytes/gzip sizes and
  digests were measured without extracting arbitrary archive paths.
- The pinned source lockfile and license/notice/model-card contents were hashed.
  Nested browser dependency resolution is recorded, including exact versions
  and public registry license metadata.
- `node --check` validates the measurement scripts' syntax.
- `git diff --check` is required again on the staged review diff before commit.

The first restricted-network attempt failed with `ENOTFOUND huggingface.co`;
the authorized public metadata/download calls then succeeded with network
permission. No user project media or caption text was sent. No legal agreement
was accepted. Two exploratory source searches referenced old nonexistent flat
project-validator/text-layout paths; source discovery resolved the actual
`projectFile/` folder and `domain/textLayout.ts` before the contract was written.

## Deliberate qualification limits and next gate

No product implementation, inference, actual HTTP compression/transfer trace,
browser cache/OPFS measurement, resident-memory measurement, real Chromium
caption acceptance, full suite, production build/lint or production audit is
claimed by this documentation gate. Inference and heavy validation require the
orchestrator's exclusive slot. The first model decision is a concrete measured
candidate with explicit remaining enablement blockers, not an approved runtime.

Requested decisions: review/approve or correct the plan and ASS/style/batch
contracts; allocate the timeline migration later; authorize and schedule the
separate pinned model lab. Optional dictionary/translation assets are proposed
absent with explicit status. If the required speech path receives a final
NO-GO, #201's mandatory speech criteria remain unresolved; do not close the
issue on caption-only work.
