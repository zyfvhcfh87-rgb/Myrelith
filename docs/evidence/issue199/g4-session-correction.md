# Issue 199 — canonical fixture activation and passive session error checks

Both failed native attempts remain preserved. The second attempt's evidence is
committed at `b36241d0d2887e56eb3e094934ee165785bdb253`; this checkpoint changes only
the diagnostic, its protocol and a focused test file. No product code changes.

The retained recovery alert gives the exact cause: “Could not update the recovery
copy: Recovery journal belongs to a different document.” The launcher started a
persistence session for its new document. The old fixture setup then called
`setProject` with document `g4`, while persistence still owned the launcher's
recovery journal. The existing storage guard correctly rejected that append.
The recorded alert, relevant source contracts and selector audit are preserved in
`g4-session-correction/inspection.json`.

Fixture generation now returns the initial portable project and source files
without replacing the active document. The driver saves their bytes and opens the
fixture through the real Projects, Open file, offline activation and per-file
relink controls. Canonical activation owns teardown, media replacement, project
identity, local binding and the new persistence session. Only then does the
diagnostic retime and split. It neither disables persistence nor resets its error
state. The later edited-project portable roundtrip remains a separate check.

Both native transport selectors now use the actual lowercase `play` and `pause`
labels. The remaining selectors were checked against current source and retained
DOM. Relink selects either of the two exact input labels the product exposes,
depending on file-picker support. Resolution remains 1280 × 720. The fixture,
codecs, six frame probes, pixel/PCM predicates and existing deadlines are unchanged.

A passive observer subscribes to the real project-session store before initial
creation and remains active through context close. It records session, save and
recovery phases, errors, timestamps and current project identity. Errors remain in
the evidence even if the store later clears them. Any session, save, recovery or
media-relink error rejects the running step and is saved in the raw result and
`session-events.json`; an empty console-error list cannot override it.

The observer is bounded to 256 events, 16 messages per event and 2,048 characters
per message. Event overflow is itself a failure. Checkpoints flush pending
evidence under a five-second bound. The final check allows the actual recovery
debounce plus 100 ms, then at most three seconds for an active write to settle,
within a five-second driver deadline. This is session-health evidence for the
bounded case, not long-term crash-recovery acceptance.

Nine focused tests in two files plus 17 canonical runner checks pass. Five new
tests reproduce the exact old recovery error using the real persistence/storage
guard, verify canonical leave/open/activation creates the fixture's journal, retain
a transient cleared error, enforce the event bound and surface evidence-sink
failure. They use real controller and storage logic with a map backend and stubbed
media/permission dependencies. The four existing pure fixture/PCM tests also pass.
Production and protocol typechecks, lint, Node syntax and source checks pass.
No browser, export or production build ran during this correction.

`verification.json` maps five check logs and the parent's independent release
receipt to their untouched originals. The parent's receipt confirms all eight
prior PIDs absent and port 5199 refused, and explicitly retains the private profile
as evidence; its earlier assumption that cleanup should delete that artifact is
qualified. `source-hashes.json` includes 941 paths: 936 existing paths unchanged,
three changed diagnostic/protocol paths and two added diagnostic/test paths.
The original manifests and raw failed attempts remain untouched.

The user pause was respected; work resumed only after the parent's explicit
RESUME. This frozen source checkpoint awaits parent review and a new exclusive
native grant. It adds no new native or whole-G4 acceptance claim.
