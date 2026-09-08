# Export parity failure: source-only diagnosis

The frozen export gate failed and remains incomplete. No tolerance has changed.
The saved evidence does not yet establish whether the maximum error comes from
the renderer, reference construction, decoded frame selection or lossy AVC.

## Confirmed from the existing bytes and code

Both immutable MP4 files contain 300 `avc1` samples, a media timescale of 30,
duration 300 ticks, and a single `stts` entry of 300 samples × 1 tick. Neither
has a composition-offset table or edit list. At frame 127 both presentation
timestamps are exactly 127/30 seconds, matching the requested timestamp in the
comparison. Adjacent frames 126/128 and planned frames 255/299 also align in
the container tables. This was byte-level box inspection; no new decoding ran.
The extracted fields are in [mp4-metadata.json](mp4-metadata.json).

The source's sync samples are every 30 frames; the export's are every 60 frames.
Those match the fixture's one-second and production profile's two-second key
intervals. Frame 127 follows the key sample at frame 120 in both files.

- `scripts/issue198/exportResourceGate.ts:181–207` requests both saved output and
  decoded original at `frame / 30`, then selects the static path with
  `Math.min(frame, 255) % 2`. At 127 that is the second, inset path. It applies
  the mask to decoded source RGB/alpha and rounds alpha multiplication over black.
- `src/pipeline/export.ts:337–354` uses integer output frames and derives each
  sink timestamp independently with `framesToSeconds`. The production source
  does the same for its `CanvasSink` requests in
  `src/pipeline/export-mediabunny-visual-source.ts:302–309`.
- Installed Mediabunny's `VideoSampleSink.getSample` is defined as the last
  presentation sample at or before the requested timestamp. Its MP4 demuxer
  rounds near-integer timestamp × timescale values before sample lookup. The
  decoded sample queue targets packet timestamps with a small epsilon. This
  inspection found no obvious container/timestamp rounding defect, but the run
  did not record actual returned decoded timestamps.
- The renderer fills the main composition over black (`src/pipeline/render.ts`),
  consistent with the reference's intended background. The accepted raster
  matrix established exact static-versus-held mask output, including the
  export fixture's shape/feather/resolution combination. That does not establish
  pixel equality across the entire canvas composition and encoding path.

Frame 0 had maximum RGB delta 12 and mean 0.20083767361. Frame 127 had maximum
19 and mean 0.06854926215 over 2,764,800 channels. A small mean with a larger
maximum is consistent with localized differences. It does not prove that the
differences are at the mask edge, nor that AVC is responsible. No coordinates,
decoded timestamps, raw comparison pixels or pre-encode frame were captured by
the original parity observer, so source inspection alone cannot settle cause.

## Separately authorized diagnostic preparation

The parent authorized preparation, but not execution, of one bounded diagnostic
using only these saved bytes:

- Source SHA-256: `55a7094a0d645e5ec67c7d266890d9c6c8500a125f3454408bdd467ef8ed6264`.
- Output SHA-256: `f31104bd0a9d26d8ae1285bd15798b625281f8222268c79a34d006481eba0f2c`.

The diagnostic must record six ordinal/sparse frame comparisons at
0/126/127/128/255/299, returned timestamps/durations and exact pixel hashes.
For frame 127 it must compare candidate held paths and neighboring source
frames, with error histograms, counts above 12, coordinates and separate opaque,
feather and outside-mask regions. It must also render exactly one unencoded
frame 127 through the actual production composite using the matching decoded
source, recording source ownership and canvas policy. That comparison belongs
in the first diagnostic to distinguish a pre-encode mismatch from differences
introduced later.

The executable diagnostic needs explicit total-work, artifact and time bounds,
durable partial results and owned cleanup before parent review and a new native
grant. It must not encode, export, generate another source video, mutate the
project, change the 12/2 acceptance limits or rerun the failed sequence. No
renderer, reference, canvas or codec cause is confirmed at this checkpoint.
