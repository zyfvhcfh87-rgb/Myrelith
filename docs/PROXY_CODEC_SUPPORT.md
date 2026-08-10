# Editing proxy codec and representation contract

Issue #70 adds optional, disposable editing proxies. This document is the
published support matrix for the shipped generator; the Media Pool does not
enable **Generate proxy** until the exact source decoder and output encoder
checks below pass in the current browser session.

## Codec matrix

| Stage | Supported | Rejected or intentionally absent |
|---|---|---|
| Source container | Any container that pinned Mediabunny `1.50.9` can open through `ALL_FORMATS`, provided it exposes a primary video track | Unrecognized/damaged input and files without a primary video track |
| Source video decode | The exact track configuration must pass `track.canDecode()` at the `proxy-generation` boundary. ProRes may use Myrelith's existing lazy local Mediabunny fallback within the 8 GiB, 2 hour, DCI 4K30 automatic budget | Any other browser-unsupported video codec/configuration; incomplete geometry or rational frame-rate facts; sources above the existing decoder safety budget |
| Source audio | Not decoded for proxy generation. Live preview audio continues to use the original connected source | Audio-only proxy generation, proxy audio, or using proxy audio as project/export truth |
| Proxy video encode | MP4 + AVC, runtime-probed with `Mp4OutputFormat.getSupportedVideoCodecs()` and `canEncodeVideo('avc', exact width/height/bitrate)` before output allocation | Codec/container substitution, software/WASM encoder fallback, or starting generation when native AVC encoding is unavailable |
| Proxy audio encode | None | Every audio codec |
| Preview selection | A provenance-fresh proxy is preferred; a fresh cached proxy may preview while the original is offline | Stale proxies; silent fallback after a proxy open/decode failure |
| Final export selection | The original is always required and its existing export boundary is revalidated | Every proxy, including a fresh proxy while the original is offline |

The proxy profile is `proxy-720p-avc-2m-v1`: at most 1280 x 720, even
dimensions, source rational frame rate, 2,000,000 bit/s AVC, one-second key-frame
interval, MP4, and no audio. Smaller sources are not enlarged. WebCodecs chooses
implementation-specific AVC profile/level details, so Myrelith does not promise
a fixed H.264 profile or pixel format that the browser API did not request.

## Capability and failure behavior

The Media Pool first verifies `OffscreenCanvas`, `VideoEncoder`, the MP4 AVC
codec family, the exact output geometry/bitrate, and the exact input decoder
configuration. Unsupported input/output stays disabled with its concrete
reason. Generation repeats both checks before acquiring its one-shot OPFS file
capability, so a stale capability result cannot create committed bytes.

One `MediaJobScheduler` permits at most one proxy job and one active decoder.
Decoded canvases are consumed sequentially with awaited encoder and OPFS
backpressure. Cancel, source removal/replacement, decode failure, encoder
failure, and output failure dispose the Mediabunny `Input`, cancel the output,
abort staged bytes, and publish a retryable state. A manifest entry is written
only after mux finalization and OPFS commit.

## Cache and provenance

`myrelith-derived/proxy-cache-v1` is an origin-local OPFS sidecar. Its strict
schema-1 manifest records stable asset id, sampled SHA-256 source fingerprint,
original name/size/mtime, complete generation parameters, generator version,
file name/type/bytes, output dimensions/rate/duration, creation time, and last
use. The fingerprint explicitly identifies itself as `sha256-sampled-v1`: it
hashes metadata plus the first, middle, and last 64 KiB, rather than claiming a
full-file digest. A connected original is fully resampled before a proxy becomes
fresh. An offline match may use only the remembered name/size/mtime descriptor;
relink triggers content revalidation.

Cache writes commit the new manifest before deleting replaced or LRU-evicted
files. Capacity stays below both 80% of the browser-reported origin quota and
64 MiB of remaining origin headroom where estimates are available. Only
manifest-owned proxy files are evicted. The UI reports proxy bytes/items,
whole-origin usage/quota, persistence status, progress, cancel/retry/regenerate,
per-item removal, and an explicit clear-all action. Clearing derived data never
touches projects, recovery, remembered handles, original media, or portable
`.myrelith` files.

Proxies never enter `TimelineDoc`, media descriptors, project persistence,
recovery, or export settings. They are disposable acceleration, not project
truth.
