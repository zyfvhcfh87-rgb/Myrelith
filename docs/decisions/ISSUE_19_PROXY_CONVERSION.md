# Issue #19 Slice 6 — local proxy-conversion decision

**Decision:** no-go for a built-in browser-side proxy converter in Issue #19.

**Date:** 2026-07-20

This is a decision about automatic or opt-in transcoding inside WebCut. It does
not remove direct import, the locally bundled ProRes and AC-3/E-AC-3 decoder
fallbacks, or explicit video-only/audio-only import.

The optional proxy-conversion go/no-go decision is complete. The conversion
implementation is not shipped. WebCut must continue to report unsupported media
honestly and preserve the original source reference.

## Candidate and acceptance boundary

The spike evaluated the current stock `ffmpeg.wasm` path:

- `@ffmpeg/ffmpeg` 0.12.15 (MIT wrapper)
- `@ffmpeg/core` 0.12.10 (GPL-2.0-or-later package)
- single-threaded worker, loaded locally after a manual action in the temporary
  harness
- candidate MP4 output profile with H.264/AVC `yuv420p`, 30-frame closed GOPs
  (one second for the measured 30 fps fixtures), and optional 48 kHz stereo
  AAC; the spike did not certify it as an editing-friendly product profile

A shippable implementation would have needed all of the following:

1. explicit consent before loading a converter or reading source bytes;
2. useful progress, bounded cancellation, time/memory/file-size budgets, and
   cleanup on success, error, and cancellation;
3. streaming local storage without holding a second whole movie in JavaScript
   or WebAssembly memory;
4. an atomic proxy manifest with eviction/quota UX while keeping the original
   source as the portable relink identity;
5. exact proxy/original timing and track provenance at every preview, visual,
   audio, render, and export boundary;
6. a reviewed redistribution/license plan, acceptable lazy payload, and
   acceptable behavior without cross-origin isolation and on low-memory
   devices.

## Measured browser spike

The spike ran in Chrome 150.0.0.0 through WebCut's in-app browser on Windows,
on an AMD Ryzen 9 5900X (12 cores/24 logical processors) with 34,216,189,952
bytes (31.9 GiB) of physical RAM. `navigator.deviceMemory` returned a coarse
32 GiB hint. The page was not cross-origin isolated and did not expose
`measureUserAgentSpecificMemory`. The harness loaded its core assets from the
local Vite origin and included no runtime CDN or media-upload path.

Inputs:

- Mechanics/cancellation fixture: 8.008 s WebM, 1,531,115 bytes, with VP9
  1280×720 video at 30 fps and mono 48 kHz Opus. Chromium can normally decode
  this family, so it was not treated as unsupported-codec proof.
- Limited direct-decoder-gap fixture: 8.021 s Matroska, 9,009,804 bytes, with
  MPEG-2 1280×720 video at 30 fps and mono 48 kHz AAC. Local `ffprobe`
  identified MPEG-2 video; the browser-side Mediabunny probe returned `false`
  for `videoCanDecode` while AAC returned `true` for `audioCanDecode`.

Conversion profile:

```text
-map 0:v:0 -map 0:a:0?
-c:v libx264 -preset ultrafast -crf 20 -pix_fmt yuv420p
-g 30 -keyint_min 30 -sc_threshold 0
-c:a aac -b:a 128k -ar 48000 -ac 2
-movflags +faststart
```

| Observation | Result |
|---|---:|
| Raw WASM core | 32,232,419 bytes |
| Local cached core load + compile | 135.3–311.3 ms |
| VP9/Opus source conversion | 4,224.4 ms |
| VP9/Opus output | 8,546,767 bytes |
| MPEG-2/AAC source read + WASM-FS write | 11.3 ms + 2.3 ms |
| MPEG-2/AAC conversion | 4,197.4 ms |
| MPEG-2/AAC whole-output read | 3.5 ms |
| Direct-decoder-gap output | 10,393,232 bytes |
| `terminate()` return time during an active rerun | 0.2 ms |

Mediabunny independently reopened both outputs. The direct-decoder-gap result
was an 8.0333 s MP4 with 1280×720 `avc1.42c01f` video and 48 kHz stereo
`mp4a.40.2` audio; both output configurations returned `canDecode: true`. This
verified the container, metadata, and decoder configurations, not random seek
latency or sample-level editing correctness. The browser console had no warning
or error entries.

The happy-path fixture proves that conversion can work. It does not make the
candidate safe for arbitrary editor media. The VP9 proxy was 5.58× its source;
the MPEG-2/AAC proxy was 1.15× its source. The measured
`writeFile`/`readFile` flow materialized the complete input for the WASM file
system and returned the complete output as a `Uint8Array`. Stock WORKERFS can
mount a read-only `File`/`Blob` without this input copy, but the public API does
not provide an equivalent atomic streaming OPFS output sink.

`terminate()` returned in 0.2 ms, invalidated the worker, and prevented a late
completion from appearing in the harness. The core then had to be loaded again
before any other call. This timing does not prove immediate CPU stop, WASM
memory reclamation, or complete storage cleanup. On the rerun, the experimental
progress event emitted a nonsensical intermediate value of
`1,151,769,734,871.975` before returning to `0.1128`, so it cannot be used as a
truthful product progress contract without a separate measured progress model.

## Why this is a no-go

| Gate | Decision evidence |
|---|---|
| Bounded memory and storage | **Not demonstrated; fail closed.** The measured `writeFile`/`readFile` path materialized the complete input and output. WORKERFS can avoid the input copy, but there is no public atomic streaming OPFS output contract. Upstream documents a 2 GB input ceiling, below WebCut's 8 GiB automatic local-fallback ceiling and 64 GiB metadata-probe ceiling. Worker/WASM peak memory and cleanup were not portably measurable. |
| Progress and cancellation | **Fail/unproven.** Progress is documented as experimental and produced an invalid value in the rerun. Hard-stop requires worker termination and a full core reload; the 0.2 ms return time did not prove memory reclamation or exact cleanup. |
| Bundle and startup cost | **Unaccepted.** The raw single-thread core is 32.2 MB. The published package is 64.7 MB unpacked install footprint, not compressed transfer size. No acceptable lazy-payload budget was established. Multi-threading does not remove the storage/memory problem. |
| Browser isolation and performance | **Not demonstrated; fail closed.** Single-thread conversion worked without isolation. Multi-thread requires `SharedArrayBuffer` and therefore an app-wide isolation decision. Upstream's historical core 0.12.3 benchmark on Chrome 116/Linux took 128.8 s single-threaded and 60.4 s multi-threaded for its WebM→MP4 case, versus 5.2 s native. The fast Ryzen synthetic fixtures do not prove representative or low-memory behavior for current core 0.12.10. |
| License/distribution readiness | **Fail.** The stock core is marked GPL-2.0-or-later and includes GPL encoders such as x264. WebCut has no reviewed GPL/source-distribution or codec/patent plan for this payload. Shipping it now would make the existing final distribution review less honest, not more complete. |
| Original/proxy identity | **Fail.** `MediaAsset` and `PortableAssetDescriptor` currently describe one effective media representation while also retaining the original relink identity. A downscaled/CFR proxy needs a separate provenance and timing model so preview, thumbnails, audio, render, export, Save/Resume, Relink, and cleanup cannot accidentally replace or export the wrong representation. |

Any unmet required gate blocks shipping. The spike directly failed several and
left the remaining resource/performance properties unproven. The good 720p
conversion results therefore do not justify exposing consent, progress,
storage, or cleanup UI for a path that cannot yet satisfy its safety contract.

## Product behavior after the decision

- No converter package or proxy bytes are added to the shipped app.
- No proxy state is added to Zustand or `.webcut`.
- The original selected file remains the only source and relink identity.
- Unsupported files stay visible and non-draggable unless the existing safe,
  explicitly confirmed whole-kind partial import applies.
- Users may convert unsupported media outside WebCut and import the converted
  result as a new source; WebCut does not claim to manage that external file.

## Reopen conditions

Reconsider local proxy conversion only as a new, separately approved issue
after all of these are available:

- a reviewed redistributable core (or browser-native encoder path) with a
  documented source/license/patent plan and a materially smaller lazy payload;
- streaming source reads and atomic OPFS output with quota checks, eviction,
  cancellation, and no whole-output JS/WASM copy;
- a first-class original-versus-proxy domain model with timing/provenance and
  explicit export-original policy;
- repeatable Chrome measurements on representative 60 s 1080p and long-form
  fixtures, including low-memory devices, with peak-memory and cleanup proof;
- representative Limited and Unsupported direct-decoder-gap sources plus
  random-seek, filmstrip, waveform, playback, and export verification of the
  derived representation;
- monotonically bounded progress and cancellation that reaches a clean idle
  state within two seconds without corrupting stored output;
- an explicit cross-origin-isolation decision for any multi-threaded build.

## Sources

- [ffmpeg.wasm architecture and packages](https://ffmpegwasm.netlify.app/docs/overview/)
- [ffmpeg.wasm usage, multi-thread requirement, and experimental progress](https://ffmpegwasm.netlify.app/docs/getting-started/usage/)
- [ffmpeg.wasm API: file-system calls and terminate/reload behavior](https://ffmpegwasm.netlify.app/docs/api/ffmpeg/classes/ffmpeg/)
- [Emscripten WORKERFS](https://emscripten.org/docs/api_reference/Filesystem-API.html#workerfs)
- [ffmpeg.wasm published performance comparison](https://ffmpegwasm.netlify.app/docs/performance/)
- [ffmpeg.wasm FAQ: 2 GB input limit and component licensing](https://ffmpegwasm.netlify.app/docs/faq/)
- [`@ffmpeg/core` 0.12.10 package metadata](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10)
- [FFmpeg license and legal considerations](https://ffmpeg.org/legal.html)
