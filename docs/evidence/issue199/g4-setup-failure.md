# Issue 199 — first mixed G4 attempt stopped during project setup

The one granted attempt ran at clean source
`15eee5e1d3525f727ea90aa5f88db96476828555`. It completed no checkpoint: the first
step timed out after 15 seconds trying to select the exact label `Resolution`
in the real project setup form. The project name was filled, but Create project
and the adapter's `prepare` call were never reached. No fixture encoding, mixed
export, decoded pixels/PCM or final application-admission check occurred.

The raw screenshot shows the setup form, and the DOM text includes Resolution
and its choices. The current source wraps the select and its options in a label;
the exact-label locator failure is recorded in the trace. This evidence narrows
the failure to setup selection; it does not establish a product rendering or
encoding failure. No locator change, correction, retry or later segment ran.

The driver ran from 20:32:46.736Z to 20:33:03.676Z (16.940 seconds), with no
console/page problems. Driver cleanup released its resources at20:33:03.632Z;
the independent supervisor exited at20:33:06.593Z without expiry or fallback
signals. Worker independent verification at20:34:22.757Z confirmed all eight
recorded PIDs absent, the private browser profile absent from live commands,
port5199 clear, all939source hashes matching and the worktree clean. No actual
pmset sleep/wake transition occurred in the run window. The exclusive slot is
released. The parent independently confirmed all eight PIDs absent and port5199
refused at20:34:19.530Z, and reviewed the raw result/DOM/supervisor and failure PNG.

Driver30665, caffeinate30697, server30698 and browser30703/30704/30705/30706 have
recorded PID/start/command identities. Supervisor parent30651 has its recorded
PID only: the independent live observer reached it after completion. Its PID
absence was checked, but no live supervisor start/command identity is claimed.
Native cleanup does not stand in for the final media-admission assertion, which
was not reached.

Raw evidence remains untouched at
`/private/tmp/issue199-g4/2026-09-08T20-32-46.561Z/`: failure PNG/DOM, trace, full
result/source hashes, supervisor, server log, artifact pointer and private profile.
The worker inspected the failure PNG. The trace archive passes integrity with89
entries. `g4-attempt1/raw-artifacts.json` records every top-level file's bytes/hash;
`failure-summary.json` maps exact JSON and normalized text copies to their raw
sources, including prelaunch and independent cleanup records. The raw result
hash also matches the runner's artifact pointer. Previous attempts and manifests
are unchanged.

The parent's combined production build at580de54 qualifies the identical product
source; this attempt used the explicitly reviewed Vite source-module diagnostic.
It adds no production-bundle, first-paint, export, performance or G4 pass claim.
Failure evidence and release are ready for parent review before any new action.
