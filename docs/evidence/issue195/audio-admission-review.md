# PR #223: audio restart admission review

Bugbot's "Audio leases overlap and preempt previews" finding was reviewed on
2026-09-06 against PR head `76d2d2a018916b7a7613d9555c1d0fe857c4a4d7` and its
proposed autofix `77031389ef51235538d1ed7cddc18daab03cfbf4`.

## Decision

Retain the existing runtime behavior. This is an intentional conservative
admission tradeoff, not duplicate ownership of one session. A playback restart
creates a new audio session while the previous session may still be cleaning
up. The optional monitor must account for both reservations until that cleanup
settles. Audio playback takes priority over keeping the optional tiles active.

The contract already required Program/audio leases to remain held through
disposal in [ARCHITECTURE.md](../../../ARCHITECTURE.md#optional-multicam-monitoring).
`stopAudioSession` starts cleanup immediately and releases its captured lease
in the cleanup promise's `finally`. `startPlayback` reserves the new plan
before calling the audio factory, and independently retains unadopted startup
ownership through cancellation and late-session cleanup.
`TimelineAudioPlaybackSession.stop()` returns a promise that waits for its
cursor closures and media-source closure. Merely detaching a session from
controller state is not evidence that those resources have closed.

The proposed autofix releases the old reservation before `session.stop()` and
also makes a pending startup's lease immediately releasable on cancellation.
That can admit previews while the old resources are still closing. It was not
applied. Delaying essential audio behind old cleanup solely to preserve tiles
would also conflict with the playback-priority contract.

When the combined reservation fits, the wall remains active. When it does not,
the admission callback retires it before replacement audio starts. The UI's
existing paused state offers a retry; admission becomes possible again when
cleanup releases the old lease. This decision does not add automatic retries
or promise that a complex audio plan will qualify for live monitoring.

## Regression evidence

Three silent tests in `src/app/transportController.test.ts` exercise the real
transport controller and shared admission ledger with deferred audio sessions:

| Case | Expected result |
|---|---|
| 3 Program slots + 7 preview slots + old/new 1-slot audio plans | All 12 slots remain counted; previews stay active |
| 4 Program slots + 7 preview slots + old/new 1-slot audio plans | Optional previews retire before new audio starts; retry is denied until old cleanup settles, then admitted |
| Cancel a pending audio prime, then receive a late session whose stop is deferred | The reservation survives cancellation and late-session cleanup, then returns to zero |

Both restart cases verify that replacement playback begins while old cleanup
is pending, advances from the replacement audio anchor, and finishes with zero
owned reservations. The focused transport/admission/monitor-session gate passes
75 tests plus 17 repository runner checks.

As a negative control, the autofix's early-release/state-adoption changes were
temporarily applied locally. All three new cases failed on the relevant
ownership/preemption assertions. The controller was then restored byte-for-byte.
This mutation run used only fake sessions and produced no media or audio.

Reproduce the focused gate with the repository scripts:

```sh
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/app/transportController.test.ts src/app/mediaResourceAdmission.test.ts src/app/multicamMonitorSession.test.ts --maxWorkers=4
```

The environment flag avoids the previously identified Node 26 host-WebStorage
interference with jsdom. CI uses Node 24 and the ordinary repository test
command. This follow-up changes only regression tests, documentation and a
controller comment; the existing browser acceptance record remains historical
evidence for the unchanged runtime, not a newly repeated browser pass.

Final local validation: 4,001 tests across 289 files and all 17 repository
runner checks passed with that Node 26 environment flag. Production
typecheck/build and lint passed; Vite retained its existing chunk-size notice.
