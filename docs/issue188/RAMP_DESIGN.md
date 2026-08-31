# Issue 188 ramped-audio design

Date: 2026-08-31
Status: implemented and validated locally; publication is tracked on Issue #188

This is the remaining ramp slice after the constant-rate WSOLA implementation
merged through PR #213. The existing exact 1x direct path and constant-rate
0.25x-4x path are compatibility boundaries and do not change.

## Decision

Extend the first-party MIT WSOLA session in `pipeline/audioStretch.ts` with one
variable-rate mode. Live playback and export consume the same immutable ramp
descriptor and the same session implementation. No `AudioBufferSourceNode`
`playbackRate`, AudioWorklet-only path, third-party package, WASM payload, or
second contributor plan is introduced.

The ramp descriptor is compact and bounded. It owns a validated clone of the
existing `SourceTimeMap`, the exact planned source-tick window, and merged 0x
hold intervals intersected with that window. A map has at most 256 authored
speed points, so neither the descriptor nor its silence policy grows with clip
duration. Hosts continue to decode, fold down, rechunk, cancel, and release
resources below React and Zustand.

## Mapping and boundary policy

- The scheduled timeline sample count remains owned by the existing live and
  export hosts. Every pull returns exactly the requested count; no ramp boundary
  can insert or remove a scheduled sample.
- For each WSOLA grain, the session finds the containing document frame on the
  exact integer audio grid. It evaluates the canonical `SourceTimeMap` at that
  frame and the next frame, converts both exact tick anchors to source samples,
  then interpolates only inside that one sample interval.
- Grain source positions are therefore re-anchored to the canonical map instead
  of accumulating an instantaneous floating-point rate. Hold, linear, smooth,
  split, trim, and crossfade-handle windows retain the same integer boundary
  decisions as video and export planning.
- The ordinary Hann overlap-add tail continues across positive-rate ramp
  boundaries. AMDF still searches the mid signal with the same lag in both
  ears, so channel phase remains coherent.
- A true authored 0x hold interval emits silence. It never repeats a grain or
  synthesizes a held tone. A three-millisecond bounded linear fade on each
  audible side prevents a step click. Linear or smooth motion away from an
  instantaneous 0x point is still stretched; only a flat 0x hold span is
  silent.
- A contributor window that is entirely inside a 0x hold is marked `silent` in
  the plan and opens no media reader or WSOLA session.

## Capability and quality

Positive ramp rates use the existing authored 0.25x-4x endpoints. Interpolated
rates remain inside their adjacent endpoints. A ramp is `ready` when every
positive endpoint is inside the documented 0.75x-1.5x nominal band and it has
no freeze. It is a bounded `fallback` when any endpoint is at an edge rate or a
0x hold is present; it still plays, with freeze spans explicitly silent.

Invalid curves and sub-frame-origin all-1x maps remain intentionally silent.
Reverse maps are unsupported and unrepresentable by the schema's non-negative
rate vocabulary. Offline and decode failures remain live per-clip warnings with
silence, while export fails closed. Cancellation, seek/re-prime, project
replacement, and teardown close the stretcher beside its decoder cursor; close
is idempotent.

## Resource envelope

| Resource | Bound |
| --- | ---: |
| Authored ramp points | 256 |
| Derived 0x hold intervals | 256, merged and window-clipped |
| Output pull | 96,000 stereo samples |
| Decoder rechunk | 4,096 frames |
| Concurrent constant/ramp sessions | 8 |
| Stretch working allowance | 5 MiB/session; 40 MiB across eight sessions |
| Ramp boundary fade | 3 ms per audible side |
| Live lookahead | Existing 0.75 s |

The session retains only the existing WSOLA windows, overlap tail, search
scratch, one rechunked decoder block, and the bounded descriptor. Long freezes,
long projects, repeated seeks, and repeated exports do not allocate a
duration-sized rate table or output buffer.

## Acceptance proof

Focused tests must prove exact output counts across uneven pulls and every ramp
boundary, partition-independent PCM, live/export descriptor and algorithm
parity, click-bounded positive-rate transitions, exact freeze silence/fades,
constant/direct compatibility, the eight-session gate, decoder/session cleanup,
and long repeated seek/play/export stability. Chromium must cover speech and
music at slow, fast, positive ramp, and freeze-ramp settings; export/reopen and
A/V duration; cancellation; repeated lifecycle cleanup; and a clean console.

Local completion evidence: 259 Vitest files / 3,702 tests, 17 repository runner
checks, production build/typecheck, oxlint, zero production vulnerabilities,
and 15 headed Chromium tests. The Issue #188 browser case generated speech and
music WAVs, exercised constant slow/fast plus positive/freeze ramps, #189 audio
automation/effects, #190 adjustment intent, six playback owners, exact 29.97
fps / 48,048-sample A/V export/reopen, decoded authored pitch bands, sample-
exact freeze silence, cancellation, zero settled resources, and a clean console.
Export's whole-freeze preflight uses one lazy O(n log n) structural crossfade
index with per-track clip lookups. It resolves descriptor-backed source
capacity before cross-track conflicts, while immutable descriptor bounds remain
available independently of connected Blob ownership; an unavailable transition
or offline silent leg therefore cannot erase its connected partner's valid
handle fade. A 100,000-clip ambiguous-link regression locks the scaling bound.
The resource regression derives maximum typed-array use from the 4× rate,
96,000-sample pull, 4,096-frame rechunk, and 96 kHz WSOLA constants; it remains
below the enforced 5 MiB/session and 40 MiB/eight-session allowances.
