# Short-output diagnostic runtime05 result

Source 37ed007e6cdb0b38fa2ea78ed492f353bc000e00, checkpoint
43cda14f81110b73bc35a5fe79fe2abbeed0b130fd3340dce82c20b678bfaaea.
The single granted attempt started at 2026-09-08T22:17:16.458Z with runner
62449 and exited 1: 12 cases passed, the one-second speech case failed, and
10 cases were unrun.

The exact error is `Core inference--944; cooperativeZero=true` after 2.648s.
The adapter returns -944 only when a segment's end exceeds sample_count / 160
centiseconds. This confirms output extending beyond the supplied audio. The
diagnostic does not record the segment index or numeric endpoint. No clipping,
timestamp fabrication, changed acceptance, or retry occurred.

English word error rate was 0.058823529411764705 on both runs, and French was
0.4, within unchanged thresholds. Silence also passed. Cancellation during
model/prepare/inference, project replacement, the long job, offline reopening,
and removal remain unqualified. Final cooperative model/cache cleanup was
unavailable after the failure closed the browser; no overall GO is claimed.

127 RSS samples: baseline 272,564,224B, peak 1,003,798,528B, delta 731,234,304B.
Maximum sampling gap was 110ms; maximum active-epoch gap including boundaries
was 145ms. No observed memory/cadence violation; unrun cases remain unqualified.

Independent release at 2026-09-08T22:18:02.233859Z found runner 62449 and
browser PIDs 62478, 62479, 62480, 62481 absent, port 5201 refused (61), and
profile05 absent. No owned awake helper or slot remains. The five exact raw
final/journal/marker/release/outer records are retained as gzip with identities
in raw-records.json; originals and all prior failed runs remain intact.
