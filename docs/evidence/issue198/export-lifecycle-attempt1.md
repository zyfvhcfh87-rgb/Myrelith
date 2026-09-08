# Lifecycle attempt 1: warning stopped the run

**FAILED / INCOMPLETE.** One authorized run tested exact clean
`b37242b7db1468c9a0ac80b986cd239e9f3abb7d`, exited 1, and was not retried.
Recorded start: 2026-09-08 22:08:20.063Z; teardown: 22:08:24.224Z.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue198/run-resource-gate.mjs --segment export-lifecycle --expected-sha b37242b7db1468c9a0ac80b986cd239e9f3abb7d --output .tmp/issue198-b37242b-export-lifecycle-attempt1
```

Chromium emitted its repeated-`getImageData` performance warning recommending
`willReadFrequently: true`. The existing fail-on-warning handler immediately
closed the browser. Subsequent pixel-owner/handle disposal reported
`Browser closed`; that is a consequence of the recorded warning-triggered
shutdown, not evidence of a new pixel comparison failure.

Frame 0 passed exact actual pre-encode RGB parity. Its observer canvas reached
1×1, with one 3,686,400-byte reference intentionally retained for output checks.
The last durable progress event reported 104 frames/composites/source requests,
104 closed leases, peak one lease, and no live lease at that snapshot. Events
were queued asynchronously: 104 is not a certified final amount of work.
No output, encoded comparison, completed attempt, cancellation or retry was
recorded. Graceful exporter/reference-owner settlement was not established.
The two earlier codec-related failures remain unchanged and visible.

Physical teardown succeeded. Worker verification at 22:09:03.148541Z found
PIDs 59892, 59912, 59913, 59914, 59915 and 59917 absent by kill(0) and ps;
port 5198 refused connections (61). Context/browser/browser-server/Vite closed.
The exclusive slot is released; no native retry is authorized by this result.

The added direct sink readback is the likely warning source, based on source
inspection; the console record did not preserve its exact callsite. A narrow
proposed observer correction is to draw the completed sink into the existing
`willReadFrequently` observer canvas and read there, preserving production
canvas settings, all thresholds and the fail-on-warning rule.

Original 122 JSON records, manifest and command/cleanup receipts remain under
`.tmp/issue198-b37242b-export-lifecycle-attempt1` and its sibling files.
Key records: 00010 exact frame-0 parity, 00011 observer release, 00116 last
durable progress, 00120 warning and teardown, 00121 evidence closure. No extra
packaging, codec investigation, matrix or source change accompanied this run.
