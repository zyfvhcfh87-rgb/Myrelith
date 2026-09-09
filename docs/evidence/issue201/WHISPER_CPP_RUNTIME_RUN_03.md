# Reservation candidate runtime03 result

Exact source ecd2efea6d297cf1ec78089fd06db1dc63f19332, checkpoint
66d34b5bbb1bd7c8e031c57838adf60f5c9914dc9012fc8111ac49ea70e87f6f.
One granted run started 2026-09-08T21:42:53.304Z, runner53551, exited1.
Eight cases passed; first English initialization failed in118ms;14cases unrun.
No audio preparation, inference or transcript ran. Speech remains NO-GO.

Native initialization reported the same failed backend chunk twice:
`chunk=0 bytes=94318336`. The reservation guard now propagates failure:
_speech_load returns-92, without the previous assertion/abort. _speech_close
returns0; worker protocol reports cooperativeZero=true and zero logical owners.
The client conservatively reports terminated-error/cooperativeZero=false, and
final cache cleanup remains unavailable after emergency browser closure.
This is not full cancellation, cache-removal or transcription acceptance.

Fifteen RSS samples cover the short initialization epoch: baseline288079872B,
peak779108352B, delta491028480B, maximum gap108ms. No full-job resource claim.
The failed chunk size is measured; the allocator's remaining capacity and exact
reason for refusing it are not. Do not infer a required heap increase from it.

Independent release at2026-09-08T21:43:43.618003Z confirmed runner53551 and
browser53580/53581/53582/53583 absent, port5201 refused61, profile03 absent.
Raw final/journal/marker/release/outer logs are archived byte-for-byte in gzip,
with original byte sizes and SHA256 in raw-records.json. Previous candidates,
markers and raw01/02 failures are untouched. No retry has run.

Next bounded source decision: inspect model staging lifetime and native graph
buffer ownership at this measured allocation before proposing another candidate.
