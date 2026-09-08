# Export completion attempt 1: control failed; lifecycle unrun

**FAILED / INCOMPLETE.** The one authorized run tested exact clean source
`509d03a9b3ffb3f11df941a4627214bab3df7423` and exited 1. No retry occurred.
Chromium 151.0.7922.34 ran from 2026-09-08 21:53:29.821Z to recorded teardown
21:53:41.561Z. Production and architecture remain the accepted `d9759917`.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue198/run-resource-gate.mjs --segment export-completion --expected-sha 509d03a9b3ffb3f11df941a4627214bab3df7423 --output .tmp/issue198-509d03a-export-completion-attempt1
```

The independent static/held-path control completed its one 300-frame AVC encode.
Its four targets all met mean <= 2 against the independent pre-encode reference:

| Frame | Control maximum error | Control mean error | Original max-12 rule |
| --- | ---: | ---: | --- |
| 0 | 12 | 0.2008376736111111 | Passed |
| 127 | 19 | 0.06888454861111111 | Failed |
| 255 | 16 | 0.06850477430555556 | Failed |
| 299 | 16 | 0.07712782118055556 | Failed |

Control versus saved production output matched exactly at frame 0. At frame
127 it differed: maximum 19, mean 0.010200737847222223, 21,522 nonzero channels,
12 channels above 12. The saved production/reference result remained maximum
19 and mean 0.06854926215277778, exactly the original failed observation.
The run stopped there: no saved-output comparisons at 255/299, new production
exports, cancellations or retries occurred. Original maximum-12 failures remain
failed; no tolerance or predicate was changed after this result.

Control frame 127's opaque pre-encode RGBA hash is
`6b149e0d454670767e2f97e5a7697caa4e20b6420eeb9b3b2139981c9807207c`, matching the
[accepted actual unencoded compositor observation](diagnostic-attempt2/results.md).
The independent control's own max-12 violations support a codec-sensitive
explanation. However, this run did not establish exact agreement at all four
targets or isolate the remaining difference solely to codec nondeterminism.
The proposed prerequisite for lifecycle continuation was not met.

Cleanup completed: 728 ordinal samples and 306 selected VideoFrames all closed;
the control encoder finalized/closed; all observed canvases reached 1×1.
All 614 owned comparison buffers were released, with peak 33,177,600 bytes
below 64 MiB and final zero bytes/buffers. Production source requests and
completed production outputs were both zero. No browser/console/evidence error
or partial binary was reported; failure was the actual RGB comparison.

Independent worker release at 21:54:05.389007Z found PIDs 56756, 56776, 56777,
56778, 56779 and 56781 absent using both kill(0) and ps; port 5198 refused
connections (61). Context, browser, browser server and Vite all closed.

Original evidence remains in `.tmp/issue198-509d03a-export-completion-attempt1`:
335 JSON records and `codec-control.mp4` (2,099,040 bytes, recorded SHA-256
`5cb520b14006c5589748128d9bc79bca8d5edf5ef890ec92cfabc245ea00a244`). Key records:
00137 pre-encode hash; 00321–00324 control quality; 00327–00328 comparisons;
00330 pixel release; 00333 teardown; 00334 evidence closure. Command output and
worker cleanup receipt are the sibling `*-command.log` and `*-cleanup.json`.
Existing raw evidence and manifest are preserved without another packaging or
hash-audit pass. The native slot is released; lifecycle acceptance remains open.
