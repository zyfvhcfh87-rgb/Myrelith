# Source investigation and measured support matrix

Inspected 2026-09-08; baseline and package hashes are in `source-inventory.json`.
The source inventory and documentary tables began at R0. Bounded R2 results
are added below; each measured cell retains its narrow qualification. No codec
has yet encoded or decoded a frame, and no physical HDR display is qualified.

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
| Installed Playwright Chromium, macOS 26.6.2 / arm64 | Version 151.0.7922.34; follow-up reports ANGLE/SwiftShader, software canvas/video feature status. Node 26.8.1. Supplied physical host: Mac17,6 / Apple M5 Max / 64 GiB; this is not the measured GPU backend. | S for raw construction/copy only; decode U | P; float16 storage works in tiny tests, P3 draw changes pixels | U; headless cannot qualify | P config/structural only; actual encode U |
| Released Safari, macOS / Apple hardware | Not yet inventoried or driven. WebKit development support cannot stand in for released Safari. | U/P | U/P | U | U/P |
| Playwright WebKit on this Mac | Not installed; even if installed it would not automatically qualify Safari/VideoToolbox. | U | U | U | U |
| Firefox on this Mac | Playwright binary not installed. | U | U | U | U |
| Chromium/Edge Windows with an HDR display | No such host provided. | U | U | U | U |
| Other OS/GPU/codec combinations | No host or measured result. | U | U | U | U |

R4 must report **supported / partial / impossible for the exact path** alongside
these runtime facts. Unmeasured platforms remain unsupported for any proposed
product claim, without pretending that the platform itself is incapable.
Host identity does not qualify resident/native/GPU memory usage, browser backend
availability or HDR display behavior. Supplied evidence provenance and its exact
command are retained in `initial-validation.md` and `source-inventory.json`.

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

## Measured bounded R2 cells

Artifacts: [API/config probe](browser-probe-1.json),
[transfer follow-up](transfer-probe-1.json),
[metadata probe](metadata-probe-1.json). All are headless Chromium
151.0.7922.34, requested extra flag `--mute-audio`; follow-up CDP identifies
SwiftShader and refuses complete command-line disclosure because
`--enable-automation` is absent. Flags were not altered to obtain disclosure.
Do not attribute these measurements to native M5 Max acceleration.

| Operation | Measured result | Decision for this exact operation |
| --- | --- | --- |
| Raw I420P10 2×2 / I444P10 1024×2 construction/copy | Exact luma/chroma, preserved requested PQ/2020/full-range tags; respectively 4 and 1,024 distinct luma values | S for tested raw transport; compressed decode remains U |
| sRGB and P3 float16 ImageData put/get | Returned `float16`, preserved 1,024 red levels and tested -0.125 / 4 values | S for this tiny direct storage boundary |
| sRGB float16 canvas draw | Two-pixel opaque/half-alpha copy exact in all four requested standard/extended combinations | P; broader operations, rasterization and native backend untested |
| P3 float16 canvas draw | All four copies differ; opaque `[-.125,.5,4,1]` becomes `[0,.501953125,1,1]`; half-alpha also changes | No-go for unchanged-value extended P3 transfer on this backend |
| Canvas tone mapping | Both source and destination return `standard`, even when `extended` requested | Requested extended mode is not qualified |
| Float16 canvas → VideoFrame | `format=null`; native two-pixel copy returns 16 bytes with no public format interpretation established; explicit RGBA returns 8 bytes and clipped/converted values | P; byte count alone does not qualify float interchange or encoder input |
| Unorm8 negative control | 1,024 input levels become 256 | I for preserving original 10-bit detail through that boundary |
| WebGL2 RGBA16F | 2×2 framebuffer complete; known `[-.125,.5,4,1]` readback exact; 32-byte target plus 64-byte Float32 readback | S for tiny constant shader/readback only; filtering/composition/timing remain U |
| WebGPU extended config | No adapter returned | Unavailable in this headless configuration, not a claim about the physical GPU |
| MP4 / WebM basic color tags | Six complete SDR/PQ/HLG structural cases carry expected CICP fields; two missing-transfer cases reopen without complete tags | P; no decodable picture or mastering authoring qualified |
| VP9 packet color preservation in WebM | Three synthetic BT.2020 prefixes change color ID 5 to 0; SDR ID 2 remains unchanged; MP4 prefixes unchanged | Fails original in-band preservation; visible decode consequence remains unmeasured |

Encoder rows request 1920×1080, 30 fps, 8 Mb/s. Values below are
`isConfigSupported` answers only. Every row records requested and returned
configuration. A `true` cell is not proof of successful configuration, output
depth, usable packets, hardware use, or HDR metadata.

| Exact codec string | Encoder no preference | Encoder prefer hardware | Encoder prefer software | Decoder config |
| --- | --- | --- | --- | --- |
| `avc1.6e0028` | false | false | false | true |
| `hvc1.2.4.L120.B0` | false | false | false | false |
| `vp09.02.40.10.01.09.16.09.00` | true | false | true | true |
| `av01.0.08M.10` | false | false | false | true |

The [VP9 specification](https://storage.googleapis.com/downloads.webmproject.org/docs/vp9/vp9-bitstream-specification-v0.7-20170222-draft.pdf),
§6.2.2/§7.2.2, identifies 5 as BT.2020 and 0 as unknown; unknown permits
external signaling. Therefore the WebM rewrite demonstrates lost in-band
information, not proven incorrect displayed colors when container tags exist.
VP9's color ID does not independently express PQ versus HLG, so a future
metadata resolver needs codec-aware authority, not a blanket requirement that
every tag exist in both places. The laboratory's complete-tag policy tests
are intentionally restrictive examples, not a finished import resolver.

The [VP codec MP4 binding](https://www.webmproject.org/vp9/mp4/) supplies
the separate profile, bit depth and color fields, and `SmDm`/`CoLL` mastering
boxes checked by the independent parser. None of the eight synthetic outputs
contains mastering/content-light elements. This does not establish that every
possible library pass-through path lacks them.
