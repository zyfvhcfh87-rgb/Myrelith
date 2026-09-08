# G3 source checkpoint — authoring, templates and generated motion

Authorized after corrected G2 acceptance. This work starts from the exact approved
schema24/tracking integration e6a64a7, merged cleanly at05b370a. It preserves all
historical G2 failures, diagnostic evidence and the accepted corrected result.
The schema remains24. No production rendering context settings changed.

Implemented: accessible ordered element selection, static numeric/style editing,
add/duplicate/delete/reorder, multi-edit, explicit compact Upgrade, persisted
literal-font fallback, pointer/keyboard movement and transformed-corner resize,
90%/95% safe guides, local template capture/use/delete and three editable builtins,
and roll/crawl Preview/Apply/Reapply using ordinary shared scalar keys. Template
fitting is explicit, uniform and centered; rate differences preserve exact local
frame numbers and duration. Instances allocate fresh IDs including orphan lanes.
Library writes are independent of history; project edits remain one transaction.

No duplicate animation state or custom timer is introduced. Animated gestures use
planSetAnimationKey; generated motion uses planAnimationInsertions; geometry and
motion samples use the canonical element resolver. Unavailable/future/orphan
animation retains its status even in sampled previews. Partial multi-selection
surviving Undo is reconciled by stable identity. The final shared #199 workspace
wiring is **pending supervisor-accepted sync**, not claimed delivered here.

## Focused validation

- **21 focused files / 280 Vitest tests passed**, plus all17 bundled runner checks.
  NODE_OPTIONS=--no-experimental-webstorage; maxWorkers2. The runner checks are
  unit checks of runner logic, not a browser or performance execution.
- Production build/typecheck passed. Existing Vite >500kB chunk advisory remains.
- oxlint passed without warnings after correcting four initial draft warnings.
- Diagnostic/G3 observer/harness TypeScript check passed; the six G3 tests list
  without starting a browser. Node source-guard syntax check passed. Python runner
  compilation passed using an explicit workspace-local bytecode path; the first
  default-cache compilation hit the sandbox's macOS user-cache write restriction.
- Diff hygiene passed. Built output contains none of the new fixture/protocol
  markers titleOwnerFixtures, Title G3 authoring or issue200-g3.

Logs and SHA256 are in g3-source-validation/. Readable log copies normalize
trailing whitespace; raw-logs.tar.gz preserves the original bytes and original
member hashes. Focused checks cover pure geometry,
ordinary generated keys, content/font/style, same/different-canvas templates,
portable reopen/history, ID remapping, count/range/padding rejection, stale and
reentrant sessions, preview priority, actual app/store boundaries, pointer and
keyboard interruption, storage completion/abort/blocking/unknown envelopes, and
existing animation/mask/grading/tracking/caption/Inspector integration.

## Draft review corrections

A supported template and an unavailable future sibling can share an ID. Lookup
now selects the validated supported record; deletion removes only that record.
Both input orders have deterministic regressions retaining the future sibling's
complete canonical stored JSON. Unknown siblings are never removed by ID filtering.

The 64 MiB retained title contract includes every named preview, even hidden ones.
The shared app admission facade and real document-store commit boundary project
all five owners. Every production publisher now checks that cumulative admission.
An exact64MiB test combines48MiB history with16MiB across hidden/visible preview
owners, adjusted for the measured current title. Title preview and real store
candidate growth reject without clearing redo; releasing an owner permits growth.
A separate five-owner fixture proves immutable shared subtrees are charged once.
Replacing a title draft releases its payload but keeps its activation order under
later preview owners, and final cleanup releases only its own slot.

## Remaining gates

The bounded six-flow protocol is g3-authoring-protocol.md, with a separate clean
source manifest and owned native-process runner. **No G3 native/browser/full-suite,
encoded-export or performance gate has run.** This checkpoint requests source and
protocol review before an exclusive browser grant. G2's narrow720px workspace and
six test-readback advisories remain qualified; no broader green claim is made.
Final #199 workspace sync/wiring, observable authoring acceptance and G4 remain.
