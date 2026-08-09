# Issue #19 codec matrix and browser closeout

**Date:** 2026-07-20
**Decision:** Close Issue #19 as implementation-complete at 46/49 checklist
items. The three unchecked proxy-conversion implementation items remain
intentionally out of scope under the accepted no-go decision.

This record closes the compatibility, diagnostics, fallback, resource-safety,
and browser-gate work. It does **not** certify Myrelith for public distribution or
claim universal codec support.

## Reproducible fixture matrix

Run:

```bash
npm run qa:issue19:fixtures
```

The generator requires `ffmpeg` and `ffprobe` on `PATH`. It writes ignored QA
artifacts to `.tmp/issue-19-codec-fixtures/`, including a manifest with byte
sizes, SHA-256 hashes, and `ffprobe` results. It exits nonzero when a required
container, codec, geometry, audio configuration, or designed-damage outcome
does not match the matrix. No fixture bytes enter the product bundle.

| Fixture | Observed Windows Chrome 150 result |
|---|---|
| `avc-aac.mp4` | Ready; native AVC and AAC |
| `vp9-opus.webm` | Ready; native VP9 and Opus |
| `avc-ac3.mkv` | Ready; native AVC and local AC-3 fallback |
| `avc-eac3.mkv` | Ready; native AVC and the shared AC-3/E-AC-3 fallback family |
| `hevc-aac.mp4` | Ready on this host; native HEVC and AAC |
| `av1-opus.webm` | Ready on this host; native AV1 and Opus |
| `spoofed-vp9.mp4` | Ready and correctly identified as WebM despite the `.mp4` name and declared type |
| `unknown-codec.mp4` | Limited; unknown `zzzz` video plus native AAC, with an explicit audio-only path |
| `malformed-avc-config.mp4` | Limited; missing/invalid AVC decoder description plus native AAC, with an explicit audio-only path |
| `truncated-faststart.mp4` | Metadata probe remained Ready because the leading metadata was intact; downstream failures still use the guarded runtime diagnostic path |
| `truncated-before-moov.mp4` | Unsupported; detected MP4 with no readable video or audio track |
| `empty.mp4` | Error; rejected by the file-size/resource boundary |
| `random-bytes.mp4` | Unsupported; not a supported media container |

HEVC and AV1 are observations, not hard-coded promises. Myrelith asks the active
browser about the exact configuration again in every new runtime and at each
real decode boundary.

The unknown-codec fixture also re-verified the informed partial-track path. Its
dialog named the retained AAC audio, omitted `zzzz` video, unchanged original
source, and timeline/export consequence. Confirmation produced a visible
`Ready - audio only` result; no track was omitted automatically.

## Resource and lifecycle closeout

Three final ownership gaps were fixed and regression-tested:

- Fallback capability work now races non-abortable module/browser operations
  against the caller's AbortSignal. A cancelled caller rejects promptly and
  cannot publish a late result; an already-started realm registration may
  still finish safely in the background.
- Live-audio Inputs pass through one exact-once disposal guard, including a
  close that overtakes a pending track open.
- A committed import releases the editor immediately and observes its
  remembered-handle write in the background. Explicit source removal queues
  its handle deletion after any pending write, while project teardown never
  infers deletion from an empty media store.
- Preview, filmstrip, waveform, live-audio, and export revalidation carry the
  immutable probed source budget plus the live Blob/configuration cost. Missing
  or invalid fallback metadata fails closed before local decoder loading/use,
  preserving the exact `resource-limit` reason through UI diagnostics.
- Filmstrip decoder output and the joined canvas have explicit width bounds,
  including hostile source aspect ratios.
- The legacy decoder worker captures its generation before asynchronous bitmap
  creation and closes a late bitmap instead of caching it after teardown.

The focused Issue #19 suite passed 346/346 tests across 16 files. Together with
the existing probe, import-controller, runtime-boundary, worker, audio, export,
and cache suites, it covers every serializable reason code, prompt abort,
exact disposal, remove/re-add races, fallback registration/retry/coalescing,
runtime invalidation, and stale-result suppression.

## Real browser gates

A fresh 1280 x 720, 30 fps, 48 kHz project ran the same real VP9/Opus vertical
slice in Chrome 150 and Edge 150:

1. Import reported WebM, native VP9, native Opus, Ready, and draggable.
2. The Media Pool thumbnail reached `ready`; one filmstrip and one waveform
   rendered on the timeline.
3. One drop created linked V1/A1 clips with the same link-group id.
4. A real ruler gesture moved the playhead from frame 0 to frame 90 and the
   decoded blue frame rendered in Preview.
5. Playback advanced the playhead and exposed an active audio schedule with 39
   nodes and `scheduledThroughTimelineTime: 3.75`.
6. An active export was cancelled and reached its terminal cancelled state;
   retry then reached `Download MP4`.
7. Each downloaded file was 121,427 bytes. `ffprobe` reported a 4.666667 s MP4
   containing 1280 x 720 H.264 at 30 fps and 48 kHz stereo AAC.
8. Both runs ended with no warning/error console entry and no page error.

Edge is Chromium-based, so this is a genuine second-browser product gate but
not independent rendering-engine coverage. Firefox and Safari/WebKit remain
untested.

## Validation

- Focused Issue #19 tests: 346/346 passed across 16 files.
- Full Vitest suite: 1,127/1,127 passed across 64 files.
- TypeScript and production Vite build: passed; the existing three chunks over
  500 kB remain a documented warning.
- Lint: passed with zero diagnostics.
- Production dependency audit: zero vulnerabilities.
- `git diff --check`: passed.

## Distribution boundary

The decoder packages are exact-version and lockfile-integrity pinned, fallback
code is lazy and locally bundled, and Myrelith does not download executable
decoder code at runtime. Cross-origin isolation is not required for correctness
with the selected fallbacks.

This is still not a public-distribution compliance conclusion. Before a public
release claim, Myrelith needs:

- a project license;
- third-party notices and MPL source-availability links;
- exact FFmpeg source/build provenance plus LGPL static-link/relink review for
  the inlined AC-3 WASM;
- Dolby Digital/Plus licensing-scope review; and
- representative low-memory testing.

The optional proxy section remains deliberately incomplete: no proxy consent,
progress/storage lifecycle, or original/proxy provenance model ships. See
[the measured no-go decision](ISSUE_19_PROXY_CONVERSION.md).
