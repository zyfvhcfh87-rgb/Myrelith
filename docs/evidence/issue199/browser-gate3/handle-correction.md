# Gate3 source correction — no-motion Bezier handles

Parent reproduced the defect against accepted87d8032: a pointer down/up at
handle cx+2,cy+2 without a move changed history1→2 and x1 .42→.62. Its ignored
reproducer/config/log hashes are retained; those files were not changed. This
was independent parent component evidence, not a reached browser assertion.
Our browser run had already stopped at the separate Animation entry overlap.

The new committed component regression independently reproduced7 failures /
1pass /13skipped against unchanged curve code (entry-only547adc9). It covers
both handles at the center and±2px inside the hit circle, plus sub-threshold
jitter, with populated redo and an existing clipboard. The passing center case
is retained; exact state is required for every hit point, not only centers.

Correction: record the initial pointer coordinates and authored easing, wait
for3px of actual movement, and cancel a click/sub-threshold release without
planning a commit. Real drag values are derived from displacement relative to
the original grip, preserving the offset within the hit circle. Returning to
the exact grip returns exact authored easing rather than re-interpreting pixel
rounding. Existing0..1 handle bounds, rAF admission, selection pinning and final
atomic commit remain unchanged. No evaluator, title/path guard or other
workspace contract changes.

Final7 focused files /98 Vitest tests plus17 runner checks, production build,
lint and diff checks pass. Both handles are covered for admitted preview then
one real commit, lost-capture/Escape cancellation, zero motion, jitter and
return-to-grip no-op. No-op checks preserve the exact store object, easing,
clipboard and populated redo. Product fix is only AnimationCurve.tsx; the shared
workspace test is extended. Entry-only547adc9 remains a separate prior commit.

Browser rerun remains required and ungranted after the product failure. Current
harness deliberately remains pinned to87d8032, so it must be reviewed/repinned
before launching against the corrected source. Both1440x900 and720x900 layout,
native no-motion hits on both handles, Timeline return focus/viewport, mapping,
sibling previews and large-document observations remain pending. No native
browser result is inferred from the passing component suite.
