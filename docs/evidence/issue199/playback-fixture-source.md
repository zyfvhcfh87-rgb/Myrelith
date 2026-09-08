# Issue 199 — local PCM and canonical UI relink setup

Source-only checkpoint following the retained third gestures attempt at
`02130339af0d033761a3fd591a3cc19d7f609bdb`. Product source remains
`75b89ef6b70460a03ea99ca44d888b5ec06373ec`, with all 242 frozen hashes verified.
**Root review and a new explicit gestures grant are required. No native run was
performed for this correction.**

## Problem and correction

The previous attempt passed 11 checkpoints, including the mode fix, then failed
the strict console gate after actual playback cancellation assertions completed.
`ordinary-audio` referenced offline `audio-asset`. Its warning and every prior
failed run remain preserved; they are not playback acceptance.

Canonical `descriptorMatches` requires exact file byte size. The original
descriptor's `size: 1` cannot match a valid 30-second WAV. The authorized fixture
correction therefore adds a separate `fixtures/playback/mixed-playback.myrelith`:
only `audio-asset.size` changes to 5,760,044. Restoring that field gives exact full
portable equality with the original. No timeline, clip, animation, gain, enabled
or mute setting changes. The original four portable files and generation
manifests retain their bytes and provenance.

The new generator writes a deterministic RIFF/WAVE file: 48 kHz, stereo,
16-bit signed little-endian PCM, 30 seconds, 1,440,000 sample frames, 44 header
bytes and 5,760,000 data bytes. It contains a non-silent integer 250 Hz triangle,
peak 1536/32768, with opposite stereo channels. The exact sample formula is
recorded in the generator and playback manifest. Browser `--mute-audio` remains
the output control; the original audio clip remains enabled at its original gain.

| New file | Bytes | SHA-256 |
| --- | ---: | --- |
| `silent-offline.wav` | 5,760,044 | `f674326cc658930dc9eb01b1388aca7e7f9a0e7bedc3fb58b49803f01a133859` |
| `mixed-playback.myrelith` | 13,385 | `8a067088cd5c007ea701d3af702626dc15aa880086e359a56c1629868dc8ae6b` |

## Actual UI versus canonical API setup

Only the gestures segment selects the supplemental project. It uses the existing
Open UI, then `setInputFiles` on the audio row's actual Relink-once input.
`MediaPool.tsx` calls `connectActiveAssetMedia`; the existing coordinator performs
browser media inspection, exact descriptor matching, and canonical connection
under the same `audio-asset` id. No direct media/document store mutation or
injected relink API replaces this flow. Supplying a file through browser automation
does not qualify a native OS file picker.

The setup requires an online row, one connected source, exact audio metadata and
source extent, a local Blob URL, the original enabled clip/gain, zero history,
and unchanged project/history/clipboard references across relink. These checks
precede all gesture checkpoints. Media metadata may canonically upgrade unknown
source bounds to the analyzed exact extent; this is not a timeline edit.

The new setup has **not yet run in Chromium**. Native compatibility, relink,
waveform work and actual playback must still satisfy the unchanged strict console
and page-error policy. Play/Pause actions, the complete cancellation matrix and
all immutable-reference assertions are byte-identical to the accepted harness.
Editing/large actions and their original fixture setup are unchanged. Final
project departure reopens the original two-offline project; no playback follows.

## Offline dependency review

The canonical complete project audio mix plans contain exactly:

| Sequence | Audio clip/source | Timeline interval |
| --- | --- | --- |
| root | `ordinary-audio` / `audio-asset` | [0, 60) |
| dormant | none | — |

Both title clips are procedural. The only other offline descriptor is
`fixture.mp4`, with `hasAudio: false`; its video clip occupies [120, 180).
Every cancellation playback case starts at frame 1. The existing preview
controller's `desiredVideoSourceKey` returns null for an absent original source,
so it skips loading that offline video. If the later interval is reached, preview
records offline visual status; ordinary unavailable frame images are reported as
missing by the existing compositor. No additional audio source can reach the
resolver in the canonical plan. The strict console gate will still stop on any
unexpected native warning; this source audit is not a new preview/playback pass.

Source references: `src/app/projectMediaMatching.ts`,
`src/app/activeMediaRelinkCoordinator.ts`, `src/ui/MediaPool.tsx`,
`src/domain/projectAudioMixPlan.ts`, `src/domain/selectors.ts`,
`src/app/previewController.ts`, and `src/pipeline/render.ts` at the pinned product.

## Verification and provenance

`playback-fixture/verification.json` records all 242 product hashes, the previous
44 checkpoint files (only protocol and observation setup changed), exact equality
of all other observation code and both runners, and identical hashes after a
second deterministic generation. The prior checkpoint manifest is preserved in
`playback-fixture/previous-checkpoint-hashes.json` before repinning.

The generator uses the real canonical parser/serializer, descriptor matching and
audio planner through a non-listening Vite SSR host. Canonical parse/serialize is
exact; the original size is rejected and the corrected supplemental metadata
matches. Mediabunny 1.50.9 independently demuxes metadata from the WAV. Python's
standard-library `wave` and `array` validate every PCM sample, non-silence, range,
channel opposition and hashes. These are host fixture checks, not browser
compatibility, native decoding, PCM output or export acceptance.

Syntax checks, repository lint and explicit lint of all three changed/new scripts
pass. Product/configuration source is unchanged; no new production build or full
suite was run for this harness/fixture-only checkpoint. The generation and lint
logs are normalized copies; their raw originals remain in `.tmp/issue199/`.
The three failed gestures directories and earlier accepted evidence are untouched.

Reproduce fixture preparation only from this owned worktree:

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
export NODE_OPTIONS=--no-experimental-webstorage
node scripts/issue199/prepare-playback-fixture.mjs
```

This command opens no browser, listening server or audio device. It grants no
continuation, editing/large run, performance run, export, full suite or Gate 3 pass.
