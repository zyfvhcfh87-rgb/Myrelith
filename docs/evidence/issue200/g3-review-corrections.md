# G3 review corrections — source only

This is a separate correction checkpoint after e31bcadb4d3a08ad56a7e14bc878469cc1525d62.
The original checkpoint, validation logs and historical G2 evidence are preserved.
No integration sync or G3 native/browser/full-suite/performance execution occurred.
The supervisor accepted these three product corrections in substance after its
independent unchanged six-case reproducer passed; exact source/protocol review
and an exclusive native slot remain required before the observable gate.

## Corrected behavior

- Matching pointer capture loss on either Move or Resize cancels the title
  session, draft and listeners. An unrelated pointer cannot cancel it. Normal
  pointerup clears the gesture before releasing capture, so its consequent lost
  event cannot cancel the completed edit. A later up after loss cannot commit.
- A stationary pointer click, or a drag returning to its origin, selects/cancels
  without creating interpolated-frame keys or changing history. Both the UI
  finalization and pure gesture planner enforce zero-displacement no-op behavior.
  Actual nonzero drags and arrow edits retain their one-edit behavior.
- Library summaries, lookup and deletion share one parsed set of accepted
  record/index pairs after structural AND duplicate ID/name validation. With
  A(first,N), B(chosen,N), C(chosen,Valid), the displayed C is the record used or
  deleted. B survives unchanged. Existing future-sibling preservation remains.

The six-flow protocol retains every original assertion. The direct manipulation
flow now uses actual native no-motion clicks on both animated handles and compares
portable project bytes plus complete past/future history contents. Each capture
case requires an actual trusted captured pointer, a release request, the next
native held move, and a trusted same-pointer loss before mouseup. Pre-release
moves are cleared from the evidence. Preview must be gone before up, and project
and history must remain identical afterward. Per-handle observations attach even
on failure. Browser execution is still pending; source tests do not prove native
pointer dispatch.

The runner no longer waits for EOF through a blocking stdout iterator. A
nonblocking select/read loop checks the 600-second deadline during silence or
continuous output. EOF with a still-running launcher has a bounded wait too.
Timeout is always failure, records incomplete stdout explicitly, and reaches
TERM followed by KILL independently of pipe closure. Each escalation refreshes
PID/start/command identity and can discover new owned descendants; reused PIDs
are not signalled. Process queries, grace periods, observer joins, launcher wait,
source checks and release checks are bounded. Raw stdout is retained directly,
without console forwarding that could itself hold up deadline handling.

## Validation

- 21 focused files / **291 Vitest tests passed**, plus all17 bundled runner checks.
  Same bounded focused selection as e31bcad, with NODE_OPTIONS set to disable
  experimental webstorage and maxWorkers2. This is not the full test suite.
- Unchanged parent reproducer: **6 passed /7 intentionally skipped**, 639ms locally.
  Parent separately reported6/6,643ms with stable product hashes during its run.
  Parent-owned reproducer/config and original failure records were not edited.
- **10 source-only Python tests passed**, including actual runner main orchestration
  with injected clock/process I/O: TERM is ignored, stdout never closes, the
  deadline fails the run, KILL occurs, raw output survives and release is recorded.
  Other cases cover silent/continuous pipes, raw EOF, PID/start/command reuse,
  newly observed descendants, snapshot errors and signal failures. No native
  process, ps, lsof, signal, browser or listener was launched by these tests.
- Production build/typecheck and oxlint passed. The existing Vite >500kB chunk
  advisory remains; no new lint warning.
- Observer/browser-protocol TypeScript, Python compilation with explicit local
  cache files, source-guard Node syntax, six-flow Playwright listing without
  launch, production fixture-marker isolation and diff hygiene passed.

Readable logs, raw-log archive and hashes are in g3-review-correction-validation/.
Readable copies strip trailing whitespace; archived log bytes are unchanged.
The initial focused command's shell wrapper returned1 after all291+17 checks
passed because its postscript assigned zsh's read-only status variable. The raw
suite result is retained; subsequent command wrappers use task-specific variables.
This shell postscript failure is not a test failure or a broader acceptance claim.

Final shared #199 workspace wiring still awaits the supervisor's accepted sync.
G3 observable acceptance and G4 full/performance/final integration gates remain.
