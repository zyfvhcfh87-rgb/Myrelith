# Issue 199 — continuation source and fixture checkpoint

Prepared on 2026-09-08 for supervisor review. **No continuation browser run has
executed.** Product source remains
`b33b7531027979b8886f5db979d57cd96b96175d`; the checkpoint follows accepted early
evidence `095e6d9463580e3502ba7c210d3982bed548a52f`. The early runner, original
fixtures, prior attempts, and accepted commits are preserved unchanged.

## Review surface

- `scripts/issue199/continuation/PROTOCOL.md` maps the original remaining Gate 3
  acceptance to three independently selectable segments: gestures, editing with
  portable round trip, and large documents. It states the native/API boundaries,
  source and fixture provenance, unchanged 40/512/256 limits, raw timing
  qualification, evidence capture, first-failure stop, and owned cleanup rules.
- `scripts/issue199/run-animation-continuation.mjs` requires exactly one segment,
  pins a clean committed source and all hashes, builds production, refuses an
  occupied 5199 port, and uses a fresh private muted headless Chromium profile.
  Success and failure both retain DOM/screenshot/trace and source/browser/process
  evidence. Final acceptance requires console/page checks, fresh source checks,
  and an empty owned process tree with the port released.
- `scripts/issue199/continuation/observations.mjs` contains the actual native
  gesture, cancellation, authoring/mapping/refusal, portable-open, and large
  document assertions. Successful native pointer admission requires a trusted
  event and actual capture. Diagnostic immutable references retain at most four
  checkpoints and are cleared when reopening a portable project.
- `scripts/issue199/continuation/portable.mjs` and
  `scripts/issue199/prepare-continuation-fixtures.mjs` invoke the canonical
  snapshot/parser/serializer through a non-listening host. Browser save/reopen
  coverage uses these real portable APIs and actual file-open UI; it does not
  assert the OS Save picker.
- `scripts/issue199/continuation/process-identities.mjs` selects the exact private
  profile and observed descendants, using PID/start-time/command identity to
  reject reused PIDs and unrelated profiles during cleanup.
- `scripts/issue199/continuation/checkpoint-hashes.json` pins this review surface,
  fixtures/manifests, helpers/tests, and the six validation logs below. The
  existing observation manifest separately pins all 242 product/test/config files.

## Generated fixture, not browser evidence

The new `scripts/issue199/fixtures/continuation/dense-scalar.myrelith` contains
exactly 100,000 authored keys with one supported 1,024-key opacity lane. It is
7,892,325 bytes, SHA-256
`2518406e6d2759bb7a8cdceb0d2d555ec460c0e34130325fa61f4b9b775dadbf`.
Only one original unavailable effect lane was replaced; the original three
committed fixture files were not edited. Canonical preparation verified keys
0–1,023, 255 curve points, 32 glyphs under a budget of 32, total 100,000 keys, and
exact canonical serialization round trip. Its manifest records generation on
b33b753 and the original dense fixture hash.

The original mixed fixture already has exact media source-time ticks. Source
checks explicitly verified -150,000,000 at local frame -150, 200,000,000 at local
frame 200, and a 60,000,000-tick source span. The planned portable run verifies
the negative intent before saving and exact full project equality after reopening.

## Completed source qualification

| Check | Result | Evidence |
| --- | --- | --- |
| Two focused Vitest files: Animation workspace and lane index | 27 passed | `continuation-source/focused-tests.log` |
| Existing runner checks invoked by `npm test` | 17 passed | Same focused log |
| Process identity/parser unit tests | 3 passed | `continuation-source/process-tests.log` |
| TypeScript and Vite production build | Passed; existing chunk-size advisory | `continuation-source/build.log` |
| Repository lint | Passed without warnings | `continuation-source/lint.log` |
| Canonical supplemental generation/domain validation | Passed | `continuation-source/fixture-generation.log` |
| All 242 source hashes, empty product/config diff, all four fixture hashes, generator hash, source ticks, six module syntax checks | Passed without executing the continuation runner | `continuation-source/source-checks.log` |

The source tests include an actual index-build spy across playhead updates and
a pure 100,000-key bounded indexed-read query. They do not establish browser
timing or heap measurements. The three process tests cover exact private-profile
ownership/descendants, orphan identity and reused PID rejection, and macOS `ps`
parsing. They do not claim that the new browser lifecycle has been exercised.

The retained logs are normalized only to remove ANSI/control carriage returns
and trailing whitespace; raw working logs remain in the owned ignored task folder.
No source test failure is being relabeled as a browser result.

## Gate boundary

This checkpoint requests source/protocol review, followed by a separately selected
exclusive slot. It does not extend the accepted six-checkpoint early pass into
whole Gate 3. The new native flows, persistent-profile cleanup, large-document
observations, raw performance measurements, integrated title/tracking behavior,
pixel/PCM/export, full suite, and production audit remain unexecuted here.
No product edit, midpoint sync, push, PR, merge, issue closure, or upward/peer
message tool is part of this checkpoint. The owned issue report is the supervisor's
coordination surface.
