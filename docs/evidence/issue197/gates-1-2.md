# Issue 197 — local workflow acceptance, 2026-09-06

Starting tree: merged master `573cb45`. Gate 1 commit: `004a429`.
This evidence covers copy/paste/reset and local static presets, not the complete
parent issue or the later rendering/resource gates.

## Passed

- Gate 1: 242 focused Vitest tests in six files and 17 repository runner checks.
  Covers global/dormant/orphan identity reservation, immutable snapshots,
  trimmed/retimed/frozen source-time rebasing, out-of-duration keys, unknown
  preservation, append/replace, locks/budgets, atomic history and stale sessions.
- Gate 2: 60 focused tests in seven files and 17 runner checks. Covers exact
  versioned parsing, bounded primitive payloads and UTF-8 byte/count ceilings,
  resource rejection, duplicate names, corrupt siblings, future read-only
  versions, snapshot saving, quota failure and no library history entries.
- Production build/typecheck and oxlint pass. Existing large-chunk advisory
  remains; it is not an effect-workflow test failure.
- Four muted headless Chromium cases pass in 15.4 seconds. Fixtures import a
  real generated PNG through the app importer. Native controls perform copy,
  preset save, search/filter, rename/delete and apply. State setup chooses
  selection/playhead; rendering is the actual Program Monitor.
- Copied animation and saved static values produce matching preview pixels.
  Presets resolve exposure at timeline frame 15, retain future descriptors,
  instantiate distinct ids on two clips, and produce one undo entry.
- Real IndexedDB survives page reload and a new project. Injected put failure
  aborts the transaction, preserves the prior entries and displays failure.
  A future envelope remains byte-for-byte unchanged and Save stays disabled.
- Keyboard opening/focus, Escape, dialog target descriptions, stale project
  replacement and missing-plugin status pass. Page title is Myrelith, preview
  is nonblank, no Vite overlay is present, and captured browser warning/error
  arrays are empty.
- Desktop 1440×900 and 1280×720 screenshots were reviewed. A narrow in-app
  browser additionally exercised native text creation, copy and dialog
  navigation. Its explicitly selected safe mode is not plugin acceptance.

## Corrections made during verification

The cumulative-byte test exposed quadratic scanning of long plain strings in
an early resource regex (roughly 59 seconds). Replacing that scan with a linear
substring check brought the full parser file to 14 ms on the recorded run.
The same large payloads remain in the regression test.

The browser filter needed an explicit control label for exact label lookup.
The Inspector's action groups also needed their own rows to avoid squeezing
buttons into narrow columns. Both corrections passed a fresh browser run.

## Remaining acceptance

No claim yet for new pixel algorithms, track/master effects, trusted-plugin
coexistence with the new workflows, original-media export/reopen, complete
suite health or final aggregate resource accounting. Those remain the later
approved gates in EFFECT_WORKFLOWS.md. No GitHub publication or closure occurred.
