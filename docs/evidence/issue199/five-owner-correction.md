# Issue 199 — five-owner preview correction

On merge `dae89eda7d2926fee09700dc311c324f2e7d204f`, Animation refreshed its
preview by releasing and reacquiring its arbiter entry. This promoted an older
Animation gesture above a newer mask, tracking, grading or title preview. Payload
replacement now retains activation order; cancellation still releases ownership
and reveals the appropriate sibling.

Grading now cancels on playback/scrubbing, refuses a new gesture during playback,
and checks currentness plus replacement ownership after cleanup before committing.
This prevents a cleanup subscriber's changed playhead, selection or new grading
session from receiving a stale commit.

Nine targeted regressions failed before correction and passed afterward. The
source-focused command passes **183 tests in ten files plus 17 runner checks**:
Animation editing, original title facade, new title/Animation integration, grading,
mask editing, mask tracking review, title editing/retention, Animation workspace
(including dense capture), and architecture. TypeScript and lint pass; lint has no
warnings. They ran with the separate G4 draft present, while the focused command
excludes G4 fixture/oracle tests. The parent explicitly deferred the production
build to its integration build; no native or export run occurred.

The existing `animationTitleIntegration.test.ts` is unchanged byte-for-byte.
New tests live separately in `animationPreviewIntegration.test.ts`. They verify
real canonical title-effect key edits/local ticks/undo, unsupported lane retention,
real title-versus-Animation ordering, and reset across all five retained owners.
Existing tracking-review tests preserve its intentional range-hide/reentry
behavior and stale source/selection guards. The canonical title-effect helper was
already consumed by the merged `animationOwners` and remains unchanged.

One merged workspace test expected the old title-refusal message for an absent
effect. The merged resolver checks absent owner/stage first. Its action remains
disabled and project unchanged; only the expected reason was updated. The earlier
184-pass/one-message-failure output is retained separately from the passing source
command. This was an integration expectation correction, not an unrelated-baseline
classification.

`five-owner-correction/verification.json` records exact source and raw/copied log
hashes. Raw logs are preserved under the owned `.tmp/issue199/`. This commit
contains only the correction, focused tests and evidence. G4 source/protocol
preparation remains a separate checkpoint. Earlier browser evidence qualifies its
observed source versions; this correction makes no new browser acceptance claim.
