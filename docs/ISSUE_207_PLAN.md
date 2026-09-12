# Issue #207 — browser-local codec and container evidence gate

Status: **research program.** Completing this issue means a repeatable
evidence gate and an explicit go / no-go per candidate. It does **not**
mean adding codecs to the product.

Issue: [#207](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/207)
Roadmap parent: [#185](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/185)
Milestone 10.

## Non-goals

- FFmpeg-parity with Shotcut/Kdenlive.
- MPEG-2, DTS, DNx, MXF, BRAW, R3D, HAP, or any codec Mediabunny 1.50.9 does
  not already name.
- WASM encoder fallbacks, unrestricted `ffmpeg.wasm`, runtime CDN code,
  uploads, or cloud transcoding.
- README / export-profile / `MediaDecoderPath` changes until a child issue is
  accepted.
- Firefox / Safari certification (Issue #208).
- Redoing Issue #204 delivery products or Issue #202 HDR.

## How to run

```bash
npm run qa:issue207:check
npm run qa:issue207:research
```

`--node-only` skips Playwright. Fixture bytes stay in
`.tmp/issue207/fixtures/` (gitignored). Evidence JSON stores hashes only.

The laboratory lives under `scripts/issue207/` and must not enter the
ordinary production graph. See `ARCHITECTURE.md`.

## Exit criteria

| Criterion | Record |
|---|---|
| Rank candidates from demand and representative fixtures | [ranking](evidence/issue207/ranking.md) |
| Browser / OS / hardware matrix with direct vs fallback | [capability matrix](evidence/issue207/capability-matrix.md) |
| Measure correctness, seek, A/V sync, memory, throughput, size, recovery | [measured run](evidence/issue207/measured-run.md) |
| License and distribution notes before any bundled code | [licensing](evidence/issue207/licensing.md) |
| One bounded child **or** explicit no-go per candidate | [candidates](evidence/issue207/candidates/) and [final decision](evidence/issue207/final-decision.md) |
| No shipping format claim without fixtures + browser evidence | this plan; README unchanged |

## Inventory layers

Every candidate is scored on three independent questions:

1. **Demux** — does pinned Mediabunny 1.50.9 open the container and name the track?
2. **Decode** — does this Chromium/OS/GPU `canDecode()` natively, or is there an already-reviewed local family (`local-prores`, `local-ac3`)?
3. **Encode** — is there a native WebCodecs encoder in an already allow-listed container pair?

Import and export columns never imply each other. ProRes/AC-3 already follow
that rule.

## Guardrails

- One candidate per experiment.
- Modules bundled and lazy-loaded locally.
- Preserve the typed capability model.
- Every evaluated path must work locally after application assets are loaded.
- Close every `VideoFrame` / `AudioData` / `ImageBitmap`; integer frames;
  audio remains the master clock in the product. The lab uses integer-frame
  timestamps and closes every Mediabunny sample.
- HLS stays Blob-local: `BlobSource` / `BufferSource` is not a `PathedSource`,
  so a picked `.m3u8` must fail closed.

## Child-issue bar

A later implementation issue is allowed only when all of these are true:

1. Mediabunny already names the codec (or a reviewed pin adds that name and demux mapping).
2. The path is a decoder, or a native encoder the browser already exposes.
3. The module is locally bundled, lazy, realm-registered, budgeted, cancellable, and license-reviewed.
4. Import and export verdicts are independent.
5. Preview, seek, playback, filmstrip/waveform, cancel, and export revalidation are proven.
6. No silent substitution, CDN, upload, or new `.myrelith` schema for capability facts.
