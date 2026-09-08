# Saved-packet visible-plane readback

The separately granted decode-only run completed all three diagnostics at
`2026-09-08T10:06:16.010Z`, starting from commit
`ea530ecc9b88d5f36fa44cced849d9056a0166ba`. It used only the three saved 264-byte
SDR/PQ/HLG packets and their original decoder configurations: zero encoding,
new media, resolution/profile changes or performance work.

Starting, completion and post-run source SHA256 are identical:
`32253befb82da5fe8803a446840ff22e2beeb9c6f84d381f1e64ed0a596d8b63`.
Source remains [probe-codec-readback.mjs](probe-codec-readback.mjs); machine
results are [codec-readback-1.json](codec-readback-1.json), linked by input and
packet hashes to the preserved [first run](codec-probe-1.json).

## Geometry and raw samples

Every frame reports I420P10, coded size 1088×16, visible rectangle
`{x:0,y:0,width:1024,height:16}`, and display size 1024×16. The visible rectangle
is in bounds and chroma aligned. Its explicit copy produces 49,152 bytes with
Y/U/V offsets 0/32,768/40,960 and strides 2,048/1,024/1,024 bytes respectively.
The original run's assumption that coded and visible widths must be equal was
too strict. Its three failed rows remain unchanged; this follow-up records the
previously missing geometry and performs the visible-plane comparison.

The following values are measured separately and identically in all three
SDR709/PQ2020/HLG2020 rows:

| Plane | Samples | Distinct values | Mismatches | Maximum absolute error | Mean signed error |
| --- | --- | --- | --- | --- | --- |
| Y, expected horizontal code 0–1023 | 16,384 | 896 | 4,496 | 1 code | -0.2509765625 code |
| U, expected neutral 512 | 4,096 | 1 | 0 | 0 | 0 |
| V, expected neutral 512 | 4,096 | 1 | 0 | 0 | 0 |

All three copied payloads have SHA256
`c25ca144caaf4cc9552c572d12cb9fba704686e0dadc003d5a067831665d9b23`.
The luma copy is not exact; 896 distinct levels and a one-code maximum error
are measured properties of these tiny lossy packets. **No lossy-quality GO
threshold was set or inferred from this result.** The previously frozen
binary16 numerical/view limits apply to a different experiment and are not
reused to label codec quality accepted.

Source packets were generated from an exact raw 10-bit signal ramp, with neutral
chroma, in the same browser. The standalone header reader identifies profile 2
and depth 10 in saved bytes, but it is not a full independent pixel decoder.
This evidence establishes the narrow transport/readback behavior on this
backend; it does not qualify other pictures, settings, browsers or encoders.

Returned color tags match each supplied configuration. PQ and HLG packet bytes
are identical, and all three plane payloads are identical, so these observations
do not independently identify the transfer from the compressed picture. No
tone mapping, RGB conversion, mastering metadata, HDR display or perceptual
quality was tested by copying the raw planes.

## Ownership and slot release

Each cell opens/closes one decoder and one frame. Every row has zero terminal
owned resources, zero retained frames and 49,152 allocated readback bytes, below
the reviewed 1 MiB ceiling checked before allocation. No timeout, incomplete
drain, rejected visible rectangle or console error occurred. The incomplete
drain stop rule remained in place; this run does not fault-test that branch.

The command exited 0 only after awaited browser.close and server.close. A
subsequent scoped listener check found nothing on port 5202. The local report
marked the slot released before documentation/commit work continued. No further
browser, encoder, decoder, full-suite or R3 process was launched.

Chromium 151.0.7922.34 still reports ANGLE/SwiftShader software backend state.
Complete command-line disclosure is unavailable; the requested additional flag
remains `--mute-audio`. These explicit owner counts are not measurements of
native/internal resource reclamation or native Apple GPU performance.

## Current research decision and validation

The padded coded-size uncertainty is resolved for these three saved packets.
The same-browser raw 10-bit readback is measured and partial codec evidence is
stronger. Full managed-color promotion remains blocked by the recorded scope
precision failure, P3 transfer behavior, unresolved independent encoded-pixel
and metadata verification, Float32 implementation, resource/performance tests
and physical display qualification. No R3 scope is added by this result.

Validation: frozen starting SHA/hash checked before execution; identical source
identity recorded at completion and verified afterward. The evidence verifier
checks input/packet identities, all three geometry/plane results and owner
counts, original failures, historical gate manifests, current 22 baseline
source/package hashes, syntax and owned paths. The new readback manifest records
these immutable run artifacts. Diff checks pass; no production code, dependency,
schema, UI or SDR behavior changed. No unrelated tests/build were rerun.
