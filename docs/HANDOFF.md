# WebCut — Session Handoff

Read this first in a new session. It is the deep context; [PLAN.md](PLAN.md)
records the completed MVP roadmap and gates; [../ARCHITECTURE.md](../ARCHITECTURE.md)
holds the binding rules. Post-MVP work comes from explicitly selected issues
and the open list below.

## Status (2026-07-19)

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

1,042 tests green · `npm run build` passes with the known large-chunk warning
(1.144 MB lazy AC-3 chunk; existing app chunk also exceeds 500 kB) ·
`npm run lint` clean · every phase
committed separately (see `git log --oneline`). The user completed the
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
Phase 5.2b exposes that controller through the Toolbar: one honest fixed-profile
modal shows the current timeline resolution, MP4/H.264, and 8 Mbps; progress is
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

**Next: keep Issue #19 open and ask before selecting its next slice.** Remaining
work is explicit partial-track consent, capability caching, optional
user-consented proxy conversion, broader browser/codec fixtures, and the final
distribution/security review. Future project-storage work is also separate
opt-in media caching with quota/eviction UX and multi-tab recovery ownership;
do not imply recovery or a portable `.webcut` contains source bytes today.

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
active media session. Import video or audio in the Media Pool; files are
analyzed before they appear.
An FPS mismatch opens an explicit
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
entry; undo re-links). Transform and volume stay per-half on purpose. The full editing
toolset (4.2): toolbar buttons or A/B/T/Y/U — select (click selects, body
drag moves horizontally or between same-kind lanes with snap-back on illegal
drops, edge drag trims), razor
(click cuts at the pointer frame), ripple trim (edges; downstream
follows), slip (source shifts under a fixed clip, live-clamped to the
asset, delta badge), slide (touching neighbors absorb). S splits under
the playhead, Delete/Backspace ripple-deletes the selection, ←/→ steps
the playhead one frame, empty-lane click deselects. Transition authoring
(5.1e-3): each touching adjacent non-text video seam shows a tiny `+` marker;
its popover chooses an integer frame duration before Add. An authored seam
shows `CF`; the same popover explicitly Applies a new duration or Removes the
crossfade. Domain rejection stays visible in the popover so a shorter duration
can be tried, locked tracks disable the marker, and each successful button is
exactly one undo entry. The Toolbar's Export button (5.2b) opens a native modal
with the timeline's fixed resolution and the MVP MP4/H.264 profile. Start shows
real progress; Cancel drains cleanup before reporting cancellation; success
offers an explicit `.mp4` download and keeps its object URL alive until the
flow closes or resets. The Inspector (4.3)
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
while locked), and audio rows have SOLO next to mute — while any
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

- `src/domain/` — `schema.ts` (types, half-open TimeRange, rational rates),
  `time.ts` (conversions incl. exact integer microseconds,
  `snapToStandardRate`, `formatTimecode`),
  `operations.ts` (pure edits; REJECT = same doc reference + console.warn;
  5.1e-1 track-scoped `addCrossfade`/`setCrossfadeDuration`/
  `removeTransition`, plus pre/post-valid seam reconciliation across geometry),
  `selectors.ts` (`docDurationFrames`, `activeClipAt`, `clipSourceFrame`,
  `resolveCrossfade` (canonical centered-window geometry),
  `visibleVideoLayersAtFrame` (THE preview/export visual plan),
  `tracksInDisplayOrder`, `audibleTracks` (THE solo/mute mix rule) — all
  derived reads, never stored), `linking.ts` (4.3.8: linked-pair
  wrappers around the base ops — same delta to every linkGroupId
  member, atomic rollback; unlinkClip dissolves a group; the store's
  geometry actions call THESE, not the base ops).
- `src/domain/projectSettings.ts` — authoritative project presets, strict
  settings validation, and the pure empty-document factory.
- `src/domain/projectFile.ts` — versioned portable `.webcut` serialization,
  migration entry point, strict untrusted-input validation, and bounded durable
  asset metadata; excludes every session-owned field.
- `src/state/projectSessionStore.ts` — serializable launch/editor screen,
  active-project labels, operation phase, relink status, and separate
  save/recovery status; no Files, Blobs, URLs, parsed candidates, browser
  handles, or recovery payloads. `src/state/projectLibraryStore.ts` holds only
  serializable Recent/recovery summaries for Home.
- `src/state/transportStore.ts` — ephemeral playback/tool/selection state plus
  authoritative timeline `zoom`, `zoomMode`, remembered `customZoom`, and the
  translation-only `timelineOriginFrame`; preset/custom zoom and origin setters
  never enter document undo/redo history.
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
- `src/pipeline/render.ts` — `compositeFrame(doc, frame, ctx, source)`:
  THE compositing path (preview worker in 4.1b, export in 5 — same code).
  Injected `Composite2D` ctx + `FrameSource`; concurrent fetch phase, then
  synchronous draw; `{drawn, missing}` result; per-clip try/finally. Since
  5.1d it paints the selector's ordered ordinary/crossfade layers rather than
  re-deriving active clips.
- `src/pipeline/export.ts` — Phase 5.1a CFR orchestrator:
  `exportTimeline` derives length with `docDurationFrames`, composites every
  integer frame through an injected `compositeFrame`, awaits sink
  backpressure, and owns per-frame/export cleanup. Natural completion returns
  `ExportResult`; controller cancellation after iteration starts uses
  `return(undefined)`.
- `src/app/exportController.ts` — Phase 5.2a composition root: snapshots the
  current document/settings/media, eagerly retains every referenced Blob, and
  passes one cached asset resolver to both Mediabunny adapter trees. It is the
  sole explicit generator pump, preserving the final `ExportResult` while
  making repeated/coincident cancellation one serialized `return(undefined)`.
  Only one run (including setup/cancel cleanup) may own the controller slot.
  Slice 6 preflights the pure `outputMediaAssetIds` selection first, so a
  missing output source fails with exact filenames before Blob retention,
  adapter creation, or generator startup. Asset resolver/open/decode failures
  carry typed identity to Slice 2's exact-generation compatibility seam;
  encoder/muxer/cancellation/cleanup failures remain global.
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
- `src/app/mediaImportController.ts` — import composition root: owns selected
  Files/handles and retained retry resources outside Zustand, publishes guarded
  session compatibility requests, commits complete Ready assets exactly once,
  guards project-change/cancellation races, and owns every uncommitted object
  URL. `src/app/mediaInspection.ts` now exposes the same typed probe result to
  import and project reconnection callers.
- `src/ui/MediaImportDialog.tsx` — accessible analysis/error/FPS-decision UI;
  exact rates, explicit choices, disabled-Match explanation, Escape handling.
- `src/ui/MediaPool.tsx` — descriptor rows plus session-only compatibility
  rows; named live statuses, wrapped container/every-track/runtime diagnostics,
  direct-import Retry/Remove versus descriptor-backed Relink actions, and
  Ready-only drag gating with a second live check at the timeline drop boundary.
- `src/ui/ExportDialog.tsx` — Phase 5.2b fixed-profile export UX: controller
  code loads only on Start; progress is frame-coalesced; cancellation and retry
  are explicit states; Blob URL/download ownership, filename safety, modal
  focus, and shortcut isolation stay local to the UI. `Toolbar.tsx` only owns
  the trigger/open state and restores focus when the dialog closes.
- `src/ui/timeline/TimelineZoomControls.tsx` + `timelineZoom.ts` — measured
  Full/Detail/Custom geometry, exponential slider mapping, rAF-coalesced input,
  post-layout playhead anchoring, ResizeObserver updates, and the exact logical
  12-hour-or-project runway. `timelineViewport.ts` + `Timeline.tsx` project that
  runway through a whole-frame surface capped at 16,000,000px, rebase near its
  native-scroll edges without moving the logical viewport, and keep the final
  endpoint reachable. `Ruler.tsx`, clips, visuals, seams, and playhead all read
  the single transport `zoom` plus the shared translation origin.
- `src/pipeline/export-audio.ts` — Phase 5.1c exact audio scheduler/mixer:
  BigInt frame→sample boundaries; split/trim-stable signed source↔timeline
  phase; `audibleTracks` selection; clip volume; 1024-sample bounded stereo
  blocks; post-sum clipping;
  one active sequential reader per audible clip; exact-once reader/source
  cleanup. Browser codecs stay behind injected ports for Node tests.
- `src/pipeline/playback-audio.ts` — issue #5 bounded live-audio scheduler:
  derives clip plans from `audibleTracks`, lazily opens Mediabunny
  `AudioBufferSink` cursors, and keeps only a rolling 0.75s lookahead. Web
  Audio owns per-clip gain, resampling, mixing, analyser diagnostics, and the
  shared future anchor. The last cursor releases its Input; EOF, abort, pause,
  seek, muted-plan changes, and terminal cleanup cannot reopen or retain it.
- `src/pipeline/export-mediabunny.ts` — Phase 5.1b/c/d production browser
  adapters: asset Blob resolver → one Input/CanvasSink/timestamp iterator per
  video asset → lease-owned ImageBitmap copies; active audio clips → lazy
  AudioSampleSink cursors with streaming resampling + channel downmix;
  OffscreenCanvas/CanvasSource + AudioSampleSource → AVC/AAC-in-MP4
  BufferTarget. Both encoders are support-probed, writes honor backpressure,
  every media sample closes, and terminal cleanup is exact-once. The video
  iterator schedule and each frame-local request derive from the canonical
  visual plan; frame leases fail closed on omitted, extra, or reordered
  requests. Locked Mediabunny 1.50.3 handles the same-asset non-monotonic
  sequence created by a frozen-endpoint crossfade (browser-proven in 5.1d).
- `src/state/` — `documentStore` (doc + past/future undo snapshots, cap
  100; rejected ops push no entry; 5.1e-2 transition add/duration/remove
  actions preserve exact snapshot ids), `transportStore` (playhead/zoom/
  `dragPreview` — the scrub-vs-commit pattern), `mediaStore` (durable descriptor
  catalog + connected analyzed subset + visual URL ownership + exact duration
  reconformance), `previewStatusStore` (idempotent visible-offline projection),
  and
  `mediaImportStore` (serializable dialog status only; no File/Blob handles).
- `src/workers/decode-protocol.ts` — canonical worker message types.
- `src/workers/render-protocol.ts` — render-worker message types (types only).
  The primary path sends each asset Blob once, then lightweight entries with
  clip lane, asset, integer source frame, exact µs timestamp, and playback/seek
  mode. The deprecated chunk-batch messages remain only for migration tests.
  `setDoc` must precede renders built from it.
- `src/workers/render.worker.ts` — Blob-backed compositing worker: one source
  per asset; sequential, clip-keyed lanes for playback; request-scoped cursors
  for seeks; tiny timestamp cache; FrameSource → compositeFrame on a scratch
  canvas; newest-only blit via double buffering. Superseded presentation never
  cancels a healthy playback lane, while discontinuities and every terminal
  path close frames/cursors/sources exactly.
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
  the posted doc and per-asset rates, hands each Blob to the worker once, then
  maps canonical visual layers to clip-keyed source-frame/µs requests with an
  explicit playback/seek mode. Request ids remain latest-wins for presentation;
  `onAssetReady`/`onWorkerError` are the controller hooks. The old encoded-batch
  overload is deprecated and not used by preview.
- `src/app/previewController.ts` — THE COMPOSITION ROOT: only place stores
  meet engine/pipeline; DI seams for tests; idempotent per canvas
  (StrictMode). It fetches each already-analyzed asset Blob, hands it to the
  worker once, releases removed assets, forwards doc snapshots, and sends
  rAF-coalesced document frames with playback/seek mode; re-renders on doc
  change + assetConfigured (=the whole missing-clip retry policy).
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
- `src/ui/timeline/ClipView.tsx` — the 4.2 gesture heart: one session ref
  routes body/edge pointerdowns by the CURRENT tool (getState(), not the
  render closure!); previews via transportStore.editPreview, one commit
  per gesture; slip clamps live against mediaStore asset bounds. Long clips
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
  rows cannot be dragged; text clips remain intentionally extendable.
- `src/ui/timeline/Track.tsx` + `TransitionSeam.tsx` (5.1e-3) — Track derives
  eligible touching video cuts from its committed snapshot; each seam marker
  subscribes only to zoom and opens a temporary Add/Apply/Remove duration
  form. Pointer/key events stop before clip gestures/global shortcuts, while
  all writes stay on the documentStore transition actions.

## Invariants that must survive refactors

1. Integer frames everywhere; seconds only at codec/clock boundaries.
2. Every VideoFrame/AudioSample closed the moment its pixels/samples are
   copied; ImageBitmaps in the ring buffer, closed on evict/clear. One owner
   at all times.
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
  outgoing pixels twice. 5.1d paints outgoing first with compensated alpha,
  then incoming, which gives an exact linear dissolve for ordinary opaque
  full-frame footage. General transformed/transparent cross-dissolves need
  offscreen isolation; do not silently generalize this formula.
- **Frozen transition endpoints make one asset seek backward.** With no
  source-handle metadata, 5.1d repeats the outgoing last frame and incoming
  first frame around the cut. A single asset can therefore produce a
  non-monotonic `canvasesAtTimestamps` sequence. Mediabunny 1.50.3 supports
  that path, but keep the real-browser seek/backtrack gate when upgrading it.
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

- Issue #19 remains open after Slice 3. Import, remembered/manual Resume,
  individual/folder Relink, and confirmed preview/visuals/audio/export source
  failures now share guarded compatibility reports and fail-closed timeline
  entry. ProRes and AC-3/E-AC-3 have bounded, locally bundled, lazy fallbacks
  across every decode surface. Still separate: explicit partial-track import
  consent, capability caching, user-consented proxy conversion, the broader
  browser/codec fixture matrix, and final distribution/security review. Do not
  imply those later paths exist yet.
- Slices 4–6 now cover portable Save/Save As,
  permission-aware automatic source reconnection, removable Recent shortcuts,
  open-offline sessions, individual/folder relinking, live save after a writable
  grant, and explicit bounded recovery journals. These origin-local sidecars
  are convenience, not portable bundled media; recovery stores no source
  bytes. A resumed project remains read-only until one Save or Save As grant.
  Multi-tab recovery ownership is not coordinated yet, so do not edit/discard
  the same journal from two tabs. Any future media caching needs explicit
  opt-in, quota/eviction UX, and a separate security/storage review.
- A/V pairs from one drop ARE linked since 4.3.8 (`Clip.linkGroupId`,
  domain/linking.ts). Not yet in scope: RE-linking two arbitrary clips
  (unlink is one-way today, undo aside) and linked-pair awareness in a
  future multi-select. Post-MVP.
- `decode.worker.ts` + `DecodeWorkerBridge` are RUNTIME-DEAD since 4.1c
  (the render worker replaced the single-asset path). Kept because their
  tests document the decoder semantics and render.worker imports their
  structural types. Remove or repurpose only as an explicit post-MVP cleanup.
- Inspector number inputs render locale decimal separators (e.g. "1,5")
  — display-only browser behavior; committed doc values are plain floats.
  Revisit only if locale typing ever reports badInput problems.
- Transition rendering, domain authoring, undoable store actions, and the
  5.1e-3 seam popover are complete. Current crossfades are visual-only (audio
  still hard-cuts), and the
  source-over compensation is exact only for ordinary opaque full-frame
  footage; transformed/transparent dissolves need isolated compositing.
  Images remain not previewable (video only). The minimal UI intentionally
  surfaces currently eligible seams; a malformed serialized transition whose
  endpoints are missing/gapped/text has no cleanup marker yet, although the
  store's remove action can still delete it.
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
