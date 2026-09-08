# Narrow title field label

The a1547a3 targeted run passed the complete wide dialog case, including the
forward route, all three modal focus cycles, native Direction selection, preview,
cancellation, opener restoration and unchanged project/history/library. The
narrow controls case then failed the unchanged full-label visibility assertion
for Explicit font fallback. Narrow dialogs were unrun. Result: one passed, one
failed, one unrun, zero retries, 14.067803 seconds. Raw evidence remains at
`/private/tmp/issue200-keyboard-a1547a3-01`.

The 720x800 screenshot confirms actual clipping. Inspector region y=131..369;
focused select y=141.84375..160.84375; associated label y=121.84375..160.84375.
The input fits but 9.15625 pixels of its label are above the clipping edge.
The existing title-only scroll-padding now reserves 2rem at the top, covering
the label above a field, while preserving the established 0.5rem bottom padding
for checkbox labels/outlines. No focus, geometry or contrast predicate changes.

All 16 captured processes and port 5200 were confirmed released at
2026-09-08T22:13:50.176396Z. No browser, observer or cleanup errors occurred;
the report's extra error is the expected maxFailures stop notification.
The native font-popup segment was not reached in the narrow case, so the original
clipping failure is preserved without a font-popup qualification.

The existing three-case remainder configuration is unchanged. Successful wide
controls from 16e3688 and wide dialogs from a1547a3 remain recorded. A parent
grant is required before another native run; no new test or evidence package.

Remaining assumptions were checked once against this layout: fallback is the
last focused field in the controls case; subsequent operations use that same
select and the title-font notice. Both viewports give title dialogs the same
560px width, and the narrow viewport has 80px more height, preserving the
already-passed modal field geometry. App TypeScript and diff checks passed.
The changed CSS requires native confirmation; no production build was repeated.
