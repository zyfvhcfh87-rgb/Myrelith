# Initial source investigation and support matrix

Inspected 2026-09-08; baseline and package hashes are in `source-inventory.json`.
This is R0 documentary evidence. **No browser capability probe has run.**

Labels: **S** = supported by the cited specification/source for the narrow
operation; **P** = partial, conditional or unmeasured end-to-end path; **I** =
impossible through the stated unchanged implementation. Specification support
never means measured support on every browser. **U** = not tested/available;
it is not evidence of failure. R2 must add exact requested/returned settings,
pixel results and browser build to each measured cell.

## Primary sources

| ID | Source examined | Narrow finding |
| --- | --- | --- |
| S1 | [W3C WebCodecs](https://www.w3.org/TR/webcodecs/), especially VideoPixelFormat, VideoColorSpace, copyTo and codec support | Defines 10/12-bit planar formats and separate primaries/transfer/matrix/range tags. I420P10 stores each 10-bit sample in a little-endian 16-bit integer. Codec/configuration support remains implementation-dependent. The inspected enum does not provide an arbitrary Float32 RGBA transport. |
| S2 | [WHATWG Canvas](https://html.spec.whatwg.org/multipage/canvas.html), CanvasColorType and ImageData | Float16 backing storage and float16 ImageData are defined alongside default unorm8. Creation, drawing, conversion and readback must each be tested; 16-bit storage is not a guarantee of physical HDR presentation. PNG serialization can still clip out-of-unit values. |
| S3 | [Chrome 129 WebGPU announcement](https://developer.chrome.com/blog/new-in-webgpu-129) | Documents extended tone mapping with `rgba16float`; establishes a candidate presentation API, not a calibrated-output guarantee on this host. |
| S4 | [Khronos EXT_color_buffer_float](https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/) | Defines RGBA16F/RGBA32F render targets and RGBA/FLOAT readback. Outputs are not clamped. Float readback can need a 16-byte-per-pixel CPU allocation even with an 8-byte texture. Framebuffer completeness, filtering and blends still need proof. |
| S5 | [WebKit bug 320848](https://bugs.webkit.org/show_bug.cgi?id=320848) | August 2026 change rejects float16 canvas/ImageData on platforms lacking the corresponding RGBA16F implementation. This is a development change, not evidence that a particular released Safari includes it. |
| S6 | [WebKit Safari 17.5](https://webkit.org/blog/15383/webkit-features-in-safari-17-5/) | AV1 WebCodecs decode is documented when hardware decode is available. It does not establish a 10-bit AV1 encoder. |
| S7 | [Mediabunny media sources](https://mediabunny.dev/guide/media-sources) and installed 1.50.9 source | `fullCodecString` can select an exact profile. Encoded packets accept decoder config color tags. The installed source, rather than an unpinned website version, determines Myrelith's behavior. |
| S8 | [HEVC WebCodecs registration](https://www.w3.org/TR/webcodecs-hevc-codec-registration/) | Defines HEVC codec identification and configuration framing. Registration is not a mandatory encoder implementation or a mastering-metadata authoring API. |
| S9 | [ITU-R BT.2100-3 (2025)](https://www.itu.int/rec/r-rec-bt.2100) | Primary reference for PQ/HLG signal interpretation. R1 must inspect its exact equations and reference conditions before creating goldens. |
| S10 | [CSS Color 4](https://www.w3.org/TR/css-color-4/) and [CSS Color HDR](https://www.w3.org/TR/css-color-hdr-1/) | Color 4 supplies independent conversion sample code; the HDR draft distinguishes SDR wide gamut from HDR and documents PQ/HLG spaces. A draft does not prove released CSS/Canvas implementation. |
| S11 | [Matroska element specification](https://www.matroska.org/technical/elements.html) | Separately defines colorimetry, MaxCLL, MaxFALL and mastering-display fields. Writing color tags alone does not write all of these elements. |
| S12 | [Shotcut features](https://shotcut.org/features/) and [Kdenlive rendering](https://docs.kdenlive.org/en/exporting/render.html) | Product comparators supplied by #202; useful workflow context only. Neither establishes browser support or serves as the numeric oracle. |

The issue-linked Shotcut release page and guessed `/guide/hdr` Mediabunny URL
returned fetch errors. No claims rely on their unseen contents. The relevant
Mediabunny guide and its installed source were available.

## API and codec path inventory

| Path | Documentary status | Known boundary | Required R2 proof |
| --- | --- | --- | --- |
| 10-bit YUV decode and raw `VideoFrame.copyTo` | P (S1/S8) | Runtime may reject profile, expose inaccessible/native format, convert, or quantize. | Decode externally constructed 10-bit steps; inspect format/tags/strides; copy raw planes and recover >256 levels. Close frames in finally. |
| Raw I420P10/I444P10 construction | S at API level, P per browser (S1) | Typed-array width alone proves nothing about interpretation/transfer. | Known little-endian planes, layout, `allocationSize`, exact copy, all tags, malformed buffer rejection. |
| Float16 Canvas2D + ImageData | S at standard level, P per browser (S2/S5) | Ignored settings, implicit color conversion, alpha precision and draw/readback can differ. | Returned context attributes, Float16Array data, values above 1/below 0, 1,024-level ramp and alpha edges through every hop. |
| WebGL2 float intermediate | S with extension, P per device (S4) | Existing Myrelith backend remains RGBA8; Float32 readback costs more than storage. | Extension, framebuffer, precision, bilinear filtering, alpha/blending and context-loss cleanup, with exact returned pixels. |
| WebGPU extended presentation | S in documented Chrome API, P for actual monitor (S3) | Working color-space conversion and physical display behavior are separate. | Adapter/configuration checks and storage readback; physical qualification remains U without suitable display measurement. |
| Canvas → current Myrelith `CanvasSource` → encoder | I for preserving original 10-bit detail | Existing composition already quantizes to RGBA8. | Negative control must demonstrate level collapse; never mark it HDR-safe after successful encoding. |
| AVC high-bit-depth, HEVC Main10, VP9 profile 2, AV1 10-bit encode | P; separate exact codec cells | Platform/codec/profile/acceleration differences; current default VP9/AV1 strings use 08. | `isConfigSupported` requested versus accepted keys, configure/encode/flush, independently parse emitted profile/bit depth and decode the ramp. Record unsupported cells. |
| MP4 basic colorimetry | S in installed mux source, P round trip | `colr` emitted only for complete colors; QuickTime `nclc` lacks the MP4 range flag. | Independently parse MP4 boxes and bitstream signaling; compare input/muxed/reopened values, missing and conflicting tags. |
| Matroska/WebM basic colorimetry | S in installed mux source, P round trip (S11) | Existing writer carries four basic fields, not an automatically complete HDR contract. | Independent EBML parse and reopened sample tags. |
| HDR10 mastering/content-light metadata authoring | I through unchanged Myrelith export contract; P for future transport | No owned output mastering contract/API, and inspected Mediabunny video-description writer emits codec config, pixel aspect and color box only. Broad source search found no `mdcv`, `clli`, MaxCLL or mastering writer. | Independent container plus codec inspection; do not infer missing metadata from a method name or tag presence. Preserve encoded pass-through separately from edited/reencoded output. |
| Physical HDR monitor qualification | U on this task | Headless readback/screenshots/media queries cannot prove emitted luminance, OS mapping or reference viewing conditions. | Explicit later hardware/viewing qualification; no hidden claim of monitor support. |

## Browser / OS / hardware qualification cells

| Target | Available facts | 10-bit decode/readback | Float processing | HDR monitor | 10-bit encode + metadata |
| --- | --- | --- | --- | --- | --- |
| Installed Playwright Chromium, macOS 26.6.2 / arm64 | Chromium revision 1234 executable exists; actual version/adapter not yet probed. Node is 26.8.1. Hardware model/RAM query denied in restricted environment. | U/P | U/P | U; headless cannot qualify | U/P |
| Released Safari, macOS / Apple hardware | Not yet inventoried or driven. WebKit development support cannot stand in for released Safari. | U/P | U/P | U | U/P |
| Playwright WebKit on this Mac | Not installed; even if installed it would not automatically qualify Safari/VideoToolbox. | U | U | U | U |
| Firefox on this Mac | Playwright binary not installed. | U | U | U | U |
| Chromium/Edge Windows with an HDR display | No such host provided. | U | U | U | U |
| Other OS/GPU/codec combinations | No host or measured result. | U | U | U | U |

R4 must report **supported / partial / impossible for the exact path** alongside
these runtime facts. Unmeasured platforms remain unsupported for any proposed
product claim, without pretending that the platform itself is incapable.

## Pinned library observations to carry into R2

- `input-track.ts:710–720` returns color tags and uses a broad HDR heuristic
  that includes BT.2020 or Display-P3 primaries. That heuristic cannot decide
  whether the transfer is HDR; P3 SDR is a required negative fixture.
- `codec.ts:290–304` builds default 8-bit VP9/AV1 strings; `encode.ts:343`
  accepts `fullCodecString` but does not prove that a host honors it.
- `isobmff/isobmff-boxes.ts:705–750` writes the sample description and basic
  `nclx`/`nclc` color fields. `matroska/matroska-muxer.ts:367–393` writes basic
  colorimetry. Missing mastering APIs mean the existing edited-export path
  cannot satisfy the proposed HDR10 contract as it stands.
- Raw sample APIs, CanvasSink conversion and native VideoFrame transport need
  separate experiments. No decode-to-canvas success qualifies source precision.
