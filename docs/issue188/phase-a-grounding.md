# Issue 188 Phase A grounding

Read-only notes for design sketches. Product code is unchanged.

Issue: https://github.com/zyfvhcfh87-rgb/Myrelith/issues/188
Repo: `C:\Users\Aryel\.cursor\worktrees\WebCut\7xgb`
License: MIT (`LICENSE`). Third-party runtime deps today are MIT or MPL-2.0 (`THIRD_PARTY_NOTICES.md`).

## Problem

Non-1x constant speed, ramps, and freezes mute audio in preview and export because no pitch-safe shared algorithm exists. Video already remaps through `SourceTimeMap`. Editors lose dialogue, music, and montage audio on common speed edits.

## Current architecture (from how)

- `sourceTimeAudioPolicy()` in `src/domain/sourceTimeMap.ts` is the only classification. Supported means exact integer-origin 1x, including an all-1x speed curve. Otherwise muted.
- Mute reasons: `invalid-speed-curve`, `constant-speed-audio-unsupported`, `speed-ramp-audio-unsupported`.
- `createTimelineAudioMixPlan()` in `src/domain/audioMixPlan.ts` records muted clips and omits them from `clips`. Contributor plans store 1x integer timeline/source windows, volume, balance, fades, envelopes. No rate, ticks, or stretch field.
- Live (`src/pipeline/playback-audio.ts`) and export (`src/pipeline/export-audio.ts`) consume `.clips` only. They never read `mutedClips`.
- Live schedules `AudioBufferSourceNode.start(when, offset, duration)` only. No clip `playbackRate`.
- Export writes timeline-length zeros when no contributor is active. `hasAudio` stays true if any audio-track clip exists.
- `outputMediaAssetIds()` excludes muted-retimed audio from Blob/offline requirements. Video on the same asset stays required.
- Inspector Timing restates policy. Audio Inspector does not.
- Crossfade audio is unavailable when either linked partner is policy-muted (`retimed-audio-unsupported`).
- Invalid curves fall back visually to constant rate and still mute audio.
- Sub-frame `sourceStartTicks` mutes even at 1x.
- Reverse rates are not representable.

## Issue constraints (binding)

- One canonical plan and algorithm for live and export. No preview-only `playbackRate`.
- Research and document algorithm plus license/distribution before product integration.
- First product slice: existing 0.25x–4x rational constant-rate vocabulary. Ramps only after that gate.
- 0x freeze: explicit silence/hold. Never fabricate stretched media indefinitely.
- Preserve scheduled presentation duration, volume/balance, fades, fold-down, audio-master clock.
- Source decode, work buffers, cancel, teardown stay outside React/Zustand and below reviewed ceilings.
- Surface ready / bounded fallback / intentional silence with a reason.
- Exact 1x stays the current path and must not pay stretch overhead.
- Offline, decode failure, cancel, project replacement stay explicit and cleaned up.
- Local-first. No cloud. No AI voice, formant editing, or source separation.
- Layering: `ui/` → `state/` → `domain/`. `engine/`, `pipeline/`, `workers/` → `domain/` only. UI never imports pipeline.

## License facts already gathered

- Rubber Band Library is GPL-2+ with a paid commercial option. Shipping it would force Myrelith off MIT or require a purchased grant. Treat as no-go unless the design explicitly proposes a license change.
- SoundTouchJS (`@soundtouchjs/*`) is MPL-2.0, same family as Mediabunny. Its recommended live tempo path mirrors source `playbackRate` and pitch-corrects. That live shortcut is forbidden here. Export must use the same algorithm.
- Signalsmith Stretch is MIT C++. Author notes time-stretch quality is best between about 0.75x and 1.5x. 0.25x and 4x are outside that comfort band. WASM/native port would be new provenance work.
- A first-party WSOLA in TypeScript would add no third-party stretch license. Quality and latency bounds must be declared, not hoped.

Issue #19 slice 6 already rejected an unbounded local WASM proxy on I/O, progress, license, provenance, and unproven low-memory behavior.

## First-slice success

A design package that a later implementer can fill in without inventing policy. Usage written first. Types make illegal states unrepresentable. 1x bypass is structural, not a comment. Constant-rate stretch is the implemented hole. Ramps, reverse, and 0x have explicit typed behavior.
