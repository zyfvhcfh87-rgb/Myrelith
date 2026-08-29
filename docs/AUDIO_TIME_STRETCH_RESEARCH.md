# Pitch-preserving audio time stretch

Issue: [#188](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/188)
Date: 2026-08-26
Status: research complete; constant 0.25x–4x stretch is wired in this worktree. Ramps and freezes still mute.

## Decision summary

| Track | Decision | Boundary |
|---|---|---|
| Shared live/export membership | Go | Extend `createTimelineAudioMixPlan`. One contributor list. Exact 1x stays a plan object with no stretch field. |
| Constant 0.25x–4x stretch | Go, bounded | First-party TypeScript WSOLA in `pipeline/audioStretch.ts`. Same session API for preview and export. |
| All-constant speed curve | Go | A curve whose every point is the same canonical non-unity rate is constant stretch, not a ramp mute. |
| 0x freeze | Silence | Named reason `freeze-audio-silence`. No held tone. No unbounded synthesis. |
| Variable-rate ramp | Mute | Named reason `speed-ramp-audio-unsupported` until a later slice. |
| Sub-frame 1x origin | Mute | Named reason `sub-frame-origin-audio-unsupported`. Stretch maps may start on a tick. Direct 1x readers stay on whole frames. |
| Rubber Band | No-go | GPL-2-or-later, or a paid commercial grant. Either one forces a product-wide license change. |
| SoundTouchJS | No-go for this slice | MPL-2.0 is compatible. Its documented live tempo path mirrors source `playbackRate`. A new DSP dependency is unnecessary once WSOLA is first-party. |
| Signalsmith Stretch | No-go for this slice | MIT, but a WASM or C++ port is new provenance work. Author quality band is about 0.75x–1.5x. Issue #19 already rejected an unbounded local WASM proxy. |
| Preview-only `playbackRate` | No-go | Forbidden by the issue. Preview and export would disagree. |

Portable schemas do not change. `SourceTimeMap` already stores the rates this slice will play.

Implementation contract: [issue188/DESIGN.md](issue188/DESIGN.md).
Arena record: [issue188/SYNTHESIS.md](issue188/SYNTHESIS.md).

## Evidence basis

Today's fail-closed mute is intentional. `sourceTimeAudioPolicy()` in `src/domain/sourceTimeMap.ts` supports only an exact integer-origin 1x map, including an all-1x curve. `createTimelineAudioMixPlan()` omits the rest. Live (`src/pipeline/playback-audio.ts`) and export (`src/pipeline/export-audio.ts`) consume `.clips` only. Web Audio calls `AudioBufferSourceNode.start(when, offset, duration)` with no clip `playbackRate`. `ARCHITECTURE.md` forbids approximating stretch with divergent browser rate nodes.

Kdenlive's pitch compensation is Rubber Band through MLT ([Kdenlive audio tools](https://docs.kdenlive.org/en/effects_and_filters/audio.html), [pitch and time](https://docs.kdenlive.org/en/effects_and_filters/audio_effects/pitch_and_time/index.html)). Shotcut lists pitch compensation for speed changes on its [feature list](https://shotcut.org/features/). Those products can take GPL. Myrelith cannot. The repo license is MIT (`LICENSE`). Runtime JavaScript today is MIT or MPL-2.0 (`THIRD_PARTY_NOTICES.md`).

Rubber Band Library is dual-licensed GPL-2-or-later or commercial ([license](https://breakfastquay.com/rubberband/license.html)). Shipping the GPL edition would require relicensing Myrelith. A paid grant is a distribution decision this slice does not make.

SoundTouchJS `@soundtouchjs/core` 2.1.1 is MPL-2.0 and can process offline PCM. Its AudioWorklet package documents tempo as a mirrored source `playbackRate` with pitch correction ([package readme](https://www.npmjs.com/package/@soundtouchjs/audio-worklet)). That shortcut is exactly the preview-only path the issue forbids. Using only the core package is legal. It still adds a DSP dependency this slice can avoid.

Signalsmith Stretch is MIT C++ ([project page](https://signalsmith-audio.co.uk/code/stretch/), [design notes](https://signalsmith-audio.co.uk/writing/2023/stretch-design/)). The author states time-stretch quality is best between about 0.75x and 1.5x. 0.25x and 4x sit outside that band. A browser port would be new WASM provenance. Issue #19 slice 6 already failed bounded I/O, progress, license, provenance, and low-memory gates for a local WASM proxy.

WSOLA (waveform similarity overlap-add) is the time-domain method SoundTouch uses. Verhelst and Roelands, 1993, *An overlap-add technique based on waveform similarity (WSOLA) for high quality time-scale modification of speech*, ICASSP. Mozilla still ships a SoundTouch-derived WSOLA (`TDStretch`) in Firefox. The algorithm is classical, explainable, and implementable in TypeScript without a third-party binary.

## Selected algorithm

First-party stereo WSOLA in `pipeline/audioStretch.ts`.

- Tempo comes from the branded constant `SourceTimeRate`. Pitch stays 1.
- Window 21 + 1/3 ms Hann. Output hop 5 + 1/3 ms. Search ±10 + 2/3 ms.
- At 48 kHz that is 1024 / 256 / ±512. Hop snaps so `outputHop * numerator / denominator` is an integer for every 25% step.
- Search uses AMDF on the mid mix. Lowest offset wins a tie. The same lag is applied to left and right.
- Fold-down stays `domain/audioChannelMix.ts` before the session sees PCM.
- Live and export rechunk folded source to 4,096 stereo frames, then pull the same session type.
- Exact 1x never constructs a session.

Nominal quality is 0.75x to 1.5x. Edge rates still play and surface `fallback` copy. Grain or slap at 0.25x and 4x is accepted. Formant correction is out.

## License and distribution

The stretcher is original TypeScript in this repository under the existing MIT `LICENSE`. No new npm dependency. `THIRD_PARTY_NOTICES.md` does not change for this slice. No GPL runtime. No paid Rubber Band grant. No WASM payload.

Cite Verhelst and Roelands 1993 in the stretcher file header as the method, not as vendored source.

## Reviewed resource envelope

| Resource | Limit | Rationale |
|---|---:|---|
| Algorithm | First-party WSOLA | MIT, no binary, shared live/export PCM contract |
| Rates | 0.25x–4x, 25% steps, not 1x | Existing Inspector vocabulary |
| Channels | 2 after fold-down | Matches today's mix |
| Sample rates | 44.1 / 48 / 96 kHz | Document audio catalog |
| Output pull | 96,000 samples | Stops a caller stretching a whole feature in one call |
| Rechunk | 4,096 stereo frames | Decoder packet boundaries cannot pick different grains |
| Lookback | ~32 ms at 48 kHz | One window plus search. Not added to the audio clock |
| Live lookahead | 0.75 s existing pump | Stretch is not a clock |
| Worst extra decode | ~3.1 s | 4x × 0.75 s plus lead |
| Scratch | ~30 KiB at 48 kHz, ~60 KiB at 96 kHz | One stereo workspace per session |
| Concurrent sessions | 8 | Crowded timelines stay finite |
| Working set | 8 MiB | 8 × 1 MiB session allowance |
| Determinism | No RNG | Same start, pulls, and source bytes → same bytes |
| Parity | Byte-equal live/export PCM before gain | Shared algorithm, not a similar one |

Cancel, seek teardown, and project replacement close the session next to the decoder cursor. A second `close` is a no-op.

## Status surface

`clipAudioPresentation` is the one Inspector line.

| State | When |
|---|---|
| Ready, direct | Exact integer-origin 1x |
| Ready, stretched, nominal | Constant 0.75x–1.5x except 1x |
| Fallback, stretched, edge | Constant 0.25x, 0.50x, or 1.75x–4x. Still audible |
| Silence, invalid curve | Stored curve fails validation |
| Silence, ramp | Two different positive rates |
| Silence, freeze | Any 0x point |
| Silence, sub-frame 1x | Unity rate, origin not on a whole frame |

Volume 0 and `audio.enabled === false` stay ordinary omits. They are not retiming silence.

## Out of scope

- AI voice conversion, formant editing, source separation, cloud processing.
- Arbitrary rates outside the 25% vocabulary.
- Reverse playback. Negative rates are not representable.
- A preview-only `playbackRate` shortcut.
- Held-tone freeze.
- Schema changes.

## Next implementation step

Change `SourceTimeAudioPolicy` and its tests so a 1.5x map is `{ status: 'supported', kind: 'stretched', rate }` and a 1x fixture stays byte-equal. Then emit a descriptor from `createTimelineAudioMixPlan`. Then fill `pipeline/audioStretch.ts`. Then wire playback and export to the same session. Then Chromium speech, music, slow, fast, export reopen, cancel, and memory gates.
