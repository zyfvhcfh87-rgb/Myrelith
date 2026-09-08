# Title keyboard and dialog executable checkpoint

Source preparation only; native execution requires the supervisor's separate grant.
Implements the accepted [proposal](keyboard-focus-proposal.md) and remaining title
accessibility row in the [acceptance matrix](remaining-acceptance-matrix.md).

The supervisor subsequently assigned integration
`580de54f85c877d1d746c9a5b201b1aa4ac3ef4d` so this gate includes the actual shared
Animation workspace and its focus layout. Draft `d7efdde` was preserved first;
the conflict-free sync is `5bca9bf8041f6dd25d64de2acd87046e13000f4d`. Production
source originally matched that assigned integration. The later title scroll-padding
correction is tested at `4727236`; its partial result and closed-select Home failure
are preserved at `a2bc52c` ([second failure](keyboard-second-failure.md)). This
revision changes only the native fallback keyboard sequence and its observations;
all product code matches tested `4727236`.

## Fixed execution and source ownership

- `tests/diagnostics/issue200/keyboard.gate.ts`: exactly four cases, controls/status
  and dialogs/cancellation independently at 1280×720 and 720×800. The viewport is
  set before entry, one worker, zero retries, maxFailures 1, 60 seconds per case.
- `keyboard-client.ts`: canonical bounded fixture plus passive state, geometry,
  paint, native-key and session observers. No focus, CSS, scroll or layout-store
  mutation. `keyboard-model.ts` contains pure rejection predicates.
- `keyboard.playwright.config.ts`: the accepted private muted headless Chromium
  configuration on 5200, complete success/failure traces and failure screenshots.
- `docs/evidence/issue200/run-keyboard-browser.py`: exactly the accepted first-paint
  runner after three name substitutions (`FIRST_PAINT`, `first-paint`, `first_paint`
  to keyboard counterparts). Its 600-second deadline, bounded stdout reads,
  observed process identities, TERM/KILL rules, source checks and artifact hashing
  are unchanged. Its inert 12-test runner suite uses the same substitutions.
- `verify-keyboard-source.mjs`: requires the exact worker directory/branch and a
  clean tree; freezes all tracked file hashes and HEAD. Production, dependencies,
  other tests and accepted G3/first-paint harness files must match the assigned
  tested `4727236` checkpoint; only `keyboard.gate.ts` may differ under source/test
  paths. Earlier CSS and pure regression are now frozen with all product code.

The later grant uses a new external `/private/tmp/issue200-*` artifact directory,
`ISSUE200_KEYBOARD_ARTIFACTS` and `ISSUE200_KEYBOARD_MANIFEST`. The committed
checkpoint's manifest must be recorded and verified before launch. Keep the
established owned outer shell/awake guard and its identity receipts. No shared
server reuse, extra case, corrective rerun, encoder, full suite or benchmark.

## Fixture and actual keyboard boundary

The established real launcher entry is followed by canonical portable
leave/open/activate and initial clip selection. The fixture is 1920×1080, 100 title
frames, fixed playhead 12; its single expanded element is `root-element`, named
Text, unanimated, at X/Y 0 with identity scale and centered anchor. Text is
`Keyboard title`, box 800×180, size 48, literal family `Missing Keyboard Face`
and explicit `serif`. Dormant sequence intent remains in the full portable file.

One real Focus Inspector activation is declared setup. Its pressed state and
unchanged project/full history are recorded. Thereafter every claimed selection,
edit, dialog action and focus cycle uses actual `page.keyboard` input. There is
no locator focus, forced click, DOM-dispatched keyboard event or injected scroll.
Native Tab/Shift+Tab searches stop at 128 steps per target / 512 total per case.
Every observed active element retains stable DOM identity, role/name evidence,
DOM order, rectangle, clipping ancestors and their scroll offsets.

A separate passive keydown ledger retains trusted flag, target identity, key and
modifiers, capped at 2,048 events. Empty, synthetic or truncated evidence fails.
Native select popup navigation may consume some keys in the browser; the actual
DOM keys and resulting exact state/history are both retained.

## Exact four-case assertions

**Controls/status, at each viewport:** inspect sole-element disabled boundaries;
add a rectangle, keyboard-select both and then the rectangle alone, reorder and
delete it. Require fresh ID, exact ordered elements, the rest of the entire project
unchanged and one past entry per accepted edit. Selection preserves full history.
Enter X=20, then blur, creates one edit; draft X=45/Escape/blur preserves exact wire
and complete past/future. ArrowRight moves X to 21, Shift+ArrowUp moves Y to −10,
and Resize ArrowRight changes only width 800→802. The actual Commands/Undo path
restores the exact pre-resize project, past count and one redo entry at frame 12.
The shared command's geometry is retained separately for supervisor disposition.

Safe guides change no project/history. Both 90%/95% rectangles match observed
canvas-relative geometry to 0.1 CSS px precision, use dashed strokes and remain
hidden from accessibility reading order; their checkbox label is captured.
The actual enabled option order is retained and checked: No fallback, sans-serif,
serif, monospace, cursive, fantasy, system-ui. Starting at serif, Space opens the
native popup, two ArrowUp presses navigate to No fallback and Enter commits.
Space, two ArrowDown presses and Enter restore serif. Read-only `:open` predicates
check opening/closing; exact wire and full history must remain unchanged after
navigation before each Enter. Each accepted selection still creates exactly one
edit. DOM value and original literal fallback assertions both apply. Missing and restored status
text, literal family, exact history increments and restored project wire are checked.
This is status/keyboard evidence; it repeats no glyph or export matrix.

After the retained third failure, the supervisor explicitly permits one scoped
qualification: if Space leaves the popup closed for the existing wait, require the
select to remain focused/serif and exact project/full history unchanged. Record an
`unverified` test annotation and evidence event, then return from only the final
native font-selection segment. Read errors still fail. All other controls/dialog
cases continue; if the popup opens, original selection assertions apply unchanged.
Reported case passes must prominently retain this unverified segment. The headless
cause is not definitively proved, and no native font selection is claimed.

**Dialogs/cancellation, at each viewport:** open Roll / crawl by keyboard and
check modal semantics, initial focus and exact forward/reverse DOM control order,
full wrap and focus containment. Change direction to down and preview frame to 48;
Preview motion owns a title preview without changing project/history/playhead.
Escape releases it and returns focus to the exact opener. A declared second open
exercises keyboard Cancel independently. Save title template checks real loaded
library entries, name typing, focus order/wrap, Escape/opener focus and unchanged
entries/project/history. The toolbar library dialog checks all three builtins,
second-builtin pressed state and matching review, destination label, reachable
Apply/Cancel and Escape/opener focus, with no insertion.

## Layout, paint and evidence limits

Every targeted title control and every forward-traversed dialog control must be
fully inside its visible ancestor clipping region and viewport, with visible
keyboard focus and readable labels. Title field/action/list containers cannot
have horizontal overflow. Modal outer bounds remain inside 16 px viewport margins;
native focus-induced internal vertical scrolling is recorded and allowed.
Exact forward/reverse order prevents a repeated focus target from faking traversal.

Computed color/background/opacity evidence resolves observed leaf-to-root layers,
including nested group opacity. Unknown colors, gradients/images, filters/blending
or missing opaque ancestors fail closed. Ordinary text/label/status contrast must
be at least 4.5:1; computed focus-outline contrast must be at least 3:1 with a
nonzero visible outline. Preserve the raw outline style and complete screenshots:
UA `auto` outlines and canvas-overlay backdrops also require visual review before
acceptance. Computed DOM evidence is not an actual VoiceOver session, certification,
or proof of every native focus-ring pixel. A mismatch requires review, not waiver.
Surrounding workspace clipping remains separately recorded for the supervisor;
a clipped title control or dialog still fails this gate.

Every control checkpoint writes its PNG, accessibility snapshot, full state and
current event ledger. Complete console warning/error and page-error arrays remain
active through explicit page close. Project/save/recovery and library subscriptions
remember transient errors; the 256-event session ledger cannot overflow silently.
Teardown retains the final page/state, awaits canonical project leave, verifies
home/idle/no preview, disposes every subscription/listener, closes the page and
then saves final problem arrays. Every failure remains visible in artifacts.

After the one later-granted run, verify every artifact hash and success/failure
trace, inspect every distinct requested PNG, and independently prove native,
outer and awake identities absent plus port 5200 clear. Release the exclusive
slot immediately, preserve the raw result, and await review before any correction.
