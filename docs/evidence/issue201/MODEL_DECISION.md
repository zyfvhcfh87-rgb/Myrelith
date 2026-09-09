# Local speech model decision — bounded GO

Date: 2026-09-09. **Supervisor-approved GO for the exact candidate and bounded production
integration below.** Runtime09
passed all 23 laboratory cases. The later [product acceptance](PRODUCT_ACCEPTANCE.md)
qualifies the bounded app integration separately; this is not a general accuracy,
browser, security or performance guarantee.
[Runtime09 outcome](WHISPER_CPP_RUNTIME_RUN_09.md) and its adjacent
exact raw records support this decision. No exclusive runtime slot remains held.

## Exact candidate and model

- Candidate manifest SHA-256:
  `5f103277604fce712a9824551ce4dbca76434d5c3eed3de36b8cdc68544a0c5a`.
- Runtime09 checkpoint:
  `85cf484046b376c879d76b55a560ec5e3d7f5e418d4daf4fb83f1812f269fa2b`.
  The [compact checkpoint](whispercpp-offline-runtime.json) derives the exact
  manifest and assets through frozen runtime08 inputs, without a new inventory.
- Runtime: whisper.cpp 1.9.3-dev, upstream source
  `371b5a7561823ab2bb32142d2751e35e7534727b`, accepted bounded native patches,
  adapter source `ac2c447509946ecbab05486297e9080846e5889d`; single-thread WASM.
- JavaScript: 22,350B, SHA-256
  `db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7`.
  WASM: 1,198,548B, SHA-256
  `2f05c1ba7a828ba93a5ab1c7dd752f0d055360d02aa23edc9b60572424e01ef2`.
  [Build and static delta](WHISPER_CPP_UNTIMED_RUNTIME.md) preserve the two
  adapter-only build commands and unchanged import/export/memory boundaries.
- Model: `ggerganov/whisper.cpp`, multilingual `ggml-tiny-q8_0.bin`, revision
  `5359861c739e955e79d9a303bcbc70fb988958b1`, exactly 43,537,433B, SHA-256
  `c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca`.
  Bundle identity:
  `sha256:6f4ab890b02876493211844b95d622da99199d8abb56ec54f6e37ca425091370`.

The [accepted model preparation](WHISPER_CPP_SOURCE_PREPARATION.md) records
its MIT model-card declaration and saved OpenAI model notice. The exact
conversion/quantizer revision is unpublished and remains unknown; no numerical
parity claim follows. Runtime source is MIT. Ship the accepted
[runtime notice bundle](whispercpp-generated/runtime-notices.zip), whose eleven
entries and SDK/source provenance are recorded in
[generated review](WHISPER_CPP_GENERATED_REVIEW.md). The adapter-only relink
retains those native libraries. No new advisory lookup was performed for this
verdict; older ORT advisory results are not a native-WASM security clearance.
No legal agreement was accepted.

## Supported product behavior

Use the existing approved issue201 plan, with these explicit semantics:

- User chooses English or French and one connected source's primary audio,
  bounded to 1–300 seconds, with an integer-frame insertion point. No language
  detection, translation, confidence score, cloud transcription or media upload.
- Model acquisition is opt-in, disclosing the exact 43,537,433B model download,
  local browser storage, supported languages and processing limits. Only the
  pinned model is accepted from download/local selection; no arbitrary model
  scripts or URLs. Lazy runtime acquisition remains separate from model bytes.
- Persist one verified model in app-owned local cache. Full replacement stages
  beside the committed model under the unchanged 96 MiB cache ceiling, verifies
  lengths/digests/provenance, then publishes atomically. Never store cache paths,
  model bytes or machine-local identifiers in portable projects. Expose Remove.
- Transcription works offline while the application and required runtime files
  are available locally. Opening/reopening requires its app files to be served;
  offline navigation is not guaranteed. Verified model bytes remain cached and
  need no new download after reopening. See the explicit
  [offline support contract](WHISPER_CPP_OFFLINE_SUPPORT.md).
- Only validated model timestamps produce editable timed cue proposals.
  A coverage failure yields the whole window's text with “Timing unavailable —
  review manually” and no cue endpoints. Source coverage is not caption timing.
  Retain overlap text for review, without silently merging or dropping it.
  Untimed text needs explicit valid user timing before Apply.
- Cancellation rejects the pending request promptly while retaining worker and
  shared admission until acknowledged native cleanup. Active drain is bounded
  by the remaining current phase/window deadline plus 100ms; idle disposal uses
  100ms. Unacknowledged cleanup blocks retry rather than claiming release.
- Reuse the app's scheduler/admission and caption review/session seams. Reject
  stale source/project/sequence results. Apply performs one fresh validation and
  one undoable caption edit. Production worker imports require only the narrow
  reviewed architecture exception; no new scheduling/editor framework.

## Measured acceptance and limits

Runtime09 passed acquisition/corruption/cache rollback, English twice, French,
silence, short-source untimed review, corrupt audio, all cancellation phases,
project replacement, 300 seconds, loaded-app offline transcription, cache
persistence after reload/browser reopen, model removal and final cleanup.
English WER: 0.058823529411764705 twice; French WER: 0.4. Those are two pinned
licensed fixtures, not multilingual or arbitrary-recording accuracy estimates.

The full workload completed in 67.115s: twelve source windows, eight timed,
four untimed, forty timed cues, nonempty text throughout. It repeats a short
recording with silence; it is workload coverage, not natural long-form quality.
Windows stay at most 30 seconds with 5-second overlap, at most 448 tokens per
native call, one model/decoder job, and at most 3,840,000 owned PCM bytes.
The unshared heap remains 64 MiB initially / 512 MiB maximum, with a 5 MiB
stack and 120-second window deadline. No real-time performance promise.

HeadlessChrome 151.0.7922.34 on Darwin arm64 was qualified. Supervisor-reported
hardware was Apple M5 Max / 64 GiB; this is not a portable memory guarantee.
Measured RSS baseline 272,351,232B, peak 1,212,547,072B, incremental peak
940,195,840B stayed under the fixed 1 GiB ceiling. All 1,010 samples qualified
with maximum sample/active-epoch gap 108ms. Launch and verified-absent browser
reopen intervals are excluded as disclosed in the resident record.

Observed cancellation drain: model load 50ms, preparation 5.2ms, inference
5790.3ms, project replacement 5827.8ms; every case retained its owner until
acknowledged zero. All 2,784 long-job audio samples closed. Reopen preserved the
same cache identity and 43,537,433 model bytes with model downloads blocked.
Reported cache storage was 43,539,200B including metadata; removal/final cleanup
reported usage 0, zero owners and only an empty registry. Native/browser/media
qualification remains limited to the measured fixtures and environment.

## Approval boundary and history

The supervisor approved the model gate and bounded production integration on
2026-09-09 after independent result/release review. Integration, focused tests,
build/lint, and explicitly granted browser verification are now the next work. No new broad research gate is proposed. The final integration
must retain the exact candidate, notices, cancellation, untimed and offline
contracts above; changed native assets require renewed review.

Earlier failed ORT and whisper.cpp outcomes remain immutable. In particular,
[runtime06 memory failure](WHISPER_CPP_RUNTIME_RUN_06.md),
[runtime07 timestamp failure](WHISPER_CPP_RUNTIME_RUN_07.md),
[runtime08 offline navigation limit](WHISPER_CPP_RUNTIME_RUN_08.md), and
[original generated/source review](WHISPER_CPP_GENERATED_REVIEW.md) retain their
original results and qualifications. This current decision replaces stale
status text; it does not retrospectively turn any failed run into a pass.
