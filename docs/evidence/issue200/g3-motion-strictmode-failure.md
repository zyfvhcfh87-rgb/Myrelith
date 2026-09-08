# G3 motion failure and effect-lifecycle correction

The single granted unchanged run atcd24868fbc68a00d77c6d24a4e40196266135a2a used
957file manifest328a7b8fca1148e8bde2160a179ddd56ccad5f8c4c52c3daf2c77695b48b2b1b.
Start2026-09-08T18:48:25.407Z; report duration68471.179ms. One muted owned Chromium
worker,60second cases,600second runner,zero retries,maxFailures1 and scoped awake.
**2passed,1failed,3did not run.** The earlier1fff897 failure remains preserved.

## Bounded native outcome

Flow1 passed in4.1seconds: actual compact Upgrade/content/multi-element edit,
reorder and real command-palette Undo/Redo, with exact history/wire assertions.
Canonical portable open had empty history and healthy session; a real recovery
write completed (lastRecoveryAt1788893309570), and the screenshot displays
Recovery copy updated. No recovery mismatch was hidden or silenced.

Flow2 passed in3.3seconds: real pointer edit, Escape cancellation and safe guides,
plus both animated Move/Resize no-motion clicks and actual capture loss. The raw
JSON attachments independently confirm trusted pointer1 down/lostcapture and the
post-release native move with buttons1 before mouseup, plus exact project/history
preservation for each handle. Both canonical fixture opens retained exact wire
bytes and empty history. The two earlier flows and all their assertions remain
required in any subsequently granted six-flow run.

Flow3 failed at its initial motion dialog. Preview motion resolved to a real
button that stayed disabled until the60second test timeout. The screenshot shows
This review has ended, with both Preview and Apply disabled and no replacement
consent list. This is an actual product lifecycle defect, not a missing selector
or a reason to reopen/retry the dialog. Last3 flows remain unrun.

All3 complete browser warning/error/page-error arrays are empty through their
final screenshots. Every recorded project/save/recovery state is healthy. Raw
stdout separately preserves Node color-environment advisories. Six requested
1280×720 PNGs and7 JSON lifecycle/capture attachments are retained; the5 distinct
requested views were visually inspected, and the failure PNG pair is byte-equal.
Two observation entries point to internal temporary success-trace PNGs removed
by the frozen retain-on-failure trace policy. Successful traces were not retained;
all required screenshots/event attachments and the complete failure trace remain.
No screenshot/reference is invented or relabeled present.

Runner14 native identities plus outer1939/caffeinate1950 ended with no forced
termination, observer/cleanup error or survivor. Stdout completed; the600second
deadline did not expire. Fresh complete comm/command process tables and lsof at
18:50:08Z confirmed all16 PIDs absent, private Playwright executables absent and
port5200 clear. The supervisor independently confirmed at18:50:43Z. The exclusive
slot was explicitly released before source correction; no rerun occurred.

## Actual source reproduction and correction

The normal app mounts under React StrictMode. Motion effect setup starts a title
session; its cleanup cancels the session, whose onEnd callback marks stale=true.
StrictMode rehearses setup/cleanup/setup. The next successful setup did not reset
that flag, so the initial dialog remained disabled despite a newly admitted owner.

The supervisor's unchanged StrictMode reproducer failed2/2 before correction.
Our actual StrictMode tests independently failed6 motion cases on unchanged
cd24868 production source; the companion template case passed. The new correction
captures the session owned by each effect, ignores its onEnd callback after that
effect's cleanup begins, releases only the captured owner, and resets stale/error
only after successful fresh admission. A real end while the effect is live still
invalidates the review. No remount, retry, disabled-state waiver or controller
admission change is used.

All7 StrictMode cases now pass: immediate Preview/cancel without history, one
ordinary two-key Apply plus exact Undo, consent-required Reapply, terminal actual
selection/project/playhead invalidation even after returning the cursor/selection,
and teardown that preserves a newer title owner's preview. The template dialog
also works under StrictMode; its pure pin/read-revision cleanup does not have the
motion onEnd/stale pattern. Existing template project-change rejection is now
checked under StrictMode too. No template production change was needed. Inspector
and overlay cleanup were audited; neither has this effect-owned onEnd/stale pair.

The parent-owned two-case reproducer was run unchanged and passed2/2,640ms. Root
fixtures and the original parent RED logs were not edited. Focused acceptance:
6files/61Vitest tests plus17bundled runner checks pass. Production build/typecheck,
oxlint, observer/protocol TypeScript, six-flow discovery without browser launch,
production fixture-marker isolation and diff hygiene pass. Existing Vite >500kB
chunk advisory remains. This required build had already completed before the
supervisor's later build hold: raw-log creation18:57:59.793691Z through final write
18:58:07.333983Z. These are filesystem log bounds, not independently sampled
compiler process timestamps. The supervisor was notified to qualify any #199
large-fixture timing overlap; no further build is authorized while that slot is
held. The G3 native run above predates this source build.
Native runner/config and browser actions/assertions are
unchanged; no full-suite/performance run or integration sync occurred.

## Preserved evidence and next gate

Native bundle was completed before any source edit. Committed archive:
g3-cd24868-motion-failure.tar.gz,3800907bytes,45members with44 verified member
hashes. SHA2565d41269485789aa73461cc1bab7cae6974a3d242416f4f31501b2cf978de9f53.
It contains raw JSON/trace/PNGs, decoded exact attachments, complete native/outer
proof, source manifest and10 frozen source files. A derived audit's attachment
count was corrected8→7 after enumeration; the original audit and prior archive
remain preserved. Original artifacts remain at /private/tmp/issue200-g3-cd24868-01.
Source RED/GREEN/parent/focused/build/lint logs are in g3-strictmode-validation/.

This source correction has not run natively. Fresh exact source/protocol review
and an exclusive grant remain required. All six strict flows, clean recovery,
console/status checks, first-failure evidence and owned teardown stay required.
Final #199 workspace integration/wiring and G4 remain separate outstanding gates.
