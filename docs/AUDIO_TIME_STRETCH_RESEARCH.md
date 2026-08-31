# Pitch-preserving audio time stretch

Issue: [#188](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/188)
Date: 2026-08-26
Status: research complete; constant 0.25x–4x stretch merged through PR #213 as `c846555`. The final ramp implementation extends that same bounded WSOLA and is specified by [issue188/RAMP_DESIGN.md](issue188/RAMP_DESIGN.md).

## Decision summary

| Track | Decision | Boundary |
|---|---|---|
| Shared live/export membership | Go | Extend `createTimelineAudioMixPlan`. One contributor list. Exact 1x stays a plan object with no stretch field. |
| Constant 0.25x–4x stretch | Go, bounded | First-party TypeScript WSOLA in `pipeline/audioStretch.ts`. Same session API for preview and export. |
| All-constant speed curve | Go | A curve whose every point is the same canonical non-unity rate is constant stretch, not a ramp mute. |
| 0x freeze | Go, explicit silence | Held 0x intervals fade to exact silence. A fully frozen window opens no decoder or stretch session. No held tone. |
| Variable-rate ramp | Go, bounded | Every grain derives its source position from the canonical `SourceTimeMap`; live and export call the same session implementation. |
| Sub-frame 1x origin | Mute | Named reason `sub-frame-origin-audio-unsupported`. Stretch maps may start on a tick. Direct 1x readers stay on whole frames. |
| Rubber Band | No-go | GPL-2-or-later, or a paid commercial grant. Either one forces a product-wide license change. |
| SoundTouchJS | No-go for this slice | MPL-2.0 is compatible. Its documented live tempo path mirrors source `playbackRate`. A new DSP dependency is unnecessary once WSOLA is first-party. |
| Signalsmith Stretch | No-go for this slice | MIT, but a WASM or C++ port is new provenance work. Author quality band is about 0.75x–1.5x. Issue #19 already rejected an unbounded local WASM proxy. |
| Preview-only `playbackRate` | No-go | Forbidden by the issue. Preview and export would disagree. |

Portable schemas do not change. `SourceTimeMap` already stores the rates this slice will play.

Constant-rate implementation contract: [issue188/DESIGN.md](issue188/DESIGN.md).
Ramp completion contract: [issue188/RAMP_DESIGN.md](issue188/RAMP_DESIGN.md).
Arena record: [issue188/SYNTHESIS.md](issue188/SYNTHESIS.md).

## Evidence basis

The pre-#188 fail-closed mute was intentional. The completed policy now admits exact integer-origin 1x direct audio, constant stretch, and validated variable ramps. `createTimelineAudioMixPlan()` emits one cloned, bounded ramp descriptor; live (`src/pipeline/playback-audio.ts`) and export (`src/pipeline/export-audio.ts`) consume that same plan and `createRampedAudioStretcher()`. Web Audio still has no clip `playbackRate`; the browser cannot create a divergent shortcut.

Kdenlive's pitch compensation is Rubber Band through MLT ([Kdenlive audio tools](https://docs.kdenlive.org/en/effects_and_filters/audio.html), [pitch and time](https://docs.kdenlive.org/en/effects_and_filters/audio_effects/pitch_and_time/index.html)). Shotcut lists pitch compensation for speed changes on its [feature list](https://shotcut.org/features/). Those products can take GPL. Myrelith cannot. The repo license is MIT (`LICENSE`). Runtime JavaScript today is MIT or MPL-2.0 (`THIRD_PARTY_NOTICES.md`).

Rubber Band Library is dual-licensed GPL-2-or-later or commercial ([license](https://breakfastquay.com/rubberband/license.html)). Shipping the GPL edition would require relicensing Myrelith. A paid grant is a distribution decision this slice does not make.

SoundTouchJS `@soundtouchjs/core` 2.1.1 is MPL-2.0 and can process offline PCM. Its AudioWorklet package documents tempo as a mirrored source `playbackRate` with pitch correction ([package readme](https://www.npmjs.com/package/@soundtouchjs/audio-worklet)). That shortcut is exactly the preview-only path the issue forbids. Using only the core package is legal. It still adds a DSP dependency this slice can avoid.

Signalsmith Stretch is MIT C++ ([project page](https://signalsmith-audio.co.uk/code/stretch/), [design notes](https://signalsmith-audio.co.uk/writing/2023/stretch-design/)). The author states time-stretch quality is best between about 0.75x and 1.5x. 0.25x and 4x sit outside that band. A browser port would be new WASM provenance. Issue #19 slice 6 already failed bounded I/O, progress, license, provenance, and low-memory gates for a local WASM proxy.

WSOLA (waveform similarity overlap-add) is the time-domain method SoundTouch uses. Verhelst and Roelands, 1993, *An overlap-add technique based on waveform similarity (WSOLA) for high quality time-scale modification of speech*, ICASSP. Mozilla still ships a SoundTouch-derived WSOLA (`TDStretch`) in Firefox. The algorithm is classical, explainable, and implementable in TypeScript without a third-party binary.

## Selected algorithm

First-party stereo WSOLA in `pipeline/audioStretch.ts`.

- Constant tempo comes from the branded `SourceTimeRate`. Ramp grain positions
  come from exact source-tick anchors at adjacent document frames with
  sample-local interpolation. Pitch stays 1.
- Window 21 + 1/3 ms Hann. Output hop 5 + 1/3 ms. Search ±10 + 2/3 ms.
- At 48 kHz that is 1024 / 256 / ±512. Hop snaps so `outputHop * numerator / denominator` is an integer for every 25% step.
- Search uses AMDF on the mid mix. Lowest offset wins a tie. The same lag is applied to left and right.
- Fold-down stays `domain/audioChannelMix.ts` before the session sees PCM.
- Live and export rechunk folded source to 4,096 stereo frames, then pull the same session type.
- Exact 1x never constructs a session.
- Held 0x intervals receive a 3 ms boundary fade and exact interior silence.
  A window that is entirely frozen constructs neither a decoder nor a session.

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
| Persistent WSOLA arrays | 60,416 bytes (~59 KiB) at 48 kHz; 120,832 bytes (~118 KiB) at 96 kHz | Both source planes, Hann, three overlap rings, reference/index, and both search planes per session |
| Concurrent sessions | 8 | Crowded timelines stay finite |
| Working set | 5 MiB/session; 40 MiB aggregate | Code-derived maximum covers 4× input/output planes, 4,096-frame rechunk, and persistent WSOLA arrays at the 96,000-sample pull cap, with descriptor/bookkeeping headroom |
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
| Ready, ramped, nominal | Positive variable curve with endpoints inside 0.75x–1.5x |
| Fallback, ramped, edge | A positive edge rate or authored 0x hold; positive regions still play |
| Silence, invalid curve | Stored curve fails validation |
| Silence, sub-frame 1x | Unity rate, origin not on a whole frame |

Volume 0 and `audio.enabled === false` stay ordinary omits. They are not retiming silence.

## Out of scope

- AI voice conversion, formant editing, source separation, cloud processing.
- Arbitrary rates outside the 25% vocabulary.
- Reverse playback. Negative rates are not representable.
- A preview-only `playbackRate` shortcut.
- Held-tone freeze.
- Schema changes.

## Completion gate

The final gate covers exact 1x and constant-regression behavior, slow/fast ramps,
pull-partition identity, exact sample totals, 0x boundaries, mid-ramp seeks,
live/export host parity, eight-session admission, cancellation/teardown, project
replacement, all-1x sub-frame rejection, decoder-free/offline whole freezes,
29.97 fps absolute-sample parity, export/reopen A/V duration, and decoded real
Chromium speech/music pitch energy.
