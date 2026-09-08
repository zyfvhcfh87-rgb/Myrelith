# Deferred-logits runtime04 result

Exact source a72989806b8476caa6b21302e9c612e3349e267c, checkpoint
 d05e8934baa26c2a8729c473659024b463efbd0ef8c89e69512c0eb3af346771.
One granted attempt started2026-09-08T21:59:42.283Z, runner58038, exited1.

The memory reduction permits model initialization and actual transcription.
12cases passed, the1second speech case failed,10cases were unrun. English runs
completed in2.770s and2.773s with word error rate0.0588235; French in2.858s at0.4,
within their unchanged thresholds. The silence case passed. These successful
jobs cooperatively released their logical model/input/sample/PCM owners.

The1second speech case returns `Core inference--94; cooperativeZero=true` after
2.721s. The adapter's -94 validation is deliberately fail-closed; raw evidence
does not identify the exact rejected output field. Do not assert timestamp
truncation, a token overrun or another unmeasured cause. No timestamp clipping,
fabrication, relaxed acceptance or retry was performed. Full cancellation,
long-job, offline reopen and model-removal cases remain unrun; no overall GO.

129complete RSS samples: baseline279674880B, peak1178140672B,
delta898465792B, maximum gap110ms; no monitor violation in the observed epoch.
Ready heap was510918656B under the unchanged536870912B maximum. These are
observed-job measurements, not qualification of the unrun cases.

Independent release at2026-09-08T22:00:57.474380Z confirmed runner58038 and
browser58070/58072/58073/58074 absent,5201refused61,profile04absent.
Exact final/journal/marker/release/outer logs are archived in gzip with original
byte lengths and SHA256. Previous candidates/raw evidence are untouched.
