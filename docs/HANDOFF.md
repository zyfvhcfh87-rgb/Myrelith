# WebCut — Session Handoff

Read this first in a new session. It is the deep context; [PLAN.md](PLAN.md)
records the completed MVP roadmap and gates; [../ARCHITECTURE.md](../ARCHITECTURE.md)
holds the binding rules. Post-MVP work comes from explicitly selected issues
and the open list below.

## Status (2026-08-01)

| Phase | State | Proof |
|---|---|---|
| 0 — contracts & time math | ✅ done | drift-free NTSC round-trips |
| 1 — ops + undo/redo stores | ✅ done | 20-random-ops fuzz gate, 5 seeds |
| 2 — decode engine | ✅ done | user-verified: 1080p60 scrub, 0.1ms cache hits, zero leak warnings |
| 3.1–3.4 — layout/ruler/clips/preview | ✅ done | browser E2E: import → preview → scrub, 30↔60fps rescale exact |
| **3 gate** | ✅ closed | user manual pass 2026-07-06; sandbox deleted |
| 4.0 — media → timeline drag | ✅ done | browser E2E: drag asset row → clip on lane, kind-gated, 1 undo entry |
| 4.0.5 — transport bar (user request) | ✅ done | browser: ~30fps vs wall clock, pause freezes, ±1 steps, restart at end |
| 4.0.6 — 12h virtualized ruler (user request) | ✅ done | browser: 1.296M-px runway, 18–27 tick nodes at any scroll, end label flush right |
| 4.1a — compositor core (`compositeFrame`) | ✅ done | 12 unit tests: stack order, transform math, failure isolation, concurrent fetch |
| 4.1b — render worker (per-asset decoders) | ✅ done | 13 unit tests: double-buffer blit, latest-wins, PiP loan survival (mutation-tested), fault containment |
| 4.1c — render bridge + preview swap | ✅ done | browser E2E: 2-track PiP numerically exact, opacity/rotation blend, hidden toggle, 30fps playback, clean console |
| 4.2 — editing toolset (select/razor/trim/ripple/slip/slide) | ✅ done | browser E2E: 7 tool edits then 7 undos → byte-exact original layout |
| 4.3 — Inspector + arrow-key stepping | ✅ done | browser E2E: 5 field edits = 5 entries, live compositor render, exact undo restore, arrow clamps |
| 4.3.5 — timeline track headers (user request) | ✅ done | browser E2E: sticky gutter, add/hide/mute/lock wired, rows pixel-aligned, undo exact |
| 4.3.6 — track rename/delete/solo (user request) | ✅ done | browser E2E: dblclick-rename, × delete + undo-restores-clips, solo dims the rest |
| 4.3.7 — waveforms/filmstrips + clip volume (user request) | ✅ done | browser E2E: generated A/V file → strips + beat waveform, continuous across razor splits, volume commit |
| 4.3.8 — linked A/V clips + manual unlink (user request) | ✅ done | browser E2E: partner ghosts the drag live, one commit moves both, razor re-groups halves, unlink isolates |
| **4 gate** | ✅ closed | user manual pass 2026-07-11 |
| 5.1a — CFR export foundation | ✅ done | 21 focused tests: timing, backpressure, progress, ownership, cancellation |
| 5.1b — real video adapters | ✅ done | locked Mediabunny 1.50.3 browser pass: 10-frame MP4 reopened by native video |
| 5.1c — bounded audio export | ✅ done | NTSC browser pass: exact 48,048-sample stereo AAC mix, A/V both 1.001s, clean console |
| 5.1d — transition parity | ✅ done | same-asset seek/backtrack browser pass: 12-frame MP4, preview/export pixels within 2, clean console |
| 5.1e-1 — transition domain lifecycle | ✅ done | track-scoped add/update/remove + deterministic edit cleanup; linked rollback proven |
| 5.1e-2 — transition store wiring | ✅ done | one entry per edit; exact undo/redo id restore; rejected edits preserve redo |
| 5.1e-3 — transition timeline UI | ✅ done | seam marker + accessible duration popover; real preview pixels and exact keyboard undo/redo verified |
| 5.2a — export controller | ✅ done | 11 focused tests: snapshots, shared Blob resolver, result drain, cancellation races, cleanup |
| 5.2b — export UI | ✅ done | real browser A/V export + download, active cancellation, retry, focus, clean console |
| 5 — export | ✅ done | complete export pipeline + browser-verified delivery flow |
| **5 / MVP gate** | ✅ closed | user manual pass 2026-07-12 |
| Post-MVP #2 — smooth preview playback | ✅ done | Blob-backed streaming lanes; user verified multiple videos without stutter |
| Post-MVP #3 — undistorted timeline visuals | ✅ done | fixed-aspect SVG thumbnail patterns + antialiased vector waveform; Chrome razor continuity, clean console |
| Post-MVP #5 — live audio playback | ✅ done | user verified; Chrome: audible RMS, mute/pause/seek cleanup, exact final frame, clean console |
| Post-MVP #9 — three-mode timeline zoom | ✅ done | authoritative px/frame plus exact-endpoint 12h runway over a bounded 16Mpx surface; 127 focused + 930 total tests; real Chrome long-project/rebase/fit/center/resize/visual gate |
| Post-MVP project system — Slice 1 foundations | ✅ done | presets + portable `.webcut`; Chrome: 2.000s 60fps source stays 2.000s at 30fps, clean console |
| Post-MVP project system — Slice 2 media import | ✅ done | one analysis per file; explicit Keep/Match/Cancel; complete-asset commits; 745 tests + Chrome gate |
| Post-MVP project system — Slice 3 sessions/UI | ✅ done | atomic Create/Resume/relink; 764 tests; real 4K60 create + 1440p60 media-resume Chrome gate |
| Post-MVP project system — Slice 4 persistence | ✅ done | portable Save/Save As, revision-safe live save, quiesced exit; 794 tests + Chrome toolbar/Resume/layout gate |
| Post-MVP project system — remembered media follow-up | ✅ done | origin-local file handles + permission-aware automatic relink; 806 tests + Chrome picker-entry smoke |
| Post-MVP project system — Slice 5 local library | ✅ done | Recent handles + explicit three-generation recovery; 840 tests + Chrome reload/recover/discard/picker-entry gate |
| Post-MVP project system — Slice 6 offline media | ✅ done | open-offline + one-file/folder relink + ambiguity UI + export preflight; 881 tests + Chrome offline→folder-relink gate |
| Post-MVP #11 — cross-track clip dragging | ✅ done | same-kind video/audio lane targeting + vertical ghost; 885 tests + user manual drag gate |
| Post-MVP #19 — compatibility Slice 1 | ✅ done | byte-detected container + every-track native config-support probe; guarded session reports + accessible Media Pool diagnostics; 184 focused + 979 total tests; Chrome for Testing Ready/Unsupported/720px gate |
| Post-MVP #19 — compatibility Slice 2 | ✅ done | Resume/Relink reports + exact-generation preview/visuals/audio/export feedback; 303 focused + 1,021 total tests; in-app Chromium Ready/Unsupported/runtime-failure/recovery/720p gate |
| Post-MVP #19 — compatibility Slice 3 | ✅ done | one lazy local-decoder seam for ProRes + AC-3/E-AC-3 across probe/visuals/preview/audio/export; bounded automatic policy; 1,042 tests + in-app Chromium import/preview/playback/export gate |
| Post-MVP #19 — compatibility Slice 4 | ✅ done | explicit whole-kind consent + durable video-only/audio-only projection across import/Resume/Relink/runtime/export; 1,072 tests + in-app Chromium dual-path gate |
| Post-MVP #19 — compatibility Slice 5 | ✅ done | bounded realm-local exact-config capability cache; probe reuse + forced render/visuals/audio/export revalidation; 1,092 tests + in-app Chromium playback/export gate |
| Post-MVP #19 — compatibility Slice 6 | ✅ no-go decided | measured local worker/WASM proxy spike, including a Limited source with browser-unsupported video; failed bounded-I/O/progress/license/provenance gates with low-memory behavior unproven; no converter shipped |
| **Post-MVP #19 — final closeout** | ✅ closed | 13-file real codec/damage matrix; prompt/commit cancellation + exact disposal races fixed; runtime fallback budgets and filmstrip canvases bounded; 346 focused + 1,127 total tests; Chrome 150 and Edge 150 full VP9/Opus playback/cancel/export gates; closes at 46/49 with three rejected proxy children intentionally unchecked |
| Post-MVP #12 — manual linking Slice 1 | ✅ done | pure eligibility/link operation + collision-safe document-aware ids across manual link, linked split, and A/V drop; 57 focused + 1,138 total tests; no rendered behavior yet |
| Post-MVP #12 — manual linking Slice 2 | ✅ done | canonical history-backed store action; one-entry link, exact undo/redo id, rejection preserves populated redo branches; 90 focused + 1,142 total tests; no rendered behavior yet |
| Post-MVP #12 — historical local Slice 3 bundle | ✅ done | multi-selection/control foundation (maps into original Slices 5–6); 54 focused + 1,152 total tests; in-app Chromium interaction gate |
| Post-MVP #12 — historical local Slice 4 bundle | ✅ done | signed-delta linked move previews + unequal edit/rollback matrix (maps into original Slices 3–4); 129 focused + 1,159 total tests; real Chrome A/V gate |
| Post-MVP #12 — original Slice 3 integrity | ✅ done | unequal edit/rollback matrix plus orphan-safe track removal; each lone unlocked survivor is unlinked in the same one-entry operation, while a locked survivor rejects atomically |
| Post-MVP #12 — original Slice 4 previews | ✅ done | signed-delta rendering plus fresh group-wide pointerdown bounds for move/trim/ripple/slip/slide across connected and offline media |
| Post-MVP #12 — original Slice 5 | ✅ done | app-level stale/deleted selection reconciliation; surviving-primary promotion, undo non-resurrection, track/project replacement, and history/serialization isolation; 82 focused + 1,173 total tests; in-app Chromium delete/undo/track-removal gate |
| Post-MVP #12 — original Slice 6 | ✅ done | focusable pressed clip controls + focusable `aria-disabled` Inspector Link/Unlink with visible described reasons; exact-target race rejection, retained pair selection/primary, badges/highlighting, focus handoff; 100 focused + 1,184 total tests; targeted in-app Chromium accessibility gate |
| Post-MVP #12 — original Slice 7 / closeout | ✅ complete | orphan-safe removal, group-wide bounds, and immutable pointerdown document guard; 359 focused + 1,209 total tests; Chrome 150 full import/re-link/move/undo/redo/playback gate with a clean console |
| Post-MVP #18 — original Slice 1 source foundation | ✅ done | historical local Slice 1 bundle: byte-sniffed PNG/JPEG/WebP/AVIF, immutable budgets, exact source ownership, fixture and Chrome module gates |
| Post-MVP #18 — original Slice 2 schema/migration | ✅ done | historical local Slice 3 bundle + correction: `Clip.sourceMode` required; nested timeline schema 1→2; outer project format remains v3 |
| Post-MVP #18 — original Slice 3 editing semantics | ✅ done | historical local Slice 3 bundle: canonical `[0, 1)` still source, frame-0 selectors, Slip no-op, editable independent timeline duration |
| Post-MVP #18 — original Slice 4 import/default/reconnect | ✅ done | historical local Slice 2 bundle + correction: persisted **Default still-image duration** for future imports; reconnect restores each saved duration |
| Post-MVP #18 — original Slice 5 Media Pool/timeline visuals | ✅ done | historical local Slices 2–3: bounded one-tile thumbnails, diagnostics, draggable Ready rows, repeated still timeline tiles |
| Post-MVP #18 — original Slice 6 worker preview | ✅ done | historical local Slice 4 bundle + referenced-only image opening, discriminated protocol, one resident still/asset, exact loan/setup identities, aggregate 256 MiB reserved-and-retained worker budget, bounded close ack, repeated seek/play/reopen |
| Post-MVP #18 — original Slice 7 transition compositor | ✅ done | intrinsic opacity + explicit weights; complete transformed legs added with `lighter` inside one isolated group, then source-over once; exact software + Chromium pixel matrix |
| Post-MVP #18 — original Slice 8 export | ✅ done | typed source errors preserved; decode-once/frame-zero and real-source cleanup matrix; Chromium 60-frame AVC encode/reopen plus direct production Preview/output pixel parity and clean diagnostics |
| **Post-MVP #18 — original Slice 9 acceptance/closeout** | ✅ complete | 693 focused + 1,385 total tests; 18-file hostile/orientation matrix; Chrome multi-import, edit, recovery/relink, layered crossfade, and export gate; Issue #18 closeout evidence complete |
| **Post-MVP #17 — exact audio-aware crossfades** | ✅ complete | canonical grouped visual/audio plans, real per-stream handles, atomic accessible settings, exact live/export envelopes, 1,441 tests, and full-app Chromium transparent-layer/tone/export-reopen acceptance |
| **Post-MVP #16 — capability-aware export profiles** | ✅ complete | Auto + four probed profiles; exact buffered/direct A/V reopen/playback and failure/memory gates; 17 browser gates, 14 reopened outputs, clean console; PR #29 normally merged and Issue #16 closed |
| **Post-MVP #31 — project aspect ratios** | ✅ implementation complete | four exact creation families × four size tiers; unchanged `.webcut` schema; 183 focused + 1,659 total tests; in-app Chromium monitor/export/720px gate with a clean console |
| **Post-MVP #32 — four default tracks per kind** | ✅ complete | fresh documents create `V1`–`V4` + `A1`–`A4`; saved track sets stay unpadded; 157 focused + 1,661 total tests; in-app Chromium 720px gate; PR #37 normally merged and Issue #32 closed |

Issue #16 is complete. PR #29 was normally merged as `edb02d0`, its complete
checklist and validation evidence were recorded, and the issue was closed as
completed. The production dialog reports Compatibility, Web, Modern, and HEVC
as Available on this Windows Chrome 150 host, and Auto resolves visibly to
Modern. All four profiles passed buffered and direct-file export/reopen/native
playback at 320×180, 30000/1001 fps, 30 frames/1.001s, 48 kHz stereo, and
48,048 presented samples. AAC mono, audio-off, constant bitrate with a 500 ms
key-frame interval, and Web/Modern video-only variants also passed. Across 17
browser gates and 14 reopened outputs, picker cancellation/reuse, cancellation
after five staged writes, positioned-write failure, abort-integrity reporting,
retry, and bounded direct-file memory all behaved honestly with zero warnings
or errors. Runtime-native capability gating remains authoritative: no codec is
substituted, and the researched local encoder fallbacks were rejected for this
slice.

The Issue #17 suite passes 1,441/1,441 tests across 77 files. Production build,
lint, diff checks, focused planner/UI/playback/export suites, exact browser
tone gates, and the final full-app Chromium acceptance matrix pass. Issue #18's
1,385-test corrective source suite and 18-file fixture matrix remain green in
that total. Earlier
completed phases remain committed separately
(see `git log --oneline`). The user completed the
Phase 5 / MVP manual gate on 2026-07-12, so WebCut is MVP-complete; the
post-MVP project-system milestone is now active. Phase 3 gate CLOSED
2026-07-06. Phase 4 BUILD-COMPLETE the same day: 4.1 compositor preview,
4.2 full editing toolset (select/razor/trim/ripple/slip/slide + S/Del),
4.3 Inspector + arrow stepping. The user completed the Phase 4 manual gate
on 2026-07-11 (see PLAN.md). 2026-07-08 bug fix: dropping a
video asset that contains audio now lands a video+audio clip PAIR
(one undo entry) instead of silently dropping the audio; since 4.3.8
(2026-07-10) that pair lands LINKED — edits follow the link, Inspector
unlinks (see PLAN 4.3.8). Phase 5.1a landed 2026-07-11:
`pipeline/export.ts` owns the tested CFR scheduling contract
(injected frame leases/sink, exact rational timestamps, awaited backpressure,
progress/result protocol, and exact-once cleanup). Phase 5.1b landed the same
day: `pipeline/export-mediabunny.ts` provides real lazy Blob decoding and
AVC/MP4 encoding. One long-lived timestamp iterator per asset keeps decoder
count bounded; frame leases own and close stable ImageBitmap copies. The real
browser gate re-exported 10 red→green frames and native `<video>` reported
64×48, 1.000s, with correct pixels at 0.2s and 0.7s. Phase 5.1c landed the
same day: `pipeline/export-audio.ts` owns the exact integer sample grid and
bounded mix; `pipeline/export-mediabunny.ts` adds lazy active-clip audio
decoders plus stereo AAC encoding. The real 30000/1001 browser gate exported
exactly 48,048 scheduled samples: AVC + AAC, 48 kHz stereo, audio and video
both 1.001s, correct trimmed/half-gain tone followed by silence, clean
console. Phase 5.1d now routes compositor, preview requests, and export
requests through `visibleVideoLayersAtFrame`, including centered crossfades
with frozen source endpoints and hard-cut fallback for malformed/ambiguous
definitions. Its same-asset browser gate forced the real decoder forward →
backward → forward, reopened all 12 output frames at exactly 1.200s, and kept
preview/export probe pixels within 2 channel values with no dark midpoint or
console errors. Transition authoring has its 5.1e-1 domain lifecycle:
track-scoped add/duration/remove
operations share the renderer's exact centered-window resolver, and every
geometry edit keeps only seams valid before and after (split carries an
outgoing seam to the new right half; linked rollback restores everything).
5.1e-2 supplies the undoable store surface: add, duration change, and removal
are one snapshot each; rejected or idempotent calls leave both undo and redo
stacks untouched; redo restores the original generated transition id rather
than minting another one. 5.1e-3 makes that lifecycle user-visible: every
eligible touching video seam has a small marker whose popover chooses a
duration before Add, then explicitly Applies or Removes it. The real-browser
gate authored D15, changed it to D2, removed it, and walked all three states
backward/forward with the exact id. Red→green preview probe pixels changed at
the expected frames and the console stayed clean. Phase 5.2a now provides the
app export controller: it captures one document/settings/media snapshot,
retains referenced Blobs before their object URLs can be revoked, shares one
cached resolver across video and audio, explicitly drains progress through the
final result, and serializes cancellation after any in-flight frame boundary.
Phase 5.2b originally exposed that controller through the Toolbar: one honest
fixed-profile modal showed the current timeline resolution, MP4/H.264, and 8 Mbps; progress is
rAF-coalesced; cancellation waits for controller cleanup; success owns a Blob
URL through download-link use and revokes it on close/reset/unmount. Empty timelines, setup/runtime
errors, double starts, pre-controller cancellation, keyboard isolation, focus,
and Windows-safe filenames are covered. The real browser gate imported a
generated 320×180 A/V source, exported a two-video-clip crossfade plus one
audio clip, downloaded `Browser - Export.mp4`, and probed 4.000s of 30 fps H.264
plus 48 kHz stereo AAC. Active cancellation happened at nonzero progress,
showed the cancelling state, produced no download, and a retry succeeded; the
console stayed at 0 errors and 0 warnings. Post-MVP issue #2 replaced per-frame
encoded-chunk rebuilding with worker-owned Blob sources and clip-keyed
sequential playback lanes; the user verified smooth playback across multiple
videos. Issue #3 now renders each full-source filmstrip as integer-frame SVG
buckets with fixed-aspect repeating thumbnail patterns, so even hour-long clips
add previews instead of stretching them; waveforms are smoothly connected SVG paths
instead of interpolated PNGs. Chrome verified a linked A/V import and exact
filmstrip continuity across a razor cut with no console warnings or errors.
Issue #5 adds bounded live audio: Mediabunny decodes rolling PCM
windows, Web Audio schedules them against one future AudioContext anchor, and
PlaybackEngine uses that same anchor. The Chrome gate measured non-zero audio
while playing, zero audio/nodes after mute and pause, successful audio re-prime
after a one-frame seek, exact exclusive-end parking, and no warnings or errors.

Issue #11 completes the existing cross-track `moveClip` domain capability in
the timeline UI. A select-tool move now resolves the same-kind lane physically
under the pointer despite pointer capture, ghosts only the gesture owner over
that lane, highlights the target, and commits one undoable move on pointerup.
Linked partners keep the same frame delta on their own current lanes. Video and
audio moves work in both directions; the user completed the manual gate on
2026-07-14.

Issue #9 adds Resolve-style Full Extent, Detail, and remembered Custom zoom
without creating a second transform or touching document history. `zoom`
remains the rendered pixels-per-frame value; `zoomMode` and `customZoom` are
ephemeral transport state. Geometry measures the live scroller and sticky
header, maps the slider exponentially, centers Detail/Custom around the
playhead after layout commit, and reflows Full/Detail through ResizeObserver.
Full keeps roughly 3% trailing room (at least 32px), fits changing document
duration, and always returns to frame zero. Follow-up viewport hardening keeps
the logical runway exactly `max(document duration, 12 hours)` instead of
shortening it near a browser layout ceiling. The DOM renders one whole-frame
window no wider than 16,000,000px; ephemeral `timelineOriginFrame` translates
global frames into that surface without changing the authoritative zoom.
Near either native-scroll edge, `Timeline` shifts the origin and applies the
opposite scroll delta before paint, preserving the visible logical position;
the final window ends on the true runway endpoint. The 2026-07-17 Chrome gate
measured 11.0001s Detail, 3.0005%
Full padding on a short project, exact Custom recall, geometric slider output,
1.25x buttons, endpoint disabling, frame-zero clamping, responsive centering
through 720px, virtualized ruler ticks, linked A/V alignment, filmstrips, and
waveform with a clean secure-origin warning/error console.

Project-system Slice 1 establishes the non-UI foundations: one authoritative
catalog for 720p/1080p/1440p/4K, exact common frame rates, and 44.1/48/96 kHz
audio; a pure new-document factory; and a versioned portable `.webcut` contract
with deterministic serialization, strict validation, migration entry points,
resource bounds, stable asset descriptors, and no session-only URLs, handles,
decoder state, visuals, or undo history. Media assets now retain canonical
integer microseconds and conform that duration to the active document rate. A
10-second 60 fps source in a 30 fps project is therefore 300 frames, not 600.

Project-system Slice 2 centralizes media import behind one app controller. A
selected File is analyzed exactly once, stays outside Zustand while a decision
is open, and enters mediaStore only as one complete asset. Exact rational native
and project rates drive an explicit Keep project rate / Match source rate /
Cancel dialog; WebCut never changes project FPS silently. Match is safe only
for an empty timeline and a supported project preset. It updates the document
and re-conforms every unused asset from canonical microseconds; once clips
exist, Match remains visible but disabled because edited-timeline retiming is a
separate operation. Every rejected/cancelled path closes Mediabunny Input and
revokes the uncommitted source URL. Preview now forwards the committed asset's
Blob and native rate directly to the worker instead of re-demuxing it.

Project-system Slice 3 makes those foundations user-visible. WebCut now opens
on a responsive Home screen with explicit Create and Resume paths. Create uses
the authoritative resolution/frame-rate/audio catalogs. Resume validates a
`.webcut` candidate before touching the editor, then analyzes selected source
files exactly once and restores their durable asset ids only on exact metadata
matches. Files, parsed candidates, and object URLs remain controller-local
until all required sources are ready. Activation awaits export and live-audio
cleanup, invalidates preview/import/visual work, revokes the outgoing session's
URLs, clears history and transient transport state, and commits the new
document/media as one complete session. Late relink and visual results are
generation-guarded and clean themselves up instead of crossing projects.

Project-system Slice 4 closes the portable save/resume loop. The pure project
file layer now snapshots the active document plus durable media descriptors
without Blob URLs, decoder data, visuals, conformed frame counts, or history.
The first `Save`, or any `Save As`, obtains one writable browser handle and
enables 800 ms debounced live save for later document/media changes. A
download-only browser receives a portable copy but remains honestly dirty
because download completion cannot be observed. Writes carry a session
generation and revision, so a late old-project write cannot update a
replacement and an edit made during a write stays dirty until one follow-up
saves the newest snapshot. Dirty work alone owns the `beforeunload` listener;
Projects confirms before discarding it, immediately stops new edits and queued
saves, waits for an open write, then drains export/audio, stops preview/import
work, and revokes outgoing media before showing Home. A failed exit re-enables
the retained live-save path. Media sources still used by clips can no longer
be removed into an unsavable document.

The remembered-media follow-up removes the repeated source picker on the same
browser/origin. Chrome imports and exact manual relinks now persist opaque
`FileSystemFileHandle`s in an IndexedDB sidecar keyed by document + asset id;
raw paths and handles never enter `.webcut`, Zustand, or domain data. Resume
queries each remembered handle: a retained read grant analyzes and reconnects
the exact descriptor automatically, while a `prompt` state becomes one
**Allow media & open** click whose permission requests start before the first
await. Denied, missing, moved, changed, unsupported-browser, and cleared-site-
data cases stay on the existing manual relink fallback. Old projects seed the
sidecar after their next successful handle-aware relink.

Project-system Slice 5 adds an origin-local project library without changing
the portable `.webcut` format. Validated handles become removable Recent
shortcuts in supporting Chrome builds. Dirty work writes a separate bounded
recovery journal: at most three complete generations per editing lineage,
twelve Recent entries, eight journals, and a fixed serialized-character budget.
Recovery never clears dirty state or claims the project was Saved; Home offers
it explicitly after reload/crash and requires confirmation before permanent
discard. Successful revision-current Save and intentional Projects exit clear
the journal. Recovery failures remain separate from file-save truth, and a
failed exit rebuilds its deleted safety copy before editing continues. No media
bytes, paths, object URLs, or handles enter `.webcut` or Zustand.

The real-Chrome gate passed 2026-07-14: four recovery writes retained exactly
three generations; reload offered, but did not silently activate, the local
copy; Review + Recover restored the latest four-track document and kept it
honestly unsaved; confirmed Discard removed the journal; the reusable project
picker entry rendered; the Home layout stayed intact; and the final console was
clean.

Project-system Slice 6 separates the durable media catalog from its connected
session resources. A validated `.webcut` now activates even when some or all
sources are unavailable: affected clips stay visible, retain finite descriptor
bounds, and are labeled Offline in the Media panel, timeline, and Preview.
Individual Relink restores one source. Scan folder performs a bounded recursive
enumeration and conservative matching by filename, size, modified time, and
analyzed media metadata; unique matches connect automatically, ambiguous
matches require explicit confirmation, and accepted files preserve the saved
asset ids. Files, handles, candidate paths, and staging URLs remain outside
Zustand, and every cancellation/supersession path releases its URLs. Preview
and live audio fail soft while media is missing; output-contributing offline
sources block export before any Blob or encoder is created.

The real-Chrome gate passed 2026-07-14 with a disk-backed `.webcut` and MP4:
the project opened with one offline source, the clip remained visible, Preview
named the missing file, and export named it while disabling Start. One folder
selection auto-matched and re-analyzed the MP4, restored thumbnail/Preview and
the same timeline clip, reported `1 connected · 0 skipped`, and enabled Start
export. The final warning/error console was empty.

Issue #19 Slice 1 adds a conservative direct-import compatibility boundary.
`pipeline/mediaCompatibilityProbe.ts` detects the container from bytes, probes
every A/V track with its explicit decoder configuration and the browser's real
`canDecode()` support result, and applies bounded file/track/config/dimension/
duration/rate/channel limits before creating any long-lived object URL. This
is a metadata/config-support check rather than an end-to-end sample decode. The app
controller owns File/handle resources outside Zustand, publishes request-id-
guarded serializable session reports, and retains rejected files only for an
explicit Retry/Remove action. Ready is the only new-import status allowed to
drag or drop; existing project connections without a report remain usable for
backward compatibility. Media Pool diagnostics expose specific container,
track, codec, dimensions/rates, and wrapped failure details in a responsive
live region.

The Chrome-for-Testing gate passed 2026-07-18 with generated disk fixtures. H.264/AAC
MP4 reported Ready with exact MP4/video/audio facts and dragged into one linked
A/V pair. ProRes 422 HQ MOV reported Unsupported, stayed non-draggable, created
a fresh guarded request on explicit Retry, and was removable by keyboard. The
180px Media Pool had no card overflow at the 720px shell gate; the final console
had 0 warnings and 0 errors.

Issue #19 Slice 2 carries the same typed result through remembered/manual
Resume, individual Relink, and accepted folder matches. Project activation now
installs connected sources and their Ready reports together; non-Ready reports
stay on durable Offline descriptors. A descriptor check preserves its previous
settled report while Checking and restores it if the attempt is cancelled,
selects the wrong file, or loses the final guarded commit. Store transitions
enforce descriptor identity, report/status consistency, and Ready/connected
parity without changing provisional direct imports.

Preview, filmstrip, waveform, live-audio, and export source failures now report
through one app-layer runtime seam. Every consumer captures the exact object URL
and compatibility generation before async work. Only that connection can be
disconnected; stale render requests, stale worker release cleanup, and late
visual/audio/export failures are diagnostic-only. File/Blob/Input failures are
typed as file-level `resource-unavailable`; actual track open/decode failures
are track-specific `decode-failed`; global output/pump/cleanup failures never
poison an asset. Media Pool announces one surface-specific runtime diagnostic,
keeps the source Offline, exposes Relink rather than import Retry, and publishes
a fresh Ready report after successful recovery.

The in-app Chromium gate passed 2026-07-18 at 1280×720 through WebCut's ordinary
file-input fallback. H.264/AAC relinked Offline → Ready with exact report facts;
ProRes relinked to Unsupported; selecting the wrong H.264 replacement restored
the prior ProRes report. A generated AAC file with valid metadata/config but
corrupted samples reached Ready at probe, failed waveform decode once, became
Offline with one `Waveform: Decoding error.` diagnostic and no Retry, then a
valid same-media Relink returned it to Ready. The normal path console was clean;
the forced failure emitted one expected warning and did not repeat. The 720p
shell and 228px diagnostics card had no horizontal or vertical overflow.

Issue #19 Slice 3 adds one realm-local, concurrency-safe decoder-registration
seam used by import probing, filmstrip/waveform generation, the render worker,
live audio, and export. Native `canDecode()` always runs first. Only normalized
ProRes or AC-3/E-AC-3 can lazy-load the exact locally bundled Mediabunny
1.50.9 extension, after which the same track is probed again; successful
reports record `Native browser decoder`, `Local fallback (ProRes)`, or `Local
fallback (AC-3/E-AC-3)` instead of claiming generic support. Failed loads can
be retried explicitly and overlapping requests share one loader promise per
realm. Vite emits independent lazy chunks for the main and worker realms and
dedupes their Mediabunny core instance.

Automatic fallback is intentionally conservative: at most 8 GiB, 2 hours,
DCI 4K30 ProRes pixel throughput, and 8-channel/48 kHz AC-3/E-AC-3. Above that
boundary the asset remains visible with a `resource-limit` diagnostic; WebCut
does not silently proxy it or omit a track. The probe checks cancellation
before and after the non-abortable module load and decoder checks, so an
aborted generation cannot publish Ready. ProRes correctness does not require
cross-origin isolation: TurboRes uses its slower message-passing worker mode;
shared-memory optimization remains a measured future choice. The AC-3
extension embeds FFmpeg, so distribution/license review is still a public-
shipping gate rather than a completed Slice 3 checkbox.

The in-app Chromium gate passed 2026-07-19 with generated native H.264/AAC,
ProRes 422/AAC, H.264/AC-3, and H.264/E-AC-3 fixtures. All four reported Ready
with exact decoder paths and generated thumbnails; ProRes visibly rendered
through the render worker; playback crossed into the AC-3 clip with a clean
warning/error console. A real mixed ProRes + AC-3 timeline exported and
downloaded a 4.000s MP4 that `ffprobe` identified as 1920×1080 H.264 plus
48 kHz stereo AAC. The ProRes packages were advanced together from 1.50.3 to
1.50.9 because the older release predated the upstream all-key-packet fix and
returned null for sparse thumbnail seeks.

Issue #19 Slice 4 adds a conservative whole-kind partial-import seam. A Limited
source offers video-only or audio-only only when every track of the kept kind
is decodable and the other present kind has a concrete failure. The controller
retains that provisional source until a native dialog explicitly names the
kept and omitted tracks, codecs, failure reason, unchanged original file, and
timeline/export consequence. Cancel keeps the Limited row and restores focus;
confirm atomically commits an effective one-kind asset while leaving the
accepted omission visible in its Ready diagnostics.

The effective asset is authoritative downstream: video-only suppresses audio
clips, waveforms, live-audio fetches, and audio export; audio-only suppresses
video clips, filmstrips, preview decoder configuration, and video export.
Export rejects any stale clip that contradicts that projection before opening
the source. Portable project format v2 stores the explicit selection, migrates
v1 projects, and reapplies the same omission across remembered/manual Resume,
individual Relink, folder matching, and accepted staged re-probes. A later
browser gaining support for both original tracks therefore cannot silently
resurrect the track the user chose to omit.

The in-app Chromium gate passed 2026-07-20 at 1280×720 with generated MKVs.
H.264/DTS offered video-only; MPEG-2/AAC offered audio-only. Both dialogs showed
the exact kept/omitted facts with safe initial focus; cancellation preserved the
Limited row and restored its trigger focus, and confirmation produced the exact
Ready projection with the omission still visible. Video-only generated a
filmstrip without a waveform; audio-only stayed free of a video filmstrip. No
error overlay appeared and the Vite runtime log contained no error.

Issue #19 Slice 5 adds one browser-session capability cache in the codec leaf.
It keys settled facts by decode boundary, track kind, normalized codec, and an
exact canonical-configuration SHA-256 hash that includes description bytes. It
retains no Blob, Mediabunny Input, track, decoder, or mutable configuration;
LRU entry, active-source, copied-material, and canonical-JSON ceilings bound its
memory. Unsafe or oversized keys simply bypass caching. The cache is realm-local
only and remains outside Zustand and `.webcut`, so another browser or resumed
session must establish its own facts.

The metadata probe can reuse a settled session fact. Render-worker opens,
filmstrips, waveforms, live audio, video export, and audio export always
revalidate their exact configuration and refresh the fact. Source generations,
runtime revisions, and per-key write sequencing reject late or remove/re-add
(ABA) publications. Source replacement/removal, provisional or Offline state,
confirmed runtime failure, worker replacement/release/open failure/close,
fallback registration, foreground restoration, and BFCache restoration all
invalidate the relevant facts. Cached fallback answers still reapply the
current source budgets and native-only paths are re-proven with WebCodecs.

The 2026-07-20 in-app Chromium gate opened and reconnected a generated 3.000s
H.264/AAC project at 1280×720. Both tracks reported Ready, the real filmstrip
and preview frame rendered, playback exercised render plus live-audio decode,
and full video + audio export reached Export ready. The page fit the viewport,
no error overlay appeared, and the warning/error console was empty.

Issue #19 Slice 6 makes the optional proxy-conversion decision. A locally hosted
`ffmpeg.wasm` 0.12.15/core 0.12.10 single-thread worker converted both a
VP9/Opus mechanics fixture and a Limited source with browser-unsupported video.
The latter was an 8.021 s, 1280×720 MPEG-2/AAC Matroska: video returned `false`
from `canDecode`, AAC returned true, and its 9.01 MB input became a 10.39 MB
H.264/AAC MP4 in 4,197.4 ms. Mediabunny reopened the output and both decoder
configurations returned true. Chrome 150 ran on a Ryzen 9 5900X/31.9 GiB host;
this does not prove low-memory or sample-level editing behavior.

`terminate()` returned during an active VP9/Opus rerun in 0.2 ms, prevented a
late completion, invalidated the worker, and made a full core reload mandatory;
that timing does not prove immediate WASM-memory reclamation or exact cleanup.
The experimental progress callback also emitted an invalid 1.15-trillion
intermediate value. The measured `writeFile`/`readFile` path used whole
WASM-FS input/output buffers; WORKERFS can avoid the input copy, but there is no
public atomic streaming OPFS output sink.

The result is a firm no-go for a built-in proxy feature in this issue. The stock
core also has a documented 2 GB input ceiling, requires cross-origin isolation
for its multi-thread option, and is packaged GPL-2.0-or-later with x264. WebCut
also needs a separate original/proxy provenance model before a downscaled or
CFR representation can safely cross preview, visuals, audio, render, export,
Save/Resume, Relink, and cleanup. The
full evidence and reopen gates are in
`docs/decisions/ISSUE_19_PROXY_CONVERSION.md`. No converter dependency, proxy
bytes, state, or project-schema field was shipped.

Issue #19 final closeout adds the reproducible
`scripts/generate-issue-19-fixtures.mjs` matrix and closes the remaining
ownership and runtime-safety races. A cancelled fallback caller now rejects
promptly and cannot publish after a non-abortable module/browser operation;
committed imports release the editor while remembered-handle persistence
continues safely; live-audio Inputs have one exact-once disposer even when
close overtakes track open; and the legacy decode worker closes bitmaps that
arrive after its generation changes. Every runtime fallback boundary carries
the probed source budget and fails closed when safety metadata is incomplete,
while filmstrip decoder/joined canvases stay explicitly bounded. The focused
suite passed 346/346 across 16 files and the full suite passed 1,127/1,127.

Chrome 150 and Edge 150 each ran real VP9/Opus through Ready import, thumbnail,
waveform, linked A/V drop, ruler seek, decoded Preview, live-audio scheduling,
active export cancellation, retry, and downloaded MP4. Both outputs probed as
1280×720 H.264 at 30 fps plus 48 kHz stereo AAC, and both runs had no console
or page error. The broader Chrome matrix also recorded local AC-3/E-AC-3,
host-native HEVC/AV1, spoofed WebM bytes under `.mp4`, unknown/malformed
partial-track choices, truncation, empty input, and random bytes. Edge is still
Chromium-based; Firefox/WebKit remain untested.

**Next: Issue #19 is closed at 46/49.** The three unchecked proxy implementation
children are the intentional no-go outcome, not forgotten work. Public
distribution remains a separate gate: add the WebCut license and third-party
notices/source links, finish FFmpeg/LGPL and Dolby review, and run representative
low-memory testing before making a release-compliance claim. Future project
storage is also separate opt-in media caching with quota/eviction UX and
multi-tab recovery ownership; do not imply recovery or a portable `.webcut`
contains source bytes today.

Issue #18 follows the original researched nine-slice roadmap. The older local
Slice 1–5 labels below describe delivery bundles, not an authoritative
renumbering: local 1 maps to original 1; local 2 maps mainly to originals 4–5;
local 3 maps to originals 2–3 and part of 5; local 4 maps to original 6; and
local 5 implements original 8. Original Slices 7–9 are complete. Issue #18 was
reopened after the premature closeout and then finished against the corrected
nine-slice acceptance gate.

Historical local Slice 1 establishes the static-image pipeline leaf. A bounded byte
inspector recognizes PNG, JPEG, WebP, and AVIF without trusting extension or
declared MIME, rejects unsupported/malformed sources before decode, and
publishes frozen source-size, candidate-dimension, allocation, and animation
facts. PNG/APNG and WebP first-frame/container geometry is checked so hostile
nested dimensions cannot bypass the predecode budget. AVIF item extents remain
conservative budget candidates because clean-aperture, rotation, derived items,
and WebCodecs track selection can legitimately change displayed geometry.
They do not absolutely cap native AV1 decoder work: sequence-header maximum
frame dimensions and intermediate images may exceed `ispe` before the browser
returns a source WebCut can inspect. The 256 MiB ceiling bounds WebCut's
estimates and accepted returned allocation, not every transient browser-decoder
allocation. Future hardening should parse sequence-header limits where practical
and stress hostile inputs in an isolated decoder context.

The atomic decode seam reinspects the exact Blob, canonicalizes its sniffed MIME,
and transfers exactly one caller-owned `ImageBitmap` or `VideoFrame`. It
revalidates coded, visible, display, and native allocation limits, preserves
orientation and alpha, closes every intermediate/cancelled/late resource, and
observes `ImageDecoder.completed` before closing an incomplete stream.

The reproducible 15-file fixture matrix and 60 focused tests cover all supported
formats, animation headers, alpha, EXIF orientation, spoofed naming/MIME,
malformed/truncated input, nested-frame budget attacks, allocation and
cancellation races, and unsupported SVG/GIF. All 1,269 tests across 68 files,
fixture replay, build, lint, audit, and diff checks passed. Real Chrome 150
through local Vite passed 41 browser facts for both decode paths, including
actual oriented pixel probes and exact caller close behavior, with 0 warnings
and 0 errors.

Historical local Slice 2 wires that foundation into the shared import/reconnection
boundary. Verified images now receive durable orientation-aware dimensions and
the then-current five-second default, survive Save/Resume/manual Relink/folder Relink,
and appear in the Media Pool with a bounded one-tile thumbnail, format/decode
diagnostics, animated-first-frame disclosure, and actionable error/retry states.
Native and fallback pickers accept multiple files through a maximum-100,
sequential queue so only one image decode owns peak memory at a time.

The focused historical local Slice 2 suite passed 212/212 tests across 12 files and the full
suite passed 1,291/1,291 across 71 files. Fixture replay, build, lint, audit,
and diff checks passed. In-app Chrome 150 imported PNG, EXIF-oriented JPEG,
animated WebP, and AVIF together; all four showed correct metadata and ready
thumbnails. Corrupt PNG remained Error through Retry, SVG/GIF remained
Unsupported, every image row remained non-draggable, and the console recorded
0 warnings and 0 errors.

Historical local Slice 3 establishes the still-clip timeline contract. Clips now carry
an explicit `timed` or `still` source mode; every still owns canonical source
range `[0, 1)` while its independent timeline range starts at the configured
import default. The outer portable project format remains v3; nested timeline
schema 2 requires `sourceMode`, and bounded nested-schema-1 migration converts
legacy image-media clips without misclassifying timed video/audio or text clips.

Selectors map every ordinary and transition frame of a still to source frame 0.
Move, trim, ripple, Razor, and Slide preserve `[0, 1)` while editing timeline
geometry. Slip is a silent same-reference no-op for a still or a linked group
containing one, so it creates neither a gesture preview nor a history entry.
Ready images are now draggable to video lanes, and one bounded image tile
repeats across the complete still clip, including split and extended ranges.
The accessible clip name identifies a still image, and its Slip title explains
why the tool is unavailable.

The focused historical local Slice 3 suite passed 352/352 tests across 10 files and the full
suite passed 1,311/1,311 across 71 files. Fixture replay, build, lint, audit,
and diff checks passed. In-app Chrome 150 imported a real 2×2 PNG, showed the
Ready row as draggable, rendered the exact five-second still tile, Razor-split
it into adjacent 75/75-frame halves, added a 15-frame crossfade, preserved
identical rendered markup through a Slip attempt, and restored Razor/crossfade
states through keyboard undo/redo. The console recorded 0 warnings and 0
errors. The browser runner needed removed QA-only chooser/insertion adapters
because it cannot carry a local file through File System Access or synthesize
this HTML drag; the actual import, clip factory, store, editing, transition,
and rendering paths ran unchanged, and focused UI tests cover data transfer.

Historical local Slice 4 connects that still contract to the shared preview
compositor. The corrected app sends an image Blob only while the active
document references that asset. The worker
decodes and retains exactly one `ImageBitmap` or `VideoFrame` per asset, lends
that same frame-zero source to every visible clip/layer, and keeps the live
resource outside React/Zustand state. Per-source loans prevent replacement or
release from closing a frame while a composite is drawing it. Revisions plus
abort signals reject stale concurrent opens, while replacement, release,
decode failure, cancellation, and acknowledged worker shutdown close every
decoded source exactly once.

The focused historical local Slice 4 suite passed 128/128 tests across the render worker, bridge,
preview controller/UI, and compositor files. The full suite passed
1,327/1,327 across 71 files; deterministic fixture replay, production build,
lint, audit, and diff checks passed. In-app Chromium imported a real 280×175
JPEG, rendered it at frame zero, retained it through a complete five-second
playback, applied position/scale/rotation/opacity live, Razor-split it, and
played across a 15-frame same-asset crossfade with transformed pixels intact.
The console recorded 0 warnings and 0 errors. The browser runner again needed
removed QA-only chooser/insertion adapters because its native File System
Access and HTML drag bridges cannot carry the local fixture; import,
clip creation, worker decode, preview, transforms, transitions, and playback
ran through the production paths.

Historical local Slice 5 implements original Slice 8 export without creating a second
visual path. The captured resolver now includes each asset's kind. Timed videos
keep one Mediabunny Input/CanvasSink iterator and per-frame bitmap leases;
images pass through the bounded static-image inspector/decoder once and retain
one frame-zero `ImageBitmap` or `VideoFrame` for the whole export. Frame leases
borrow that source, while only terminal export-source cleanup closes it.
Shutdown aborts pending image work, late success closes before publication, and
resource-limit failures preserve typed export identity.

The focused historical local Slice 5 export adapter/controller suite passed 54/54 tests and the
full suite passed 1,331/1,331 across 71 files. Deterministic fixture replay,
production build, lint, audit, and diff checks passed. In-app Chromium imported
an alpha PNG and generated H.264 video, exercised still trim/transform,
scrubbed and played a 15-frame image→video crossfade, exported the mixed
timeline, and re-imported that exact download as Ready. The result was
1280×720 H.264 at 30/1 fps, exactly 210 frames / 7.000 seconds; extracted start,
transition, and video frames matched the expected transform, opacity, layering,
and blend. No export, decoder, render-worker, or browser errors appeared. The
sole warning was the expected domain rejection from an intentionally attempted
overlapping move. Removed QA-only chooser/insertion adapters bridged browser
automation's File System Access and HTML drag limitations.

The corrective pass completes the original Slices 2, 4, and 6 boundaries that
the historical bundle labels obscured. `Clip.sourceMode` is required under
nested timeline schema 2 while the outer project format stays v3. **Default
still-image duration** is a persisted preference for future imports, and
reconnect restores each descriptor's saved duration rather than reapplying the
current preference. The worker protocol discriminates video from image entries,
opens images only while referenced, retains one still per asset behind an exact
loan ledger, applies one aggregate 256 MiB reserved-and-retained worker-realm
still budget, and uses a bounded close-ack timeout with exact-once termination.
Pending decodes reserve before allocation, high-bit-depth fallback paths use a
conservative 8-byte/pixel reservation and reconcile to the exact returned
lease, and late completions retain exact ownership. Monotonic `setupId` values
make delayed ACK/errors inert across release and cross-kind reopen. Repeated
seek/play/reopen and replacement/release/active-loan/shutdown races are covered.
The corrective source suite passes 1,380/1,380 tests across 74 files; fixture
replay, production build, lint, dependency audit, diff checks, and the real
browser Slice 6 cycle pass with 0 warnings and 0 errors.

Original Slice 7 replaces the flat source-over compensation with one isolated
premultiplied transition group in the shared preview/export renderer. Complete
transformed legs render normally into a lazy reusable leg surface, add to a
cleared group via `lighter` at `(1-p)` / `p`, and source-over that group once.
Exact goldens cover opaque, transparent, intrinsic-opacity/lower-layer,
transformed, still→video, video→still, still→still, missing-leg, and ordinary
video cases. The production streaming `renderFrame` path also crossfades a
retained image loan with a video loan through the isolated surfaces. The
focused suite passes 164/164 across 6 files; the full suite
passes 1,380/1,380 across 74. Real Chromium `OffscreenCanvas` samples matched
the production compositor within normal RGBA8 rounding, ordinary frames made
zero transition allocations, and browser diagnostics recorded 0 warnings and
0 errors. All temporary QA exposure was removed.

Original Slice 8 closes the encoded-output boundary. The production export
orchestrator now preserves the exact typed source error that the shared preview
compositor intentionally softens into `missing`; finite export therefore keeps
asset/runtime identity without changing preview retry semantics. Adapter tests
cover image→video, video→image, and same-asset image→image, proving one decode
per still, frame-zero reuse, canonical timed requests, and exact frame-local and
whole-export ownership. Early generator return and encoder failure now run
against the real retained-image source, including abort and primary-error
precedence. The focused suite passes 89/89 across 4 files; the full suite passes
1,385/1,385 across 74.

In-app Chromium 150 exported a production 320×180, 30 fps, 60-frame AVC MP4
containing an opaque lower still, scaled/rotated semi-transparent RGBA still,
transformed video, and a seven-frame still→video crossfade. Mediabunny 1.50.9
reopened the exact 12,304-byte buffer at timestamp zero, reported 2.000 seconds,
and decoded all 60 frames. Thirty 7×7 pre-encode/output patches across ordinary,
outgoing, overlap, incoming, and video frames measured maximum patch-mean channel delta
1.510, maximum patch RGB MAE 1.000, and selected-region RMSE 0.680 against
limits 12/10/15; decoded alpha remained 255. Browser diagnostics recorded 0
warnings and 0 errors. A stricter second pass mounted the normal editor, awaited
the production Preview worker's drawn/no-missing result for each requested frame,
and compared that transferred canvas directly with the reopened-output canvas in
same-screen captures. The same 30 patches measured maximum patch-mean channel
delta 3.143, maximum patch RGB MAE 2.347, and selected-region RMSE 1.693 against
limits 12/10/15; all five complete 320×180 pairs measured RGB MAE 1.781 and RMSE
2.934. Diagnostics again recorded 0 warnings and 0 errors. The temporary seed,
observation hook, captures, and server logs were removed.

Original Slice 9 completes the acceptance/closeout boundary. The focused
source/import/project/edit/preview/export matrix passes 693/693 across 25 files;
the complete suite remains 1,385/1,385 across 74. The deterministic matrix now
contains 18 files: EXIF orientations 2, 5, and 7 add mirrored-horizontal,
mirrored-transpose, and mirrored-transverse cases to the previous rotated JPEG
coverage. Validate-only replay, production build, lint, audit, and diff checks
all pass.

In-app Chrome 150 multi-imported alpha PNG, rotated and mirrored JPEGs,
animated WebP, and AVIF with exact orientation-aware display sizes and the
explicit first-frame-only label. It content-sniffed a `.jpg` carrying PNG bytes,
rejected corrupt/oversized/GIF/malformed inputs, reopened recovery and portable
projects offline, accepted an exact relink, rejected a mismatched relink, edited
transforms, Razor/undo, played the still timeline, authored a 15-frame
still→still crossfade, and exported a relinked two-layer 320×180 AVC project.
The final console had 0 warnings and 0 errors. Slice 8's exact-buffer reopen and
sampled direct Preview/output comparisons remain the pixel-parity proof; the
native disk-backed Save/Resume/Relink path remains covered by its earlier Chrome
gate plus the complete persistence/controller suite. Temporary QA picker and
portable-project helpers were removed before the final gates.

Issue #17 completes exact audio-aware crossfades in eight independently gated
slices. Project format 4 and timeline schema 3 persist independent exact or
conservative video/audio bounds plus transition audio intent. The pure
`crossfadePlan.ts` authority resolves centered odd/even windows, genuine handle
capacity, grouped visual requests, and exactly one aligned linked-audio partner
per leg. Invalid or unavailable audio retains a valid visual transition and
falls back to the ordinary hard cut with a typed UI explanation.

Preview and export both consume `videoCompositionPlan.ts`. The worker carries
grouped clip-keyed requests without reconstructing adjacency; complete
transformed/effected/opacity-adjusted legs combine on bounded reusable sRGB
surfaces before the isolated group composites over lower tracks once. This
preserves Issue #18's transparent/transformed correctness while replacing its
temporary frozen timed endpoints with real source handles. Same-asset legs keep
independent clip identity and requested frames are fetched once.

The seam popover atomically edits duration, linked-audio intent, and linear or
equal-power curve with exact visual/audio maxima and one undo entry. Shared
`audioMixPlan.ts` facts drive both rolling Web Audio and export. Live playback
schedules exact ramps/129-point bounded curves against the audio anchor and
generation-safely restarts on relevant edits; export evaluates the same
absolute envelope per BigInt-derived sample before final clipping. Exact handle
readers fail closed on EOF, gaps, discontinuity, or missing interpolation
instead of freezing or zero-filling PCM.

The focused final export gate passed 109/109 and the full suite passed
1,441/1,441 across 77 files. Chrome first encoded/reopened both curves with
distinct 440 Hz left and 880 Hz right tones: linear ratios at 25/50/75% were
0.333/1.001/2.996 and equal power was 0.415/0.999/2.413. The final full-app
gate used rotated, offset, semi-transparent PNG legs over a checkerboard plus
linked tone clips. Both curve edits were one history entry, live runs exposed
non-zero RMS/nodes, seek/pause/end released the audio session, and the normal
Export dialog produced a 178,424-byte 2.000-second AVC/AAC MP4. Reopen reported
48 kHz and volume-weighted equal-power ratios 0.312/0.751/1.791, within AAC
tolerance of 0.311/0.750/1.811. Browser warnings and errors were both zero;
all temporary acceptance files and server logs were removed.

## What works today (user-visible)

Run `npm run dev` → project Home. Create a project with an explicit canvas,
frame rate, and audio rate, choose a `.webcut`, reopen a Recent file, or review
an explicitly offered recovery copy. Remembered sources with a
retained grant reconnect automatically; a returned permission prompt needs one
Allow-and-open click. Genuinely missing sources can open Offline without hiding
their clips; reconnect one from its Media row or choose Scan folder once for
bounded batch matching. Preview/audio resume when the source reconnects, and
export stays disabled only while an output-contributing source is offline.
Review the profile, then open it with ready or offline sources. In the editor,
the first Save chooses a writable file; Save As chooses another; both turn on
live save. The toolbar shows dirty/saving/saved/error state, reload is guarded
only while dirty, and returning to Projects confirms before safely closing the
active media session. Import video, audio, or PNG/JPEG/WebP/AVIF still images
in the Media Pool; files are byte-verified and analyzed before they appear.
Still images receive orientation-aware dimensions, the persisted **Default
still-image duration** for future imports, and one bounded thumbnail; Ready rows
drag to video lanes as explicit still clips. Changing the preference does not
retime existing assets, and Resume/Relink restores each saved image duration.
Their timeline duration can be moved, trimmed, rippled, split, slid, and joined
by transitions while the single source frame remains fixed; Slip explains that
it is unavailable and performs no edit. Save/Resume/Relink preserves that
  contract. The timeline tile repeats correctly; Preview and Export both reuse
  the shared compositor, with one bounded retained still decode per asset and
  exact terminal cleanup. An FPS mismatch opens an explicit
Keep/Match/Cancel dialog, and every video asset gets its own decoder in the
render worker. The Preview is the real timeline compositor (4.1): all visible
video tracks draw bottom-to-top at the playhead with per-clip Transform
(scale/rotate/translate around anchor) + opacity alpha-blended onto a
black 1920×1080 composition; hidden tracks skip; gaps show background.
Click/drag the timeline ruler → playhead moves, Preview follows
(rAF-coalesced, latest-wins, double-buffered — no torn frames). Drag a
media row onto a lane (4.0): compatible lanes highlight, drop creates the
clip at the pointer, one undo entry (kind-gated: video/image → V lanes,
audio → A lanes; rows drag only after metadata arrives). A video asset
whose file contains audio lands as a LINKED PAIR (4.3.8) — video clip
on the drop lane + audio clip on the first unlocked A lane sharing one
`linkGroupId`, one atomic documentStore.insertClips, ONE undo entry;
if the audio spot is occupied the whole drop rejects (never half a
pair). Linked clips show a tiny 🔗 badge; every geometry edit
(move/trim/ripple/slip/slide/razor/S/Delete) applies to BOTH halves
atomically — the partner even ghosts the gesture live — and the
Inspector's "🔗 Unlink audio/video" button dissolves the group (one
entry; undo re-links). The historical Issue #12 Slice 3 bundle adds ephemeral
  ordered `selectedClipIds` plus one primary clip: normal pointer/unmodified
  keyboard activation replaces the selection, while Ctrl/Cmd pointer/keyboard
  activation toggles without starting a move. Inspector keeps editing the
  primary while its native Link/Unlink commands stay focusable with
  `aria-disabled` when unavailable; adjacent described status explains why,
  and activation dispatches only for the exact rendered eligible pair after a
  latest-state preflight. Original Slice 5 completes that selection lifecycle through an
app-level reconciliation controller: deleted/stale ids are pruned after every
document snapshot, surviving order is stable, the latest survivor becomes
Inspector primary when needed, and undo restores document content without
resurrecting selection. The historical Slice 4 bundle
stores a signed drag delta instead of the gesture owner's absolute start, so
every linked member ghosts from its own committed start even when manual
linking preserved unequal timeline offsets. Slice 7 now derives a shared legal
delta at pointerdown by intersecting the owner and linked partner's timeline,
source, duration, and headroom bounds from one fresh document/media snapshot.
The gesture keeps that exact document reference; if document state changes
before release, its preview is cleared and pointerup cannot commit stale
geometry.
Pointer movement remains transport-only and pointerup still commits one atomic
linked move. Transform
and volume stay per-half on purpose. The full editing toolset (4.2): toolbar
buttons or A/B/T/Y/U — select (normal click selects one, body
drag moves horizontally or between same-kind lanes with snap-back on illegal
drops, edge drag trims), razor
(click cuts at the pointer frame), ripple trim (edges; downstream
follows), slip (source shifts under a fixed clip, live-clamped to the
asset, delta badge), slide (touching neighbors absorb). S splits under
the playhead, Delete/Backspace ripple-deletes the selection, ←/→ steps
the playhead one frame, empty-lane click deselects. Transition authoring
(5.1e-3 + Issue #17): each touching adjacent non-text video seam shows a tiny
`+` marker. Its popover chooses an exact integer-frame duration, whether to
crossfade unique aligned linked audio, and a linear or equal-power curve. It
reports visual and audio handle maxima independently; unavailable linked audio
keeps the visual authoring path and explains the fallback. An authored seam
shows `CF`; the same popover explicitly Applies the complete settings payload
or Removes the crossfade. Domain rejection stays visible so a shorter duration
can be tried, locked tracks disable the marker, and each successful Add/Apply/
Remove is exactly one undo entry. The Toolbar's Export button opens a
capability-aware modal. Timeline resolution, FPS, and sample rate remain
project-owned and read-only; Auto plus Compatibility, Web, Modern, and HEVC
show exact availability reasons. Validated advanced controls cover codecs,
audio off/mono/stereo, bitrate behavior, key-frame interval, and destination.
Success either owns a downloadable Blob URL or reports a committed direct file;
Cancel drains cleanup, and file failures distinguish an empty target from a
possibly incomplete one. The Inspector (4.3)
edits the selected clip's position/scale/rotation/opacity — drafts while
typing, commits on blur/Enter, Escape reverts — and the compositor
preview reflects each commit immediately. Every gesture and every field
commit = one undo entry. Transport bar (4.0.5 + issue #5): play/pause +
one-frame steps. Live audio uses bounded Mediabunny decode windows and Web Audio
scheduling; audio and video share one future AudioContext anchor (rule 3).
Pause, scrub, step, audio-plan edits, and media replacement cancel/re-prime the
session exactly; the final frame receives its full duration before the exclusive
end. Play at the end restarts from 0. Timeline track headers (4.3.5): a
sticky gutter on the timeline's left shows every track's badge, kind
and live clip count with hide (video) / mute (audio) / lock toggles —
each real toggle is one undo entry; "+ Video"/"+ Audio" buttons add
tracks (V2 composites above V1 and displays above it; audio stacks
below). Lanes mirror the flags: hidden/muted clips dim, locked lanes
get stripes + a not-allowed cursor. Track management (4.3.6):
double-click a header to RENAME inline (Enter/blur commits, Escape
cancels; the badge shows the name, the id never changes), the ×
DELETES a track with its clips (one undo restores both; disabled
while locked). The same operation dissolves the group id on every lone
unlocked linked survivor; a locked survivor rejects the whole deletion, so no
orphaned group can enter history. Audio rows have SOLO next to mute — while any
track is solo the other audio lanes dim. Solo/mute semantics live in
ONE place, domain `audibleTracks` (mute wins over solo); both export and live
playback consume that selector rather than re-deriving flags. Clip visuals
(4.3.7): every imported asset gets a FILMSTRIP (video frames, one
tile per ~2s, cap 48) and a WAVEFORM image generated once in the
background (app/mediaVisualsController → pipeline/visuals via
mediabunny sinks); both images span the asset's FULL duration. ClipView
maps filmstrip time through fixed-aspect SVG patterns in integer-frame buckets
and waveform time through a normalized source-time SVG viewBox. A long clip is
sliced to the current bounded timeline window while both visual types retain
their exact source offset, so trim/razor/zoom/rebasing need zero decode work and
slip/start-trim previews shift the material live without stretching, bitmap
blur, or oversized DOM backgrounds. The Inspector edits VOLUME for audio-lane
clips (domain-clamped
[0,2], one entry per commit; export and live playback consume it) and shows
the transform fields only for video-lane clips.
The transport's right dock provides Full Extent, 11-second Detail, and
remembered Custom timeline zoom plus multiplicative −/+ steps; every timeline
renderer still consumes the same authoritative pixels-per-frame value.
`timelineOriginFrame` is translation-only session state for the bounded native
surface; it is not a second zoom and never enters document history.

## Map (key files, one line each)

- `src/domain/` — `schema.ts` (types, half-open TimeRange, rational rates,
  and required `ClipSourceMode` with explicit `timed`/`still` values in every
  current clip),
  `time.ts` (conversions incl. exact integer microseconds,
  `snapToStandardRate`, `formatTimecode`),
  `operations.ts` (pure edits; REJECT = same doc reference + console.warn;
  Issue #18 original Slice 3 keeps still source `[0, 1)` through clip creation,
  trim/ripple/Razor/Slide and makes Slip a silent same-reference no-op;
  Issue #12 original Slice 7 `removeTrack` atomically dissolves lone unlocked link survivors or
  rejects for a locked survivor; Issue #17 adds exact-bounds-aware atomic
  `addCrossfadeWithSourceBounds`/`setCrossfadeSettingsWithSourceBounds`/
  `removeTransition`, plus pre/post-valid seam reconciliation across geometry),
  `selectors.ts` (`docDurationFrames`, `activeClipAt`, `clipSourceFrame`,
  with all ordinary and transition still samples fixed at source frame 0,
  `resolveCrossfade` (compatibility facade over the canonical planner),
  `tracksInDisplayOrder`, `audibleTracks` (THE solo/mute mix rule) — all
  derived reads, never stored), `linking.ts` (4.3.8 linked-pair wrappers around
  the base ops — same delta to every `linkGroupId` member, atomic rollback;
  `unlinkClip` dissolves a group; Issue #12 Slice 1 adds pure
  `getLinkClipsEligibility` + `linkClips` and document-aware collision-safe
  group ids; Slice 2 exposes that operation through the canonical
  history-backed `documentStore.linkClips`; Slice 3 resolves the ephemeral UI
  pair through the same eligibility contract before dispatch; the store's
  geometry actions call these wrappers too; linked Slip also preflights every
  member so a group containing a still remains one silent no-op).
- `src/domain/crossfadePlan.ts` + `videoCompositionPlan.ts` — Issue #17 pure
  authorities for exact per-stream handles, centered grouped seams, linked
  audio availability, clip-keyed frame requests, and the shared preview/export
  paint plan. Invalid/malformed groups fall back deterministically.
- `src/domain/audioMixPlan.ts` — shared live/export audible contributors,
  virtual real-handle ranges, absolute envelopes, and bounded linear or
  equal-power gain evaluation; ordinary mute/solo/hard-cut behavior remains
  the fallback.
- `src/domain/projectSettings.ts` — authoritative project presets, strict
  settings validation, and the pure empty-document factory. Fresh documents
  own four independent video tracks followed by four independent audio tracks;
  persisted documents are never padded to that creation-time default.
- `src/domain/projectFile.ts` — versioned portable `.webcut` serialization,
  migration entry point, strict untrusted-input validation, and bounded durable
  asset metadata; excludes every session-owned field. Issue #17 advances the
  outer project format to 4 and nested timeline schema to 3 for independent
  video/audio timestamp bounds and transition audio intent. Older snapshots
  migrate conservatively; Issue #18's image-media migration still produces
  `still` `[0, 1)` without changing timed media or text semantics.
- `src/state/projectSessionStore.ts` — serializable launch/editor screen,
  active-project labels, operation phase, relink status, and separate
  save/recovery status; no Files, Blobs, URLs, parsed candidates, browser
  handles, or recovery payloads. `src/state/projectLibraryStore.ts` holds only
  serializable Recent/recovery summaries for Home.
- `src/state/transportStore.ts` — ephemeral playback/tool/selection state,
  including ordered unique `selectedClipIds` plus primary `selectedClipId`, and
  document-agnostic `reconcileClipSelection(existingIds)` for stable stale-id
  pruning, plus signed `dragPreview.deltaFrames` shared by every linked move
  participant,
  authoritative timeline `zoom`, `zoomMode`, remembered `customZoom`, and the
  translation-only `timelineOriginFrame`; selection, preset/custom zoom, and
  origin setters never enter document undo/redo history.
- `src/app/selectionReconciliationController.ts` — original Issue #12 Slice 5
  composition seam: observes document-reference changes, supplies the current
  clip-id set to transport, and keeps selection consistent without either store
  importing the other or selection entering history/persistence.
- `src/ui/Inspector.tsx` — original Issue #12 Slice 6 shared Link/Unlink command
  group: focusable `aria-disabled` controls, visible described availability,
  exact rendered-intent/latest-state race checks, live rejection announcements,
  retained primary selection, and post-Unlink focus handoff.
- `src/app/projectController.ts` — Slice 3 session composition root: validates
  candidates off-store, restores granted local handles, requests remembered
  permission only from the Open click, matches relinked media exactly,
  generation-cancels late work, and performs the awaited outgoing-session
  teardown before committing a complete new document/media session.
  `src/app/localMediaHandles.ts` owns picker types plus the origin-local media
  handle registry. `src/app/localProjectStorage.ts` owns bounded Recent and
  recovery IndexedDB records; `src/app/projectLibraryController.ts` keeps their
  handles/snapshots outside state. `src/ui/ProjectLaunch.tsx` is the Home, New
  Project, Resume, Recent, and explicit-Recovery UI facade.
- `src/pipeline/static-image-inspection.ts` — Issue #18 original Slice 1 bounded,
  content-based PNG/JPEG/WebP/AVIF inspection. It owns immutable source,
  candidate-dimension, decoded-allocation, and animation facts plus stable
  unsupported, malformed, and resource-limit failures; it imports no UI or
  state.
- `src/pipeline/static-image.ts` — atomic browser/worker first-frame decode
  seam. It reinspects the exact Blob, canonicalizes the sniffed MIME, transfers
  one caller-owned `ImageBitmap` or `VideoFrame`, validates orientation-aware
  geometry and native allocation, and owns prompt abort plus exact
  decoder/frame/bitmap cleanup.
- `src/domain/staticImage.ts` — Issue #18 bounded still-duration validation and
  exact project-rate frame conversion.
- `src/state/preferencesStore.ts` + `src/app/preferencesController.ts` — the
  persisted, versioned **Default still-image duration** preference plus the
  separate `webcut.export-selection:v1` last-known-valid export choice. Export
  capabilities, project-owned dimensions/FPS/sample rate, file capabilities,
  and output bytes are never persisted. Both preferences fail safely when
  browser storage is unavailable.
- `src/pipeline/static-image-thumbnail.ts` — one-tile image visual generator:
  contained 320×180 maximum geometry, PNG output capped at 1 MiB, and exact
  decoded-source/abort ownership.
- `src/pipeline/render.ts` — `compositeFrame(doc, frame, ctx, source, transitionSurfaceProvider)`:
  THE compositing path (preview worker in 4.1b, export in 5 — same code).
  Injected `Composite2D` ctx + `FrameSource`; Slice 4 accepts either
  `ImageBitmap` or Canvas-drawable `VideoFrame` sources without copying them.
  The concurrent fetch phase precedes synchronous draw; `{drawn, missing}`
  result and per-clip try/finally preserve source loans. Issue #17 supplies an
  explicit carried composition plan with genuine handle frames. Since Issue
  #18 original Slice 7 it paints ordinary layers directly, but renders each
  complete transformed crossfade leg into a transparent scratch, adds the
  weighted premultiplied legs inside an isolated `lighter` group, and
  source-overs that group onto lower tracks once in declared sRGB. The surface
  provider is lazy, so ordinary frames allocate no transition canvases.
- `src/pipeline/export.ts` — Phase 5.1a CFR orchestrator:
  `exportTimeline` derives length with `docDurationFrames`, composites every
  integer frame through an injected `compositeFrame`, awaits sink
  backpressure, and owns per-frame/export cleanup. Natural completion returns
  `ExportResult`; controller cancellation after iteration starts uses
  `return(undefined)`. Original Issue #18 Slice 8 observes source-request
  failures around the shared compositor: preview may still soften them to
  `missing`, while finite export rethrows the exact original typed error before
  the generic missing-media fallback.
- `src/app/exportController.ts` — Phase 5.2a composition root: snapshots the
  current document/settings/media, eagerly retains every referenced Blob, and
  passes one cached Blob/budget/kind resolver plus the identical exact
  source-bounds catalog to both Mediabunny adapter trees.
  Slice 5 uses that captured kind to branch visual export without re-reading
  mutable media state. It is the
  sole explicit generator pump, preserving the final `ExportResult` while
  making repeated/coincident cancellation one serialized `return(undefined)`.
  Only one run (including setup/cancel cleanup) may own the controller slot.
  Slice 6 preflights the pure `outputMediaAssetIds` selection first, so a
  missing output source fails with exact filenames before Blob retention,
  adapter creation, or generator startup. Asset resolver/open/decode failures
  carry typed identity to Slice 2's exact-generation compatibility seam;
  encoder/muxer/cancellation/cleanup failures remain global.
  Issue #16 snapshots the exact validated profile/destination and optional
  one-shot file capability, reserves the singleton during fresh preflight, and
  returns discriminated buffered/direct results without retaining direct-file
  bytes or handles.
- `src/app/projectController.ts` + `localMediaHandles.ts` — project activation
  installs the full descriptor catalog plus whatever connected subset is
  available. Active Relink and Scan folder are project-generation guarded,
  retain Files/handles/candidates outside Zustand, enforce bounded recursive
  enumeration, stage no long-lived scan URLs, re-inspect accepted candidates,
  preserve saved asset ids, and publish only serializable progress/ambiguity
  summaries. Slice 2 also publishes the typed compatibility report for every
  remembered/manual Resume and accepted Relink, preserving the previous settled
  report through a guarded failed/cancelled attempt. Confirmed handles are
  remembered for later automatic Resume.
- `src/domain/mediaCompatibility.ts` +
  `src/pipeline/mediaCompatibilityProbe.ts` — serializable compatibility facts
  and the content-based, metadata-only native probe. The probe checks every A/V
  track with bounded concurrency, explicit decoder configs, resource ceilings,
  exact-once Input disposal, and no object URL until Ready. Runtime facts retain
  the originating surface, optional track kind, bounded detail, and typed reason.
- `src/app/mediaCompatibilityController.ts` — Slice 2 composition seam: captures
  the exact asset object URL and compatibility request generation, projects a
  typed runtime failure onto the existing report, and atomically disconnects
  only that matching source while retaining its descriptor Offline.
- `src/codecs/mediaCodecFallbacks.ts` +
  `src/app/mediaCapabilityController.ts` — Slices 3/5 shared decoder-support
  seam and lifecycle composition root. Probe facts may be reused within one
  realm; render, filmstrip, waveform, live-audio, and export boundaries always
  revalidate exact configurations. Bounded generations/revisions reject stale
  writes, while source/runtime/fallback/page lifecycle changes invalidate facts.
  No cache state crosses into Zustand or portable project files.
- `src/app/mediaImportController.ts` — import composition root: owns selected
  Files/handles and retained retry resources outside Zustand, publishes guarded
  session compatibility requests, commits complete Ready assets exactly once,
  guards project-change/cancellation races, and owns every uncommitted object
  URL. Slice 2 adds a maximum-100 sequential multi-file queue with one active
  decode and batch cancellation. `src/app/mediaInspection.ts` routes
  byte-recognized images through real decode and configured-duration durable
  asset construction before falling unknown bytes back to the timed-media
  probe; project reconnection retains the saved descriptor duration rather than
  applying the current preference.
- `src/ui/MediaImportDialog.tsx` — accessible analysis/error/FPS-decision UI;
  exact rates, explicit choices, disabled-Match explanation, Escape handling.
- `src/ui/MediaPool.tsx` — descriptor rows plus session-only compatibility
  rows; named live statuses, wrapped container/every-track/runtime diagnostics,
  direct-import Retry/Remove versus descriptor-backed Relink actions, and
  Ready-only drag gating with a second live check at the timeline drop boundary.
  Slice 2 adds multi-file fallback import, still dimensions/duration/first-frame
  disclosure, and contained one-tile thumbnails. Slice 3 enables Ready image
  rows through both drag guards now that the still-clip domain contract exists.
- `src/ui/timeline/ClipView.tsx` + `gestureBounds.ts` — Slice 3 repeats one
  bounded still tile across the complete timeline duration, exposes a clear
  still-image accessible name/Slip explanation, gives still trims unbounded
  source headroom, and constrains still Slip to exactly zero.
- `src/ui/ExportDialog.tsx` + `ExportProfilePicker.tsx` +
  `exportProfileUi.ts` — preset-first capability-aware export UX:
  generation-safe capability feedback, validated advanced drafts and size
  estimates, download/direct-file result ownership, retry/cancellation, and
  modal accessibility. Controller and capability code load behind their app
  facades; `Toolbar.tsx` only owns trigger/open state and restores focus when
  the dialog closes.
- `src/domain/exportProfile.ts` — pure allow-list, validation, canonical
  container metadata, Compatibility/Web/Modern/HEVC catalog, and deterministic
  Modern → Web → Compatibility Auto policy. Issue #31-owned reviewed project
  dimensions plus Issue #15-owned rational FPS and sample rate are deliberately
  absent.
- `src/pipeline/export-capabilities.ts` +
  `export-mediabunny-capabilities.ts` + `export-mediabunny-profile.ts` — exact
  container/codec checks, cached hints, and disposable fresh native encoder
  preflight. Explicit unavailable selections retain their reason without
  substitution.
- `src/app/exportCapabilitiesController.ts` + `exportFilePicker.ts` — app-layer
  catalog/Auto facade and secure-context picker boundary. The picker validates
  MIME/extension before the user gesture and returns an opaque one-shot file
  capability; cancellation never starts an export.
- `src/pipeline/export-file-target.ts` — transactional direct writer:
  `StreamTarget`, at-most-1-MiB awaited positioned writes, maximum-end byte
  accounting, success-only commit, cancel/failure abort, and terminal integrity
  reporting when abort cannot prove an empty target.
- `src/ui/timeline/TimelineZoomControls.tsx` + `timelineZoom.ts` — measured
  Full/Detail/Custom geometry, exponential slider mapping, rAF-coalesced input,
  post-layout playhead anchoring, ResizeObserver updates, and the exact logical
  12-hour-or-project runway. `timelineViewport.ts` + `Timeline.tsx` project that
  runway through a whole-frame surface capped at 16,000,000px, rebase near its
  native-scroll edges without moving the logical viewport, and keep the final
  endpoint reachable. `Ruler.tsx`, clips, visuals, seams, and playhead all read
  the single transport `zoom` plus the shared translation origin.
- `src/pipeline/export-audio.ts` — exact audio scheduler/mixer: consumes the
  shared audio mix plan; maps frame boundaries and signed source↔timeline phase
  to the BigInt sample grid; overlaps virtual linked-handle legs; applies clip
  volume and absolute per-sample envelopes across 1024-sample blocks; clips
  only the final sum; and owns one sequential reader per contributor with
  exact-once cleanup. Browser codecs stay behind injected ports for Node tests.
- `src/pipeline/playback-audio.ts` — bounded live-audio scheduler: consumes the
  same plan, lazily opens Mediabunny `AudioBufferSink` cursors, and keeps only a
  rolling 0.75s lookahead. Web Audio schedules exact linear ramps or bounded
  129-point equal-power curves against the shared future anchor. The last
  cursor releases its Input; EOF, abort, pause, seek, plan edits, and terminal
  cleanup cannot reopen or retain it.
- `src/pipeline/export-mediabunny.ts` — Phase 5.1b/c/d production browser
  adapters: asset Blob/kind resolver → one Input/CanvasSink/timestamp iterator
  per video asset → lease-owned ImageBitmap copies, or one retained bounded
  frame-zero source per image asset → borrowed by every frame lease and closed
  exactly once with the export source; planned audio contributors → lazy
  AudioSampleSink cursors with streaming resampling + channel downmix. Exact
  crossfade-handle readers reject EOF, PCM gaps/discontinuity, or unavailable
  interpolation rather than synthesizing samples;
  OffscreenCanvas/CanvasSource + AudioSampleSource feed the exact validated MP4
  or WebM format with AVC/HEVC/VP9/AV1 and optional AAC/Opus. Output uses either
  `BufferTarget` or the transactional direct `StreamTarget`; the pinned
  Mediabunny patch preserves exact WebM/Opus presentation length and reopen
  metadata. Encoders are support-probed, writes honor backpressure, every media
  sample closes, and terminal cleanup is exact-once. The video
  iterator schedule and each frame-local request derive from the canonical
  visual plan; frame leases fail closed on omitted, extra, or reordered
  requests. Issue #17 replaces the frozen-endpoint transition schedule with
  genuine handle requests while preserving independent same-asset clip lanes;
  original Issue #18 Slice 8 independently passed encode/reopen/decode and
  sampled-pixel acceptance against the currently installed 1.50.9.
- `src/state/` — `documentStore` (doc + past/future undo snapshots, cap
  100; rejected ops push no entry; exact-bounds-aware transition settings and
  remove actions preserve atomic history and exact snapshot ids), `transportStore` (playhead/zoom/
  `dragPreview` — the scrub-vs-commit pattern), `mediaStore` (durable descriptor
  catalog + connected analyzed subset + visual URL ownership + exact duration
  reconformance), `previewStatusStore` (idempotent visible visual-source
  offline projection),
  and
  `mediaImportStore` (serializable dialog status only; no File/Blob handles).
- `src/workers/decode-protocol.ts` — canonical worker message types.
- `src/workers/render-protocol.ts` — render-worker message types (types only).
  The primary path sends each timed-video Blob once through `configureAsset`
  or each static-image Blob once through `openImage`, then lightweight entries
  discriminated as `video` or `image`. Video entries carry clip lane, asset,
  integer source frame, exact µs timestamp, and playback/seek mode; image
  entries carry literal frame/timestamp zero. `closed` acknowledges completed
  worker cleanup before bounded-timeout bridge termination. The deprecated
  chunk-batch messages remain only for migration tests. `setDoc` must precede
  renders built from it.
- `src/workers/render.worker.ts` — Blob-backed compositing worker: timed video
  keeps one source per asset, sequential clip-keyed playback lanes,
  request-scoped seek cursors, and a tiny timestamp cache. Original Slice 6 adds one
  retained frame-zero static source per image asset, shared across clips and
  transition layers with explicit lease identity and one aggregate 256 MiB
  reserved-and-retained still budget for the worker realm. Pending fallback
  decodes reserve conservatively before allocation, exact returned sizes are
  reconciled, and retired sources remain charged until their final loan closes.
  Monotonic setup identities prevent stale ACK/errors from settling a reopened
  asset. Open revisions and abort signals reject
  superseded work; replacement, release, failure, cancellation, and worker
  close retire and close the source exactly once. All sources feed
  `compositeFrame` on a scratch canvas; newest-only blit uses double buffering.
  Original Slice 7 adds one lazy worker-owned leg/group surface pair, reused
  and cleared for transition frames and resized with the document canvas.
  Superseded presentation never cancels a healthy playback lane.
- `src/workers/decode.worker.ts` — injectable core (`createDecodeWorkerCore`);
  closes every VideoFrame ASAP, caches ImageBitmap copies (12) instead
  (raw frames starve the hw decoder pool!), backpressure at queue≥8,
  latest-wins seeks, catch-all error reporting.
- `src/engine/frame-cache.ts` — LRU with single-owner close discipline.
- `src/engine/worker-bridge.ts` — `DecodeWorkerBridge(worker)` +
  `setSource(rate, provider)` + `renderFrameAt(frame) → RenderResult`
  ('drawn'|'missed'|'superseded'|'error'; never rejects).
- `src/pipeline/demux.ts` — Mediabunny loadAsset + decoderConfig (de)serialize;
  records canonical integer-microsecond duration and conforms playable frames
  to the active document rate.
- `src/pipeline/visuals.ts` — filmstrip/waveform image generators (4.3.7):
  mediabunny CanvasSink / AudioBufferSink (streamed chunks, peaks fold on
  the fly — full PCM never held); images span the asset's FULL duration
  (integer-frame filmstrip buckets + vector waveform mapping). Pure math
  unit-tested; shells browser-only.
  Wired by `src/app/mediaVisualsController.ts` (3rd composition root):
  one generation per asset, no retries, mediaStore owns the result URLs;
  project-generation guards revoke stale results even when a new project
  reuses the same durable asset id.
- `src/pipeline/decode.ts` — keyframe walk in decode order (B-frame safe,
  `verifyKeyPackets`, bounded overshoot, bytes copied for transfer).
- `src/engine/render-bridge.ts` — main-thread half of the render worker: keeps
  the posted doc and per-asset source kind/rate, hands each Blob to the worker
  once, then maps canonical visual layers to clip-keyed source-frame/µs
  requests with an explicit playback/seek mode. Static entries always carry
  frame zero/timestamp zero and never create timed playback lanes. Request ids
  remain latest-wins for presentation; `onAssetReady`/`onWorkerError` are the
  controller hooks. Disposal waits for the worker's cleanup acknowledgment,
  then uses a bounded timeout fallback with exact-once termination. The old
  encoded-batch overload is deprecated and not used by preview.
- `src/app/previewController.ts` — THE COMPOSITION ROOT: only place stores
  meet engine/pipeline; DI seams for tests; idempotent per canvas
  (StrictMode). It keeps connected timed videos warm, but opens an analyzed
  image Blob only while at least one clip in the active document references
  that asset. Shared references produce one open; the final reference removal
  releases it. It forwards doc snapshots and sends rAF-coalesced document
  frames with playback/seek mode; re-renders on doc change + assetConfigured
  (=the whole missing-clip retry policy). Typed runtime failures preserve
  video/image identity without pretending images have timed-video tracks.
- `src/app/transportController.ts` — second composition root (same
  pattern): primes issue #5 live audio from immutable document/media snapshots,
  resumes AudioContext inside the click gesture, gives PlaybackEngine the exact
  audio anchor, and restarts only when the audible plan/assets change. Pause,
  scrub, step, failure, and disposal share generation-safe cleanup;
  `disposeTransport()` now awaits pending startups, session stops, and context
  close so project replacement cannot revoke a Blob still used by old audio.
  `src/engine/playback-engine.ts` is the pure loop: injected audio clock/ticks,
  floor + 1e-6 NTSC epsilon, newest-frame-only emission, and an exclusive end
  boundary that preserves the final frame's duration. UI facade:
  `src/ui/TransportBar.tsx` (subscribes to isPlaying only).
- `src/ui/` — components read state only; `timeline/useScrubScheduler.ts`
  = rAF coalescing reused by ruler + clip drag; `dnd.ts` = MediaPool→Track
  drag payload contract + asset-kind↔track-kind gating (kind policy lives
  here because domain/ can't see assets). `timeline/Ruler.tsx`: 12h min
  logical runway, ticks VIRTUALIZED against the `[data-timeline-scroll]`
  ancestor (app shell marks it; bare tests get a fallback window), and local
  positions relative to the bounded timeline origin; the logical endpoint
  always gets a right-anchored end label in the last physical window.
- `src/ui/timeline/gestureBounds.ts` — pure Slice 7 pointerdown interval
  intersection across the gesture owner and linked partner, using one fresh
  document/media snapshot for timeline, source, duration, and headroom
  bounds in both connected and offline sessions.
- `src/ui/timeline/ClipView.tsx` — the 4.2 gesture heart: one session ref
  routes body/edge pointerdowns by the CURRENT tool (getState(), not the
  render closure!); previews via transportStore.editPreview, one commit
  per gesture; slip clamps live against mediaStore asset bounds. Slice 7 keeps
  the immutable pointerdown document reference in that session, clears its
  preview if the document changes, and skips any stale pointerup commit.
  Slice 6 keeps the clip root a stable pressed button, preserves independent
  focus/selected/primary visuals, hides decorative link badges from its
  accessible name, and highlights every live linked-preview participant. Long clips
  render only their intersection with the bounded window; filmstrip buckets
  and the normalized waveform viewBox remain aligned to the original source.
  `ui/Toolbar.tsx` = tool buttons; `app/useEditShortcuts.ts` = A/B/T/Y/U,
  S split-at-playhead, Delete ripple-delete (selection kept on reject).
- `src/ui/timeline/Timeline.tsx` + `TrackHeader.tsx` (4.3.5) — two
  sticky-aligned columns [headers gutter | lanes]: the LANES column's
  left edge stays the x-origin for frame 0, so all px→frame math ignores
  the gutter; rows pair up by identical height+border. Headers show
  badge/kind/count + hide/mute/lock (documentStore.setTrackFlags) and
  "+ Video"/"+ Audio" (addTrack). Tracks render in domain
  tracksInDisplayOrder (videos reversed = top composite layer first,
  then audios) — doc order stays compositing order.
- `src/ui/MediaPool.tsx` + `MediaRelinkDialog.tsx` + `Preview.tsx` +
  `timeline/ClipView.tsx` — Slice 6 offline UI: descriptor-driven media rows,
  per-source Relink, one folder scan, focus-trapped ambiguity confirmation,
  current-frame Preview guidance, and finite labeled offline clips. Offline
  rows cannot be dragged; text clips remain intentionally extendable. Media
  Pool also exposes the persisted future-import still-duration preference.
  Issue #18 original Slice 6 treats video and image descriptors as visual
  sources in Preview guidance while keeping the canvas state-only and
  resource-free.
- `src/ui/timeline/Track.tsx` + `TransitionSeam.tsx` — Track derives eligible
  touching video cuts from its committed snapshot; each seam marker opens an
  accessible temporary form for exact duration, linked-audio intent, curve,
  independent visual/audio availability, and Add/Apply/Remove. Pointer/key
  events stop before clip gestures/global shortcuts, while one complete
  settings payload reaches the documentStore per successful submit.

## Invariants that must survive refactors

1. Integer frames everywhere; seconds only at codec/clock boundaries.
2. Every VideoFrame/AudioSample closed the moment its pixels/samples are
   copied, except an explicitly retained render source whose bounded owner
   loans it without copying and closes it on replacement/release/shutdown.
   ImageBitmaps in caches close on evict/clear. One owner at all times.
3. Rejected domain ops return the SAME doc reference (callers detect via
   `===`; store pushes no history).
4. Scrubbing/dragging writes transportStore only; pointerup commits ONE
   documentStore action.
5. Latest-wins at every async layer (bridge requestIds + worker generation).
6. Render isolation: playhead movement re-renders Playhead + Preview only —
   enforced by `<Profiler>` tests in `timeline.test.tsx`/`clipdrag.test.tsx`.

## Hard-won lessons (do not relearn these)

- **jsdom lies.** Three real bugs shipped past 127 green tests and were
  caught only by driving the actual browser: (1) bare `SharedArrayBuffer`
  reference → ReferenceError on normal pages; (2) `VideoDecoder.reset()`
  UNCONFIGURES the codec (reconfigure after every reset — see
  `resetDecoder`); (3) caching raw VideoFrames exhausted the hardware
  decoder's output pool → one-frame-per-eviction crawl. Always browser-
  verify pipeline changes (preview tools + `window.__stores`).
- **Pointer capture is not gesture truth.** Gate pointermove on your own
  session ref; capture is best-effort enhancement (it silently fails).
- **Route event handlers by getState(), not render closures.** A keypress
  can switch the tool in the same tick as a pointerdown — the 4.2 browser
  pass caught the razor routing as 'select' because the handler read the
  subscribed (stale) tool value.
- **erasableSyntaxOnly** bans constructor parameter properties
  (`constructor(private x…)`) — declare fields explicitly. Bit us twice.
- **Windows/PowerShell:** multiline commit messages via file +
  `git commit -F <file>` (heredocs get mangled); tests may pass while
  `tsc -b` fails — always run both. NEVER edit source files via
  Get-Content/Set-Content pipelines: PS 5.1 reads BOM-less UTF-8 as ANSI
  and mangles every non-ASCII char (µ, —, →). Use real editor tools.
- Fake decoders/browsers in tests must model REAL semantics (queue growth,
  reset-unconfigures, flush-emits) or they green-light bugs.
- **CanvasSink.getCanvas is not a persistent decoder.** In Mediabunny 1.50.3
  every call creates a new timestamp iterator and decoder. Sequential export
  must keep one `canvasesAtTimestamps` iterator alive per asset; a focused fake
  that only records `getCanvas` calls will miss catastrophic decoder churn.
- **Naive complementary Canvas2D alpha makes a crossfade dip dark.** With
  source-over, drawing outgoing at `1-p` and incoming at `p` attenuates the
  outgoing pixels twice. Issue #17/#18 render both complete legs into bounded
  transparent surfaces, add their premultiplied weighted pixels inside one
  isolated group, then source-over the group once. Never reintroduce direct
  scalar-alpha draws or reconstruct a group outside the canonical plan.
- **Never fake transition handles.** Exact persisted video/audio timestamp
  bounds are the authority. Timed visual legs request genuine pre/post frames;
  linked audio readers fail closed on missing PCM. `unknown`, absent,
  insufficient, or ambiguous sources keep deterministic ordinary fallback
  behavior and a visible reason instead of clamping, freezing, or zero-padding.
- **Transitions belong to seams, not clip bodies.** Geometry edits retain a
  transition only when its same track-scoped definition was valid before and
  remains valid after; otherwise they discard it without rejecting the edit.
  This prevents stale project data from waking up when a later ripple happens
  to repair its geometry. Split is the deliberate exception: the original id
  stays on the left half, so an outgoing seam must rebind to the new right id.
- **Transition duration needs an explicit submit, not blur commit.** Clicking
  Remove moves focus away from a dirty number input before its click handler
  runs; a blur-based duration commit would create one unintended history entry
  and then a second removal entry. 5.1e-3 uses explicit Add/Apply buttons and a
  temporary popover, which also lets a seam retry a shorter duration when its
  default would overlap a neighboring crossfade.
- **Audio fade phase is absolute, never block-local.** Live decode windows and
  1024-sample export blocks may begin anywhere inside a crossfade. Derive gain
  from the contributor's complete envelope start/end and absolute timeline
  frame/sample; restarting progress at each buffer produces audible steps and
  preview/export drift. Equal-power automation stays on the tested bounded
  129-point curve unless its error/ownership gates are replaced explicitly.
- **AAC payload length is not timeline duration.** Chrome encodes whole
  1024-sample AAC packets: 48,048 submitted NTSC samples decode to a 48,128-
  sample payload. In locked Mediabunny 1.50.3, `onEncodedPacket` runs
  synchronously immediately before the same packet object reaches the MP4
  muxer; 5.1c clamps only the final packet's container duration so the audio
  track ends at the exact rational sample boundary (1.001s in the browser
  gate). Re-verify this version-coupled callback ordering before any upgrade.
- **Fractional samples/frame need one stable clip phase.** Independently
  rounding `sourceRange.startFrame` for every clip makes NTSC razor halves
  overlap or gap by one sample. Derive a signed source-minus-timeline phase
  once per clip; because split/start-trim advance both starts equally, the
  phase survives the edit and the source stream remains sample-identical.

## Dev/test toolbox

- `window.__stores.{document,transport,media,mediaImport,projectSession}` — dev-only Zustand handles
  (seed docs, read JSON, drive undo from the console or preview_eval).
- `ffmpeg`/`ffprobe` are installed as of 2026-07-12. They generated and probed
  the 5.2b A/V fixture/result; keep the in-browser generator below when a test
  needs a same-origin `File` without touching disk.
- `npm run qa:issue18:fixtures` regenerates Issue #18's ignored deterministic
  18-file PNG/JPEG/WebP/AVIF, animation-header, rotated/mirrored EXIF,
  spoofed, malformed,
  truncated, oversized, SVG, and GIF matrix plus `manifest.json` under
  `.tmp/issue-18-image-fixtures/`; add `-- --validate-only` to fail when fixture
  bytes, hashes, structural facts, or expected outcomes drift.
- `npm run qa:issue19:fixtures` regenerates Issue #19's ignored 13-file native,
  fallback, unknown, malformed, truncated, spoofed, empty, and random-byte
  matrix plus a hash/ffprobe manifest under `.tmp/issue-19-codec-fixtures/`;
  it exits nonzero when the expected container/codec/damage matrix drifts.
- Generate a labeled test MP4 IN THE BROWSER:
  import mediabunny via `/@fs/E:/ClaudeSpace/WebCut/node_modules/mediabunny/dist/modules/src/index.js`,
  `Output` + `Mp4OutputFormat` + `BufferTarget` + `CanvasSource`, draw
  frame numbers, `File` it, then `DataTransfer` into a file input.
  For a clean-console gate, generate it first in a same-origin non-app page
  (for example `/src/index.css`) and navigate to `/` before creating the File;
  importing that raw module after the bundled app is already loaded triggers
  Mediabunny's duplicate-instance warning even without a cache-bust query.
- Synthetic gestures: dispatch `PointerEvent`s with `bubbles: true`
  directly on elements (preview_click does NOT produce pointer events).
  DnD: real `new DataTransfer()` + `DragEvent` work in Chrome; jsdom has
  NEITHER (only PointerEvent), so `test/setup.ts` polyfills DragEvent as a
  MouseEvent subclass — without it drop clientX silently becomes undefined
  and tests green-light broken frame math.
- Preview server: `npm run dev` uses :5173 by default; Vite also reads `PORT`
  (vite.config) so external launch profiles can assign an isolated port.
- HMR of worker files fully reloads the page (in-page state like
  `__testFile` dies); module-map caches stale plain-URL imports —
  cache-bust probes with `?probe=N` (this double-instances mediabunny →
  its "loaded twice" console warning; harness artifact, ignore).

## Open items (beyond PLAN.md phases)

- Issue #32 is complete. PR #37 was reviewed at `b131436`, normally merged as
  `daf3a6e`, and GitHub closed the issue as completed. The sole fresh-project
  factory now creates persisted `V1`–`V4` followed by `A1`–`A4`; the timeline
  displays the video stack as `V4` through `V1`, then audio `A1` through `A4`.
  Resume, recovery, migration, and project-file schemas are unchanged, and the
  next manual additions remain `V5` and `A5`. The 157-test focused gate,
  1,661-test full gate, build, oxlint, audit, and diff checks passed. At
  1280 × 720, in-app Chromium kept all eight header/lane pairs aligned inside
  the timeline's vertical scroller, exposed 28 named track controls without
  page overflow, added `V5`/`A5`, and reported zero console warnings or errors.
- Issue #31 implementation and acceptance are complete. The creation screen
  now offers Horizontal 16:9, Vertical 9:16, Square 1:1, and Social portrait
  4:5 at exact 720/1080/1440/2160 tiers while preserving the chosen tier when
  the family changes. Only width/height enter `TimelineDoc`; no project-file
  migration or duplicate aspect-ratio field was introduced. Resume and Export
  derive their labels from those exact dimensions. The 183-test focused gate,
  1,659-test full gate, build, oxlint, audit, and diff checks passed. In-app
  Chromium created all four monitor shapes, verified the 2160 × 3840 portrait
  render canvas and fixed Export label, kept the 720px setup screen within its
  viewport, and reported zero console warnings or errors.
- Issue #16 completed at 1,632/1,632 tests across 86 files. PR #29 was reviewed
  at `ea5ccfb`, normally merged as `edb02d0`, and the issue was closed with its
  checklist and fallback no-go reconciled. Auto resolves in the
  documented Modern → Web → Compatibility order, HEVC remains explicit-only,
  and every concrete configuration is capability-probed without substitution.
  The Windows Chrome 150 gate passed all four profiles, both output
  destinations, exact A/V reopen/playback, advanced audio/video variants,
  cancellation/write-failure/retry, and bounded direct-file memory with a clean
  console. Optional local AAC, Opus, VP9, AV1, AVC, and HEVC encoders were
  researched and rejected for this slice because they failed required semantic,
  maturity, size/integration, lifecycle, or licensing/provenance boundaries.
  `npm audit --omit=dev --audit-level=high` reported 0 vulnerabilities. Issue
  #31 owns the reviewed creation-time dimension catalog; Issue #15 remains the
  authority for project FPS and sample rate.
- Issue #19 closed 2026-07-20 as implementation-complete at 46/49. Import,
  Resume/Relink, runtime feedback, bounded ProRes and AC-3/E-AC-3 fallbacks,
  explicit partial-track consent, capability caching/revalidation, prompt
  cancellation, exact disposal, the real codec/damage matrix, and Chrome/Edge
  gates are complete. The three unchecked proxy implementation children are
  intentionally rejected by the measured no-go decision; do not imply an
  in-app converter exists. Public-distribution licensing/notices and
  representative low-memory certification remain separate release work.
- Slices 4–6 now cover portable Save/Save As,
  permission-aware automatic source reconnection, removable Recent shortcuts,
  open-offline sessions, individual/folder relinking, live save after a writable
  grant, and explicit bounded recovery journals. These origin-local sidecars
  are convenience, not portable bundled media; recovery stores no source
  bytes. A resumed project remains read-only until one Save or Save As grant.
  Multi-tab recovery ownership is not coordinated yet, so do not edit/discard
  the same journal from two tabs. Any future media caching needs explicit
  opt-in, quota/eviction UX, and a separate security/storage review.
- Issue #12 follows the original seven-slice blueprint; the older local
  “Slice 3/4” labels were compressed commit notes, not authoritative
  renumbering. All seven original slices are complete. The pure manual-link
  contract, canonical one-entry store action, exact undo/redo identity,
  reconciled ephemeral pair selection, accessible Link/Unlink controls,
  unequal-edit matrix, and signed owner-relative previews are all in place.
  Track removal can no longer create an orphan group: it dissolves every lone
  unlocked survivor in the same history entry, while a locked survivor rejects
  the whole operation by reference. `gestureBounds.ts` intersects every linked
  participant’s timeline, source, duration, and headroom interval from one
  fresh pointerdown document/media snapshot. A gesture retains that exact
  document reference; a mid-gesture document replacement clears the preview
  and skips the stale pointerup commit. Collision safety remains enforced by
  the canonical domain operation at commit, with rejection snapping the
  previews back and adding no history.
  Selection reconciliation prunes only missing ids after delete, split undo,
  track removal, or project replacement; it preserves survivor order/primary,
  never resurrects on undo, and leaves document history and portable
  serialization untouched. Link accepts exactly one unlinked video and one
  unlinked audio clip in either selection order. Unequal assets, ranges, and
  offsets are supported; redo restores the exact authored group id; every
  rejection preserves even a populated redo branch. Focusable pressed clip
  controls, visible described reasons, latest-state race checks, badges,
  partner highlighting, retained selection/primary, keyboard activation, and
  post-Unlink focus handoff complete the acceptance surface.
  Final verification passed 359 focused Issue #12 tests across 12 files and
  1,209 total tests across 66 files. Build passed with only the known three
  chunks above 500 kB; lint passed; `npm audit --omit=dev` reported 0
  vulnerabilities; diff checking was clean apart from informational
  line-ending notices.
  Real Chrome 150 at 1600×1000 passed the final gate through the supported file
  input fallback with an actual 2.0 s 320×180 30 fps H.264 + mono 48 kHz AAC
  fixture. Import reached Ready and dropped the linked pair. Deleting V1
  dissolved A1’s lone link and Ctrl+Z restored both V1 and the pair. After
  Unlink, an audio head trim changed the timeline/source/duration tuple from
  20/0/60 to 30/10/50 while V1 stayed
  20/0/60; keyboard pair selection and Link restored the unequal-offset pair.
  A live +15 move rendered 35/45 while the document remained 20/30 and history
  remained at 4; release added exactly one entry at 35/45 with offset 10.
  Ctrl+Z restored 20/30 and Ctrl+Y restored 35/45. Keyboard activation then
  performed the final Unlink. Playback at timeline frame 62 mapped both clips
  to source frame 27, rendered the real video, and reported 35 live audio nodes
  with RMS 0.0898. Chrome recorded 0 warnings and 0 errors. All 30 GitHub #12
  checklist items now have matching code, test, and browser evidence for the
  normal-merge closeout.
- `decode.worker.ts` + `DecodeWorkerBridge` are RUNTIME-DEAD since 4.1c
  (the render worker replaced the single-asset path). Kept because their
  tests document the decoder semantics and render.worker imports their
  structural types. Remove or repurpose only as an explicit post-MVP cleanup.
- Inspector number inputs render locale decimal separators (e.g. "1,5")
  — display-only browser behavior; committed doc values are plain floats.
  Revisit only if locale typing ever reports badInput problems.
- Issue #17/#18 transition rendering, exact handle planning, audio-aware domain
  authoring, atomic store actions, accessible seam settings, live Web Audio,
  and export parity are complete. The shared isolated premultiplied group
  handles transformed, transparent, intrinsic-opacity, still↔video,
  video↔still, and still↔still dissolves. Valid unique aligned linked audio uses
  the selected curve in preview/export; unavailable audio explains and falls
  back without weakening the visual seam or inventing samples. The minimal UI
  intentionally surfaces currently eligible seams; a malformed serialized
  transition whose endpoints are missing/gapped/text has no cleanup marker
  yet, although the store's remove action can still delete it.
- Matching a source FPS intentionally stops being available once any clip is
  on the timeline. Supporting that later requires an explicit retime operation
  for clip ranges, source ranges, transitions, playhead, and undo history; it
  must not be smuggled into import-time rounding.

## Working agreements (the user's explicit preferences)

- Changes may span every module needed for one complete fix. Keep dependency
  boundaries clear and verify logical steps separately; never skip a phase
  gate; commit with the message file + `-F` pattern, authored as Aryel only;
  never add AI co-author or attribution trailers.
- End-of-turn summaries: SHORT, plain words, low jargon (user has AuADHD —
  dense dumps fog them; they like emoji and warmth). Deep detail belongs in
  commits/docs, not the summary.
- Be honest about mistakes and rejected-first-try test runs; the user
  values the "honest notes" sections.
