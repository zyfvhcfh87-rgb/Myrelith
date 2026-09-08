# Issue 199 — mixed encoded G4 source preparation

The executable protocol is frozen separately from the accepted production
correction `16ac2e6d498ca9a486148ccb936f729fc886050d`. This checkpoint adds only
owned diagnostic scripts, a pure fixture/PCM test and source preparation evidence,
plus the parent-requested two-line lane-index test expectation correction.
Production behavior and the original title integration tests are unchanged.
The parent reported 120 passes and one stale message assertion in its extra five
suites, with its original nine focused suites passing 147 tests. The lane fixture
references a missing effect, so its test title and exact expected reason now match
the accepted missing-owner resolver. No resolver or refusal predicate changed.
The corrected lane-index suite passes all six tests plus 17 runner checks locally;
its raw output is retained.
The parent accepted the production source and independently passed its four
controller/title suites; its combined production build remains a separate gate.
See `five-owner-correction.md` for the correction and its 183 focused tests.

## Proposed runtime gate

`scripts/issue199/g4/PROTOCOL.md` declares one mixed 30-frame, 1280×720, 30 fps,
48 kHz stereo case. It exercises canonical retime/split and exact undo/redo;
native shared-title Set/value/copy/paste; muted playback using silent live PCM;
portable UI reopen/relink; Animation layout/focus; and missing-font export refusal.
Media transforms/crop/grading, held mask path keys, a preserved unknown descriptor,
a moving multi-element title and animated audio gain/balance feed the actual
VP9/Opus export and decoded pixel/PCM checks.

Export bytes and hashes are saved before readback. Partial decoded facts survive
failure. Exact PCM sample occupancy rejects gaps, nonfinite values and excessive
overlap/padding. Program references pin the current project/generation, canvas,
frame and drawn/missing clip identities. Interior white-glyph and crawl-motion
predicates prevent blank or unrelated content from satisfying the image check.
The named-font intent, fallback, generated and ordinary title keys survive exact
portable sequence equality. Unexpected missing-font output is retained before
failing. The six frame probes and lossy RGB/glyph/PCM bounds are declared before
any observation.

The final awaited media disposal saves its admission snapshot before requiring
zero essential/monitor owners, decoder slots and surface bytes, with no blockers.
Earlier export snapshots are diagnostic only. Native process exit and RSS do not
establish application reservation release or general media-resource leak freedom.

Every action/evidence/cleanup operation has a deadline. A separate Node process
supervises the driver with a 300-second limit and exact PID/start/command cleanup.
The protocol retains private raw artifacts and explicitly requires an independent
release/source/sleep-window check after execution.

## Source-only validation

- Four pure fixture/PCM tests plus 17 canonical runner checks passed. These cover
  canonical retime/split/portable title data and exact PCM gap, overlap, padding
  and finite-value handling without decoding media.
- Sixteen inert oracle/lifecycle tests passed, including five final-drain rejection
  cases, a zero-reservation acceptance case, output predicates, stalled evidence
  cleanup and an independently supervised blocked disposable Node child.
- The separate protocol TypeScript check and lint passed after the final drain
  assertion. Production TypeScript had passed at the unchanged product source.
- The inert runner check performs source inventory only. Its precommit count
  excludes untracked draft files; the complete preparation hash manifest includes
  them. A postcommit check must inventory all files at the final clean full SHA.

`g4-preparation/verification.json` maps normalized copies to untouched raw logs.
`source-hashes.json` includes every production source, owned protocol and selected
configuration path used by the runner, including this checkpoint's new files.
The execution preflight independently pins the subsequently granted clean full SHA.
Prior native fixtures, manifests and failed/passing attempts are untouched.

This is a Vite source-module diagnostic using actual production implementations;
it is not ordinary production-bundle, first-paint, performance or whole Gate 4
acceptance. #200 owns the separate title first-paint investigation. **No G4
browser/export observation or production build has run at this checkpoint.**
Parent protocol review and an explicit shared-slot grant remain required.
