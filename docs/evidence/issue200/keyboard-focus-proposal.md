# Remaining title keyboard, focus and narrow-controls protocol

**Source-only proposal; no executable change or native grant.** Prepare its exact
harness only after supervisor review, against the subsequently assigned source.
No product fix or integration sync is authorized here. This addresses the open
accessibility row in [remaining-acceptance-matrix.md](remaining-acceptance-matrix.md).

## Observed source contracts

`TitleInspector.tsx` exposes the named Title authoring section, ordered checkbox
selection, labeled backward/forward/add/duplicate/delete buttons and numeric
alternatives. `InspectorFields.tsx` commits numbers on Enter/blur and cancels drafts
on Escape. `TitleOverlayControls.tsx` makes Move/Resize buttons focusable and routes
arrow keys through the same edit facade: one project pixel, or ten with Shift;
default centered resize adds two box pixels for ArrowRight. These are existing
source/component facts, not a claim of complete native keyboard acceptance.

Motion, save-template and template-library surfaces use native modal dialogs.
TitleInspector and ToolButtons retain their actual opener and return focus on
close. CSS bounds title dialogs to viewport minus 32 px, enables internal vertical
scrolling and wraps title actions/fields. Existing Focus Inspector is a real
workspace control, not a test-only layout adjustment. Actual focus cycling, label
visibility and narrow control reachability still need native observation.

## Proposed bounded run

Four cases: the two flows below independently at **1280×720** and **720×800**, with
the viewport set before entry. One private muted headless Chromium worker, port
5200, 60 seconds per case, zero retries, maxFailures 1, 600-second owned outer
deadline. No encoded export, benchmark, full suite or repeated first-paint matrix.
Use the established source guard, owned-process cleanup, full success/failure
traces and artifact hashes after adapting only the separately reviewed paths.

Enter through the real app and install the bounded expanded title using canonical
portable leave/open/activate, keeping exact wire/history/session evidence. The
fixture has one centered, unanimated text element named Text with identity scale,
centered anchor, visible box, and literal `Missing Keyboard Face` with explicit
`serif` fallback. Its project frame, geometry and initial history are fixed in the
executable proposal before review; no runtime adjustment can rescue a clipped control.
The existing Focus Inspector action may be used once as declared workspace setup at
each viewport; record its effect and the unchanged project. Never modify CSS,
layout stores or scroll positions from page.evaluate to make a control reachable.
If the ordinary entry path is blocked, preserve it for root's disposition.

Use actual Tab/Shift+Tab traversal, Enter/Space and typed keys for all claimed
keyboard interactions. No `.focus()` or synthetic DOM key events satisfy traversal.
Limit searches to 128 Tab steps per target and 512 per case, recording the actual
active element's role/name/order, rectangle, scroll-owner rectangle and focus-visible
state. Exceeding a bound fails. DOM/AX reads and app imports are fixture setup,
passive evidence and exact state comparison only. Native focus-induced scrolling
inside the Inspector or dialog is allowed and must be recorded.

### Flow 1 — editable controls and direct-manipulation alternatives

1. Traverse to the title element checkbox, toggle with Space and inspect selected
   stable IDs. Add a rectangle with keyboard activation; select it, move it backward,
   and delete it through the named controls. Assert exact order/IDs/count and one
   history entry per accepted edit. Selection alone adds no project history.
   Add/duplicate/delete disabled conditions are recorded where exercised.
2. Reach Position X and enter a concrete value with Enter, then Tab away. Require
   one edit (blur must not add a duplicate). Type a different value, Escape and Tab:
   exact wire and full past/future history remain unchanged. Read label/step/value
   semantics from the actual number input, scoped to Title authoring.
3. Traverse to Move title element Text and use ArrowRight then Shift+ArrowUp.
   Require exact +1 X/−10 Y changes through history, without moving the playhead.
   Reach Resize title element Text and ArrowRight: default centered geometry grows
   box width by two project pixels, with one history entry. Use the real undo
   command to verify the accepted edit is reversible. Keep existing pointer and
   animated-capture acceptance from G3; do not repeat those tests here.
4. Reach the labeled 90%/95% Safe guides checkbox and toggle with Space. Record
   guide DOM bounds against project geometry, hidden-from-AX guide strokes and the
   accessible explanatory label. Exact project/history stays unchanged. Retain
   a page screenshot showing the focused control and guides at each viewport.
5. Keyboard-select No fallback in Explicit font fallback, then restore serif.
   Require the unavailable and explicit-fallback messages in the actual status
   reading order, with readable contrast and a captured page at each state.
   Each selection creates exactly one accepted history edit; literal family stays
   fixed and the final project wire equals its pre-selection value. This checks
   keyboard/status semantics, without repeating settled glyph/export acceptance.

### Flow 2 — dialogs, focus, reading order and cancellation

1. Reach Roll / crawl… by Tab and open with Enter. Verify named dialog, visible
   initial focus, logical field order and actual Tab/Shift+Tab wrap inside it.
   Keyboard-edit direction and preview frame, activate Preview motion, then Escape.
   Require the title preview to release, exact project/history to remain unchanged,
   the playhead to stay fixed, and focus to return to the same opener.
2. Reopen through that opener and Cancel with keyboard activation; recheck return
   focus and unchanged history. This is a declared independent cancel path, not
   a retry after failure or correction of a stale dialog.
3. Reach Save title template…, open with Enter, type a template name, inspect
   form reading order and focus wrap, then Escape. Require focus on its opener,
   unchanged project/history and unchanged saved-library entries. The real IDB
   save/use/delete path already has G3 acceptance and is not rerun for this slice.
4. Reach the toolbar Title templates button by keyboard, open its named dialog,
   change a builtin with keyboard activation and verify its selected state/review.
   Check the destination-track label and reachable Apply/Cancel controls without
   inserting. Escape returns to the exact toolbar opener. Retain dialog/focus
   screenshots and actual accessibility text at each viewport.

## Layout, readability and failure rules

For each focused title control, require a visible usable rectangle within its
scroll owner's visible region and the viewport; labels and focus indication must
be readable. Title field/action/list content must not require horizontal scrolling.
Dialogs must stay within the CSS 16 px viewport margins; internal vertical scrolling
is permitted only when all actions remain keyboard reachable. Do not require every
long Inspector field to appear simultaneously or relabel a clipped title control
as acceptable merely because its DOM node exists.

Record computed foreground/background/opacity and focus-outline colors for title
labels, statuses and controls, resolving their actual ancestor backgrounds. Proposed
review minima are 4.5:1 for ordinary text and 3:1 for the focus indicator. Preserve
the measured ratios and screenshots; this is a scoped check, not accessibility
certification or an actual VoiceOver session. Expose unavailable/font notices and
dialog messages in the recorded accessibility reading order; unannounced or unreadable
status is a failure to review, not a waived detail.

Keep surrounding toolbar/timeline/workspace clipping in a **separate observation**
for root. Do not expand this slice into an editor redesign. A title-control or
dialog failure remains a failure; this distinction does not waive title acceptance.

Every case records complete warning/error/page-error and project/save/recovery
observations through final screenshot and canonical leave/explicit page close.
No warning or transient session error is silenced. Retain traces and all requested
images/JSON on both outcomes, prove every owned native/outer/awake PID and port 5200
are gone, then release the slot. A failed assertion stops the granted run. Preserve
and report the finding before any source change or new grant.
