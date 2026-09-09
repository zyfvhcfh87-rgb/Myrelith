# Identify the exact short-output rejection

Runtime04 passes real English, French and silence transcription after the
deferred-logits change, but the one-second speech case returns generic-94.
That code covers several adapter checks, so its precise cause is unmeasured.

The diagnostic adapter changes only output-validation return values:

| Code | Existing rejection condition |
| --- | --- |
| -941 | Segment count outside0–1000 |
| -942 | Segment start precedes the previous end |
| -943 | Segment end does not follow its start |
| -944 | Segment end exceeds the exact source sample coverage |
| -945 | Missing segment text pointer |
| -946 | Empty text or per-segment/aggregate text byte budget exceeded |

The three timing predicates retain their original order and short-circuit
behavior. No values are clipped, fabricated, discarded or accepted differently.
The remaining finite-PCM/generated-token checks still return-94. The protocol
already forwards the integer native status, so no worker/observer changes or
model-text diagnostics are needed. This identifies a cause; it is not a fix.

The three previously accepted native source patches remain. CMake/token helper
are byte-identical to the accepted recipe; model, backend, graph, heap/RSS,
token/time limits and all23cases remain unchanged. The existing198-line builder
is reused with only its evidence, attempt and recipe-source paths redirected
(plus the introductory sentence). Its compile/cleanup controls are unchanged.
Source preparation and recipe identity checks pass in the separate
.tmp/issue201-whispercpp-short-output-build directory. No compiler/runtime ran.
The first preflight caught an unchanged recipe comparison path; it was corrected
to the new pinned recipe before compilation. The staged recipe itself was correct.

An explicit compile slot and exact checkpoint hash are required by the same
ISSUE201_EXCLUSIVE_SLOT / ISSUE201_BUILD_CHECKPOINT_SHA256 controls. Generated
artifact review and a separately granted native attempt remain required.
