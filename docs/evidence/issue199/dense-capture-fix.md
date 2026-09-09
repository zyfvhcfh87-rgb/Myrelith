# Issue 199 — preserve captured bucket identity during dense preview

The preserved large run at `4f825bd...` acquired capture on a two-key bucket,
then lost it when preview admission disconnected that bucket's `<g>`. The exact
events, 1,024-key selection and full failure state are retained in evidence-only
commit `403af547e5f9d32ef65117f14f8970c424319e97` and `large-attempt1/`.

The renderer divides its normal glyph budget by two while a preview is present
to reserve room for ghosts. Dense bucket boundaries consequently change. React
keys previously used each bucket's first key offset, so the captured element
could be removed even though the lane, source document and selection remained.
Its later capture-loss event could not reach the detached element's handler,
leaving the gesture preview active.

The pointer hook now retains the captured lane id and original bucket offset
for the gesture's lifetime. The grid keeps that original React key on the new
bucket containing the offset. This reuses the actual capture-owning DOM element
while its label and bucket contents regroup. Bucket ranges are disjoint, so that
offset belongs to one bucket and cannot duplicate another bucket's key. The
existing gesture cleanup clears the captured identity and releases capture.

The density algorithm, ghost budget, 512-glyph bound, exact 1,024-key selection,
native harness and all native assertions remain unchanged. The change adds no
extra glyph or hidden capture target, and does not lower the selected key count.
Only `AnimationGrid.tsx`, `useAnimationPointer.ts` and the workspace component
test change; there is no domain, engine, persistence or configuration change.

## Regression and validation

Three component cases use 100,000 authored keys, all 1,024 available scalar keys
selected, a nonempty redo branch and nonnull clipboard. Each reproduced the
disconnected captured element at preview admission before the fix. Each passes
afterward for release commit, actual handler capture-loss cancellation and Escape.

The cases verify the same element remains connected across a changed bucket
label, continued preview movement, all 1,024 preview keys, and at most 512 total
glyphs including ghosts. Commit moves every key by the exact integer delta in
one history entry and undoes to the original project reference. Cancellation
preserves project/history/clipboard references, clears pending preview work and
does not revive on later movement or release. Capture release occurs while the
target is connected. Browser capture remains a separate native gate; these tests
use jsdom events and capture-method stubs.

The first regression setup omitted the existing source descriptor and therefore
could not seed its redo branch. That setup-only failure is retained separately;
the descriptor was installed before the actual disconnected-node red result.
No product fix was applied between the corrected fixture and those three red
failures.

Validation completed: 64 focused tests across the workspace, editing
controller and architecture, plus 17 runner checks, repository lint and the
explicitly granted production build. Its existing chunk-size advisory remains
in the build log. The parent independently passed the same three regressions
and accepted the exact three-file patch before granting the build. The
source-hash record covers all 242 frozen paths: exactly three changed and 239
unchanged from product `75b89ef...`. All native harness, protocol and fixture
hashes remain unchanged. Normalized log copies retain raw-file hash mappings.

The parent conditionally granted one unchanged large segment after a clean
commit, source-identity metadata freeze, full hash verification and SHA recording
before launch. Native acceptance for this fix is still pending at this source
checkpoint. No native rerun, full suite, export, performance run or integration
sync has been performed for this correction. The accepted 34/34
gestures and 13/13 editing results apply to their recorded earlier source, not
automatically to this new product patch.
