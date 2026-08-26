# Rationale. Mix-plan stretch contributors

## Problem

Constant non-1x speed already has a rational map and a video path. Audio still drops those clips from `createTimelineAudioMixPlan` because `sourceTimeAudioPolicy` treats anything but integer-origin 1x as mute. Live and export both read `.clips` only, so the mute is total. Rubber Band is GPL. SoundTouch's live path is `playbackRate`. Signalsmith wants a WASM port this repo already refused. The non-obvious part is admitting 0.25x to 4x audio without a second plan, without a 1x tax, and without leaking WSOLA into domain types.

Constraints from Phase A stay in force. One plan and one algorithm for preview and export. 0x and ramps stay silent with reasons. Exact 1x must not construct a descriptor or call stretch. Domain stays pure. UI never imports pipeline.

## Usage (caller's view)

The consumer is the engineer changing four existing sites, not a new package user.

`createTimelineAudioMixPlan` still returns `{ clips, mutedClips }`. A 2x clip is now in `clips` with a `stretch` field. A 1x clip is the object already tested in `audioMixPlan.test.ts`, still without that field. Playback and export branch once with `isStretchedAudioClipPlan`. The 1x branch is the current function body. The stretch branch creates `createConstantRateAudioStretcher` and schedules or mixes the returned stereo PCM as if it were 1x timeline audio. Inspector Timing and Audio both print `clipAudioPresentation(clip)`. They do not invent a second policy.

That usage is the spec. The union, the factory, and the session exist because those call sites need them. Nothing else is public.

## Shape

Data first, before the WSOLA loop. Policy is a three-way sum. `supported/direct`, `supported/stretched` plus a canonical rate, or `muted` plus a reason. `constant-speed-audio-unsupported` goes away because that state is now a contributor. 0x holds and ramps stay muted, with separate reasons so the Inspector can tell a freeze from a curve. per foundational-thinking, per model-the-domain, per type-system-discipline.

The mix plan is the same module it is today. A contributor is either today's field list with `stretch?: never`, or that list plus a required `ConstantRateAudioStretch`. 1x bypass is the type. A direct plan cannot carry hops or ticks. A stretched plan cannot forget the rate. per encode-lessons-in-structure.

`createConstantRateAudioStretch` is the domain boundary. It rejects unity, zero, and unordered ticks. `createConstantRateAudioStretcher` is the pipeline boundary. It rejects bad sample rates and oversized pulls, then trusts the descriptor. The WSOLA loop does not re-check. per boundary-discipline.

The descriptor holds only rate and the planned source tick window. Window, hop, search, AMDF, and mid-channel linking live in `pipeline/audioStretch.ts`. Callers never pass those. That is the depth test. One session type, one `pull`, one `close`. Live and export each own a session. They do not share scratch. per separate-before-serializing-shared-state.

I put the algorithm in pipeline, not domain, because the assigned shape says the same pipeline stretcher, and because a domain wrapper that only forwards PCM would be a pass-through. Playback's `AudioBuffer` conversion stays private to `playback-audio.ts`. Domain types name no Web Audio and no WASM.

Crossfade handles use tick mapping on the stretched branch and today's phase math on the direct branch. If stretch had been here on day one, a 2x outgoing handle would consume source at 2x. Keeping `retimed-audio-unsupported` for stretched partners would have been a bolt-on mute. per redesign-from-first-principles.

I did not add a `createAudioStretchPlan`. Two plans would let live and export pick different membership. The smallest change that matches the product is one more variant on the plan that already has one live caller and one export caller. per laziness-protocol, per subtract-before-you-add.

Call chain for audible 2x audio is mix plan, stretcher, host. Three files. Inspector is policy plus copy. per minimize-reader-load, per laziness-protocol.

Quality and memory are constants on the stretcher, not comments on the plan. Nominal is 0.75x to 1.5x. Edge still plays and shows `fallback`. Pulls cap at 96_000 output samples so a caller cannot stretch a whole feature. A new session from clip start plus the same pulls is bit-identical. Live remake on re-prime is the existing idempotent restart. Mid-clip live start does not replay from zero, so grain alignment can differ from export. Duration does not. per make-operations-idempotent.

Timing and Audio both print `clipAudioPresentation`. An editor who opened the volume pane should not have to guess why a 50% clip is quiet or grainy. per experience-first.

The public types hide hop math, search, overlap-add, lead samples, and fold-down order. They expose membership, rate, tick window, and a session that emits timeline PCM. That is as wide as the call sites. A richer options bag would teach callers WSOLA.

Red-flag screen before synthesis.

- Shallow module. Rejected a hop/window/search options object and a four-function "prepare / analyze / overlap / emit" API. The session is the deep module.
- Information leakage. Rejected putting `AudioBuffer` or WSOLA constants on `TimelineAudioClipPlan`. Rate is `SourceTimeRate` because that type already is the document.
- Temporal decomposition. Rejected `loadAudio` / `validateStretch` / `stretchAudio` / `mixAudio` files that would repeat the same clip fields.
- Pass-through. Rejected `pipeline/stretch-adapter.ts` and a domain `stretchIfNeeded` that only forwards.

## Synthesis decision

Pending arena pick.

## Tradeoffs accepted

- We accept WSOLA grain and slap at 0.25x and 4x in exchange for one MIT algorithm that covers the whole Inspector step list without a GPL or WASM dependency.
- We accept a mid-clip live start that does not match export grain-for-grain in exchange for not warming every stretched clip from frame 0 on play.
- We accept muting a whole clip that contains a freeze or any non-1x curve in exchange for not inventing variable-rate stretch in this slice.
- We accept a 1x sub-frame map staying silent in exchange for leaving the current 1x readers on integer frames. Stretch maps may start on a tick because they already carry ticks.
- We accept a `kind` field on every `supported` policy in exchange for not using an optional-field bag that would let `stretched` compile without a rate.
- We accept rewriting exact-object mix-plan tests that currently expect a 2x clip in `mutedClips` in exchange for the planner becoming the source of truth for stretch membership.

## Alternatives considered

- A second stretch plan next to `TimelineAudioMixPlan`. Callers would join two lists and could disagree on who is audible. Deeper for the planner, shallower and more dangerous for playback and export. Lost on interface depth.
- Web Audio `playbackRate` in live and WSOLA in export. Tiny live interface, forbidden by the issue, and it would teach the next editor that preview is not export.
- Rubber Band or SoundTouchJS. They hide more DSP, and they put GPL or a live `playbackRate` shortcut on the public product. Lost on license and on the shared-algorithm rule.
- Stateless per-block WSOLA with no session. The function looks smaller. Callers then have to feed lookback and hop phase, which leaks the implementation and clicks at 1024-sample export edges.

## Open questions and risks

- If edge-rate dialogue is worse than silence in the first dogfood pass, do we keep playing it with the `fallback` copy, or do we mute 0.25x and 4x behind a new reason without changing the session type?
- When ramp work starts, should a freeze-plus-1x curve play the 1x shoulders, or is whole-clip silence still the rule until variable stretch exists?
- AMDF is the first `pull` body. If speech at 0.5x is thin, can normalized correlation replace AMDF inside the session without a plan change? I believe yes. Confirm on a recorded line before treating AMDF as sacred.

## Next implementation step

Change `SourceTimeAudioPolicy` and its tests so a 1.5x map is `{ status: 'supported', kind: 'stretched', rate: { 3, 2 } }`, then make `createTimelineAudioMixPlan` emit that clip with a descriptor and keep the 1x fixture byte-equal.
