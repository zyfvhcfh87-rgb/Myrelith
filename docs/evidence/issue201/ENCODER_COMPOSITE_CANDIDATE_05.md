# Candidate 05: explicit historical-encoder composite

Date: 2026-09-08. **Source preparation for review; no native inference grant.**
The supervisor accepted contract a255870 after independently reproducing the
metadata/source comparison. This checkpoint implements only that contract.
Speech remains NO-GO after the measured run04 failure. No new RSS, transcript,
timestamp, numerical-equivalence or model-quality result is claimed.

## Frozen composition

- Preserved candidate04 manifest:
  `encoder-fetch-candidate04-manifest.json`, SHA-256
  `4aebb4adbd8c0a00615065f4dd3c0d1da5259e2daf5a37f71489e0c5732470e7`.
- Candidate05 manifest: `replacement-manifest.json`, SHA-256
  `c68800d6b46bcecd9bbdfe7ed8abc853bcb8cf194bbe98dc3fd39518f37c8804`.
- Explicit local bundle ID:
  `sha256:f480eedc77e25c9f851469714c50af263417fb2122ab48e329888a83464f3509`.
- SDK configuration revision remains
  `5332fcc35e32a33b86612b9a57a89be7906102b1` for the six unchanged current
  decoder/config/tokenizer/processor files. It is not the composite revision.
- Only the published encoder comes from
  `ce70c25689c3694faf5ec8206517cd53f0cfb03f`, 10,113,248 bytes, SHA-256
  `ca9d7bb2836193704b7e2435e3bbadbed985ac3a79ab7406b244b8865ab1a5c0`.
  Its original scratch file is served directly. Neither graph was rewritten;
  the original current encoder also rehashes unchanged and remains on disk.

The manifest records each file's source repository, source revision, upstream
path, logical model path, verified local path, truthful upstream URL, byte count
and digest. The bundle ID covers this complete table plus its explicit license
provenance. It is separate from the runtime-aware cache identity, which also
includes the actual Transformer/ORT/Common versions, WASM/device/dtype/thread
settings, runtime asset hashes, optimizer settings and encoder IO contract.

Model bytes are 43,610,465. Old candidate04 committed plus new staged is
87,232,592; two complete candidate05 copies are 87,220,930. Both fit the unchanged
100,663,296-byte model-cache limit. These are encoded payload bounds, not resident
memory estimates. All five runtime artifacts, six runtime notices, five fixtures,
23 measured cases and every threshold remain unchanged. QDQ fusion stays disabled
through the same reviewed supported setting; no other optimizer flag is changed.

## Identity, IO and preparation

`composite-model.mjs` owns the exact seven reviewed component pins, source-table
canonicalization and cache identity. Client install/verification records and
checks the explicit bundle/configuration revision plus each component's source
headers. Byte length and SHA-256 still verify complete cached/downloaded bytes.
Changed cache source metadata is rejected before creating an inference worker.
The worker verifies the exact selected composition, bundle and runtime-aware
cache identity before importing Transformers. Readiness reports bundle,
configuration revision, complete per-file source table and cache identity.

Exact local aliases remain allowlisted. The historical encoder's upstream URL
is truthful; the old current-revision encoder URL is not an alias for it. There
is no remote discovery, basename matching, historical tokenizer fallback or
worker-side cache write. The instance adapter requires the published singleton
`last_hidden_state` output and original input contract. It preserves the public
ORT call, feeds, tensor/result owners, decoder outputs, release functions and
fetch-start/completion events. The former five-output interface is rejected.

`prepare-encoder-composite.mjs` is the authoritative source-only preparer for
candidate05; `prepare-speech-lab.mjs` remains the historical base preparer. The
new path performs no network request, package install, archive extraction,
runtime import or graph transformation. `composite-preflight.mjs` verifies the
preserved04 manifest, all seven original files, exact seven selected components,
unchanged runtime/notices/fixtures and pinned model license sources. It computes
committed/staged admission before any output write. Preparation copies only the
three model cards and the existing unmodified Apache license text into the
notice directory, then writes the candidate manifests/evidence. The native runner
repeats this exact preparation and manifest comparison before starting its server,
then serves each selected component only from its pinned local source. Source
hashes and raw results bind the new modules and full composition. The original
exclusive-slot guard and all RSS sampling/stop/cleanup rules remain intact.

Historical license scope stays explicit: the July2023 Xenova card has no license
field; the earlier OpenAI card declares Apache-2.0; the current Xenova declaration
is separate. The three pinned cards and generic unmodified Apache text are
included as separate model notices. The text's placeholder appendix does not
invent a model copyright holder or exporter source revision. No legal agreement
was accepted.

## Deterministic verification

25 source/VM tests pass using actual controller/worker modules with resource
fakes where needed. They cover every per-file identity change, missing/tampered
components, unsafe paths, fabricated encoder URLs, exact source preflight with
unchanged inputs, old-manifest preservation, registry/source-header rejection
before worker creation, forwarded configuration revision, singleton IO, unchanged
decoder ownership, optimizer settings and existing cancellation/error rules.
Node syntax checks and repository lint pass. The tests import no ONNX model or
native inference runtime; the preparation tests only read and hash model bytes.
`composite-preparation.json` records the reproduced manifest/bundle and byte sums.

The accepted structural comparison remains in
`NATIVE_ENCODER_VARIANT_CONTRACT.md`: 121 identical initializer contents, 119
named input-role groups, 305 core operators and 34 original views, with the eight
added current attention views explicitly audited. This supports trying a native
lifetime change; it does not establish numerical equality under optimization or
promise a measured 216 MB saving. Source must be committed and reviewed, followed
by a separate explicit exclusive run grant, before candidate05 inference.
