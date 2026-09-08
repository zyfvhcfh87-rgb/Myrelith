# First G3 native authoring run — failed and preserved

The single granted six-flow run used frozen1fff8974e114eb1e10f05b3f246dfa28112421ab,
957file manifest45df6df636ac15e402fdaee42845a370e6da72f1e99441fc07c288952892aa70.
One muted headless private Chromium worker, no retries, maxFailures1,60seconds
per case,600second owned runner and run-scoped caffeinate. Playwright1.62.1 on
macOS arm64. Start2026-09-08T18:18:09.397Z; report duration61094.602ms.

**Failed:0 passed,1 failed,5 did not run.** The first flow timed out at the exact
Text content label selector after Upgrade. No subsequent flow, including the
trusted pointer-capture cases, was executed. No retry occurred. Source verified
clean before and after; no source change occurred during this run.

## Evidence and diagnosis

The retained screenshot, accessible tree and actual trace DOM show that Upgrade
worked: a selected Text title element, title monitor output, and a textbox with
the accessible name Text content are present. The field was below the visible
inspector fold; the failed locator did not resolve it.

The installed Playwright selector authority explains the mismatch: internal:label
uses complete normalized label text, including the controlled textarea's child
text. Its wrapping label therefore contains Text content plus the initial text.
The accessible role/name remains textbox / Text content. The same exact-label
risk exists for Explicit font fallback, whose wrapped select contributes option
text. The archive contains actual selector-authority snippets and their package
file hash, plus the original DOM/AX evidence. Exact accessible role/name matching
is the cohesive harness correction; no product label is weakened or relabeled.

The screenshot also exposes **Recovery copy failed**, specifically Recovery
journal belongs to a different document. The original fixture replaced the
project directly after the real new-project flow, leaving that project's recovery
session active. This is a fixture lifecycle defect that must be corrected through
the canonical app owner. It is not a harmless console warning and is not hidden.

The complete browser observation arrays through both final screenshots contain
0warnings,0console errors and0page errors. Raw process stdout separately retains
Node NO_COLOR/FORCE_COLOR environment advisories. The UI recovery failure above
means this is not a clean authoring result. The two1280×720 PNGs have identical
SHA256b49118efbeec9ae6ae628672386168b59ebb5814b462467e375342215d562bf0;
observed-end.png was visually inspected. Body bounds/URL/title were valid, zero
Vite overlays. JSON, AX snapshot, trace, screenshots and raw stdout are preserved.

## Native release

Runner finished18:19:10Z,exit1;600second deadline did not expire, stdout completed.
Its11 observed identities ended without forced TERM/KILL, observer/query/cleanup
exception or survivor. Outer raw native stderr log is empty. The run-scoped
caffeinate and outer shell are also gone.

Fresh complete executable and full-command process tables plus lsof at18:20:37Z
confirm all13 recorded PIDs absent, private Playwright browser executables absent,
and port5200 clear. The supervisor independently confirmed release. An earlier
broad command-substring inspection matched its own shell95432; that original
record is preserved and qualified, and no process was killed on that basis.
The definitive record is fresh-native-release-confirmed.json. The exclusive slot
was explicitly released before any source correction or further native work.

## Preserved bundle and source-only correction

Bundle: g3-1fff897-first-failure.tar.gz,3063595bytes,29members with28 recorded
member hashes independently recalculated during packaging. Archive SHA256:
949b3c407b7f57f63932c2213b2bab33245b53251c144892d51785da0d3c9923.
The archive was completed before editing this harness. It includes original
source manifest and six frozen runner/protocol/test files, raw report/observations,
trace/PNGs, complete native/outer snapshots and offline audit. Original artifacts
remain at /private/tmp/issue200-g3-1fff897-01 and sibling outer/evidence paths.

The supervisor authorized a source-only fixture/selector correction. All initial,
animated, unavailable-font and reopen replacements now use canonical
leaveActiveProject/openProjectFile/activateResumedProject, with exact portable
bytes, zero history and healthy-session assertions and attachments. Every feature
mutation remains real UI. Text content and font fallback use exact accessible
roles/names; numeric range and template-name fields were audited and use exact
roles too. All six flows and prior expectations remain. Flow1 requires a completed
real recovery write. The observer records session/save/recovery state at each
screenshot and rejects a final persistence error on completed flows.

Source checks:5 focused files/122Vitest tests +17bundled runner checks passed;
project activation/persistence/storage, title UI and architecture. Harness/observer
TypeScript, oxlint and six-flow discovery without browser launch pass. Production
src, dependencies, native runner and config are unchanged from accepted1fff897;
its291+17/build evidence remains historical, not relabeled as a new browser pass.
No redundant production build or native workload ran during this source-only
correction. New raw/readable source logs are in g3-lifecycle-correction-validation/.
Fresh exact source/protocol review and a separate native grant remain required.
