# Native fallback selection — keyboard sequence correction

Source checkpoint only. The second unchanged run and passed build are preserved
at `a2bc52cc4e39e824c55eb878e62ebe53e4af61b7`; see [retained failure](keyboard-second-failure.md).
No revised native run or additional production build has occurred.

The retained trusted Home key targets the actual focused SELECT identity 79.
Its value is serif, and the following full project/history remains unchanged.
The title control is an ordinary controlled native select with an onChange commit;
`isEditableTarget` and `shouldHandleEditShortcut` leave select keys to the browser.
The seven options are No fallback, sans-serif, serif, monospace, cursive, fantasy,
system-ui; serif is the third option.

Chromium's [select event handler](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/forms/select_type.cc)
returns before closed-select Home handling for the Mac arrow-popup behavior;
its keypress path opens the popup for Space, and native popup visibility controls
`:open`. This current upstream source supports the diagnosis, but is not a binary
identity match or a substitute for the required installed-browser run. The retained
failure remains the direct evidence. No product change is warranted by these facts.

The harness now reads and checks the actual enabled option order, verifies the
initial serif value, then uses Space, ArrowUp, ArrowUp, Enter to choose No fallback.
It restores serif with Space, ArrowDown, ArrowDown, Enter. Read-only `:open` checks
require the popup to open and close. Additional full snapshots require navigation
before Enter to preserve project/history. Final DOM values supplement the original
exact literal font, one-edit, history-prefix, project-only-change and restored-wire
assertions; none of those assertions are removed or weakened.

All earlier controls/predicates, dialog cases, cleanup and four-case declarations
are byte-identical to tested `4727236`. Product code, diagnostic client/model,
config, runner and pure tests are unchanged. The guard now pins `4727236` and
allows only `tests/diagnostics/issue200/keyboard.gate.ts` to differ under source/test
paths. Thus the previously corrected CSS and regression are protected as well.
There are no synthetic events, forced selection/focus/scroll mutations, extra
cases, longer deadlines, retries or changes to expected outcomes.

Two focused suites passed 16 tests in 1.29 seconds; the canonical test script's
17 runner checks also passed. Diagnostic TypeScript, lint, guard syntax and exact
four-case discovery passed. The unchanged product already passed the granted
production build on `4727236`. A new product build and browser launch are outside
this source-only checkpoint. No unit test attempts to simulate native popup input.
The [validation manifest](keyboard-select-correction-validation/manifest.json)
records four raw logs, changed-source hashes and nine frozen-file comparisons.
The original first and second failure archives remain unchanged.

The next boundary is supervisor review of this clean source checkpoint, followed
by a separately granted native attempt. That attempt retains the existing first
failure stop, zero retries, both viewports, exact predicates, artifact retention,
600-second owned runner and explicit process/port release.
