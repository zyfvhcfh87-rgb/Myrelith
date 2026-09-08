# Immutable diagnostic attempt 2: complete observations

The approved diagnostic at clean `1ae6baedf4e9788836e566cd58541fc459d702ee`
completed with exit 0. At frame 127, actual production source pixels match the
ordinal source exactly, and actual unencoded compositor RGB matches the oracle
built from that same input exactly. The saved encoded video's maximum RGB error
remains 19, with mean 0.06854926215277778. All 45 channels exceeding the original
maximum-12 limit belong to 15 pixels outside mask coverage.

These observations narrow the discrepancy to the saved encoded-output side of
the comparison. They support a codec-sensitive output explanation and provide
no evidence of a source-selection or mask-composition error at this frame.
They do not isolate the encoder, decoder or other differences from the original
export run. No original pre-encode buffer was retained. The original export
check stays **failed/incomplete**; no tolerance or acceptance predicate changed.

## Source and sampling

Only the two original saved MP4 files were served, using their unchanged byte
counts and SHA-256 pins. The exact command is in raw record 00000 and the
[command log](command.log). The fresh raw directory is
`/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue198/.tmp/issue198-1ae6bae-diagnostic-attempt2`.

Recorded start through final evidence closure was
20:56:37.863Z–20:56:39.749Z on 2026-09-08, 1,886 ms. Browser collection took
1,173.8 ms. This is a bounded diagnostic duration, not a performance or native
memory qualification. Headless Chromium 151.0.7922.34 reported software
SwiftShader. No encoder, export sink or new source fixture was constructed.

Both videos produced exactly 300 ordinal samples followed by six sparse target
samples at 0/126/127/128/255/299. All 600 returned ordinal timestamps are exactly
ordinal/30, with duration 1/30. All twelve ordinal/sparse pairs have identical
full RGBA hashes and zero RGB error. The 24 selected VideoFrames have matching
source/output times with the expected sub-microsecond integer timestamp
quantization. Each input closes 306 samples, twelve selected VideoFrames and
its reader; each readback canvas reaches 1×1.

The real production source consumes and closes leases 0–127 exactly once.
Its frame-127 plan selects source frame 127 and expected held path 1. One
unencoded `compositeFrame` uses the same lease-owned decoded ImageBitmap as its
input oracle. The actual source RGBA hash is
`ee795fbbe732cde78649e72b3cd9c100d16fe1f06a888ff046ff72e28301263f`, identical to
ordinal source 127. Main and scratch canvases report sRGB/unorm8, with the
requested readback policies recorded; both source and output ImageData report
sRGB. The output draws `resource-mask` with no missing source.

## Pixel observations

Every comparison covers 2,764,800 RGB channels. RGB equality with a coverage
oracle does not imply equal RGBA hashes: the oracle retains mask alpha for
region labels, while the compositor produces the opaque black-backed image.

| Frame-127 reference candidate | Maximum error | Mean error |
| --- | ---: | ---: |
| Source 126, path 0 | 137 | 11.7469780816 |
| Source 126, path 1 | 19 | 0.7001725260 |
| Source 127, path 0 | 138 | 11.2579437934 |
| Source 127, path 1 | 19 | 0.0685492622 |
| Source 128, path 0 | 92 | 44.5292523872 |
| Source 128, path 1 | 66 | 41.8470822483 |

Actual production input versus ordinal source 127: maximum and mean 0.
Unencoded production output versus its matching-input oracle: maximum and mean
0 in opaque, feather and outside regions. Saved output versus unencoded
production output has an error object exactly equal to the correct source-127,
path-1 candidate, including histogram, regions and coordinates. Its maximum and
mean exactly reproduce the original export failure record 00322.

| Saved output versus unencoded production | Channels | Maximum | Channels above 12 |
| --- | ---: | ---: | ---: |
| Opaque mask interior | 1,678,848 | 2 | 0 |
| Feather | 318,468 | 5 | 0 |
| Outside coverage | 767,484 | 19 | 45 |

The maximum occurs at (79, 528), where saved R/G/B each equal 19 and the
unencoded reference is black. All 45 above-limit channel coordinates were
retained, within the 64-coordinate cap; they describe fifteen distinct pixels.
Full 256-bin error histograms and region totals are in the raw records.

## Ownership, audit and remaining limits

The exact completed work ledger is 600 ordinal + 12 sparse + 128 production
source requests = 740 public requests, six candidates and one production
composite. All 128 leases close, the media source closes, four diagnostic
canvases reach 1×1, and grading bytes/tasks/entries/ports settle to zero.
The caller-owned array ledger peaks at 47,923,200 bytes, below 64 MiB, and ends
with all 34 allocations released and zero retained buffers/bytes. Private
decoder queues and browser/native memory are outside that array ledger; no
native leak or full renderer-admission result is inferred.

The host records exactly two immutable GETs, no warning/error/page errors and
normal context/browser/server/Vite cleanup. [worker-cleanup.json](worker-cleanup.json)
independently verifies all eight recorded PIDs absent and port 5198 refused at
20:57:14.090298 UTC. [parent-audit.json](parent-audit.json) independently confirms
the same physical release at 20:58:56.977025 UTC and verifies all 63 raw hashes,
twelve exact sampling pairs and the two zero-error stages. The exclusive slot
was returned. No further native action followed.

[audit.py](audit.py) independently checks every raw size/hash, sequence, work
and owner count, all 600 timestamps, 24 target frames, twelve sampling pairs,
21 error histograms/region totals/coordinate bounds, selected source/path and
exact stage comparisons. [audit.json](audit.json) retains its output.
[raw-evidence.tar.gz](raw-evidence.tar.gz) contains all 63 exact numbered records
and the original manifest: 64 members independently verified against raw bytes.
The numbered records total 770,667 bytes. The 8,491-byte manifest has SHA-256
`c88ca0d846069ed5f2c6c5875522c55bc6aa79d237e8399faf619ce9e746dc42`.
[artifact-index.json](artifact-index.json) pins every package member.

The source and both immutable MP4 files remain unchanged. Earlier failure
packages remain intact. This diagnostic qualifies its scoped observations;
the full production export/cancel/retry sequence, codec-output acceptance and
the remaining actual renderer-admission matrix still require separately
reviewed protocols and execution grants.
