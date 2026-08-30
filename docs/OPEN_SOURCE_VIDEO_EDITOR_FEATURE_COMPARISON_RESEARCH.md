# Myrelith and open-source video editor feature comparison

Date: 2026-08-24

Status: current capability comparison and product-roadmap recommendation

## Scope and method

This note compares Myrelith with five free and open-source desktop non-linear
editors: Kdenlive, Shotcut, OpenShot, Olive, and Flowblade. It separates what
Myrelith ships today, what exists only as research, and what is genuinely
missing, then turns those gaps into a recommended roadmap. Feature breadth
alone says nothing about correctness, preview/export parity, performance,
resource ownership, or the quality of a workflow.

Only first-party sources were used: Myrelith's current repository, current
project manuals, release notes, project websites, and upstream repositories.
Claims are scoped to what those sources document as of the date above. The
Myrelith baseline was checked against [its current public feature inventory](../README.md#what-works-today),
[known limitations](../README.md#known-limitations), the binding
[architecture](../ARCHITECTURE.md), and the build-unreferenced
[editor-structure research](EDITOR_STRUCTURE_RESEARCH.md).

Status vocabulary:

- **Shipping** — documented in the current stable release/manual.
- **Limited** — shipping, but the official source states a material constraint,
  or only a narrower workflow than the category heading is evidenced.
- **Experimental** — explicitly described upstream as experimental,
  work-in-progress, or risky.
- **Alpha** — evidenced only in an alpha/unstable product; not treated as a
  dependable peer baseline.
- **N/E** — not evidenced in the reviewed official source set. This is not proof
  that no code path or unofficial workflow exists.

## Executive assessment

Myrelith is already a credible advanced-alpha NLE, not a toy editor. Its core
timeline, local project/recovery model, linked editing, captions, proxies,
keyframes, scopes, stabilization, point/box tracking, manual lens correction,
and capability-aware export make it more complete than many young editors.
Its browser-native privacy model and fail-closed preview/export architecture
are genuine differentiators rather than compensations for missing desktop
features.

It does **not** yet match Kdenlive or Shotcut as an all-purpose desktop-editor
replacement. The largest gap is not one glamorous effect. It is a cluster of
professional workflow and breadth gaps:

1. no Source Monitor and complete three-point edit grammar;
2. basic rather than production-oriented audio editing, including silence for
   non-1x retiming;
3. no shipping adjustment layers, multiple/nested sequences, or multicam;
4. a small built-in effect/color/title vocabulary and no managed 10-bit/HDR
   pipeline;
5. narrow browser/OS codec coverage and delivery options compared with
   FFmpeg-backed desktop applications;
6. no project interchange/archive workflow or render queue.

The practical target should therefore be **Kdenlive-level editing workflow plus
Shotcut-level delivery clarity**, while keeping Myrelith's browser-local safety,
honest capability gates, and simple approachable UI. OpenShot is a useful
accessibility/title baseline, Flowblade is a useful efficient-editing/queue
reference, and Olive is an architecture inspiration only while upstream still
labels it unstable alpha.

## Myrelith capability baseline

| Feature category | Current Myrelith status | What ships now | Material gap to mature peers | Evidence |
|---|---|---|---|---|
| Timeline and editing | **Shipping, strong core / limited pro grammar** | Multitrack select, marquee/group move, razor, trim, ripple trim, slip, slide, linked A/V, track controls, snapping, markers, captions, keyboard stepping, and undo/redo. | No evidenced Source Monitor, source In/Out, three-point insert/overwrite, lift/extract, roll-edit tool, or JKL/shuttle workflow. | [Public inventory](../README.md#what-works-today), [store operations](../ARCHITECTURE.md#store-action-contracts) |
| Media, formats, proxies | **Shipping / limited by browser codecs** | Video/audio plus PNG/JPEG/WebP/AVIF, byte inspection, searchable virtualized Media Pool, collections, thumbnails, filmstrips, waveforms, offline relink, and local editing proxies. | Desktop peers accept and transcode a much wider FFmpeg-backed set. Myrelith proxies are video-only AVC helpers, and final export always requires the original. | [Public inventory](../README.md#what-works-today), [proxy contract](PROXY_CODEC_SUPPORT.md) |
| Effects, compositing, animation | **Shipping / narrow vocabulary** | Transforms, crop, opacity, four blend modes, ordered effects, five-control color adjustment, masks, chroma key, dynamic zoom, crossfades, effect/property keyframes, and signed local plugins. | Far fewer built-ins, presets, generators, blend modes, track/master effects, and direct mask controls than Kdenlive/Shotcut. Text effects remain static. Adjustment layers are research-only. | [Effect contract](EFFECTS.md), [public inventory](../README.md#what-works-today) |
| Tracking and masks | **Shipping, comparatively strong** | Rectangle/ellipse/Bezier masks, animated mask geometry, point and box tracking, stabilization, and manual lens correction. | Lens correction currently blocks tracking on that source, mask editing is numeric/list-based rather than direct on-monitor, and there is no broad rotoscope/object-segmentation workflow. | [Effect contract](EFFECTS.md#masks-and-chroma-key), [architecture](../ARCHITECTURE.md#motion-analysis-foundation-and-research-boundary) |
| Color and scopes | **Shipping / basic SDR** | Exposure, contrast, saturation, temperature, tint, histogram, luma waveform, and vectorscope over completed preview output. | No LUT import, RGB curves, wheels/lift-gamma-gain, secondary grading, color management, 10-bit pipeline, HDR preview, or HDR metadata/export contract. Current pixels are display-referred 8-bit sRGB. | [Effect contract](EFFECTS.md#built-in-color-correction), [scopes](EFFECTS.md#video-scopes) |
| Audio | **Shipping / basic mix** | Live playback, clip volume and stereo balance, track mute/solo, multichannel-to-stereo fold-down, meters, synchronized fades, and AAC/Opus export. | No pitch-safe non-1x audio, gain/pan automation, track/master mixer, EQ, compressor, limiter, noise reduction, loudness normalization, buses, or audio plugin workflow. | [Audio meters](AUDIO_METERING.md), [known limitation](../README.md#known-limitations), [timing policy](../ARCHITECTURE.md#crossfade-planning-composition-and-audio) |
| Titles, subtitles, speech | **Shipping / limited** | Editable procedural text overlays plus semantic caption tracks with SRT/WebVTT import/export. | No title-template library, rich multi-element title canvas, text keyframes, rolls/crawls, ASS styling/interchange, local transcription, or translation workflow. | [Public inventory](../README.md#what-works-today), [known limitation](../README.md#known-limitations) |
| Multicam, sync, sequences | **Research-only** | Pure feasibility work proves bounded adjustment layers, multiple same-settings sequences, exact nested sequences, and manual-sync multicam contracts. | No product schema, UI, preview/export integration, automatic sync, or simultaneous angle wall ships. | [Research status and decisions](EDITOR_STRUCTURE_RESEARCH.md#decision-summary) |
| Stabilization, lens, retiming | **Shipping / audio-limited** | Constant speed, speed ramps/freezes, stabilization, point/box tracking, dynamic zoom, and bounded manual lens correction. | Retimed picture is silent outside exact 1x; no pitch-preserving time stretch. Camera/lens profile catalogs and automatic lens detection are intentionally absent. | [Public inventory](../README.md#what-works-today), [known limitation](../README.md#known-limitations) |
| Export and delivery | **Shipping / narrow** | Capability-aware MP4 AVC/AAC, WebM VP9/Opus, WebM AV1/Opus, explicit HEVC, buffered download, and direct-to-file export. | No persistent render queue, batch/range jobs, custom presets, image sequence, audio-only, alpha, chapters, streaming, project render scripts, or explicit hardware-encoder selection. | [Public inventory](../README.md#what-works-today), [export contract](../ARCHITECTURE.md#export-profile-and-delivery-contracts) |
| Project, recovery, interchange | **Shipping, strong local safety / limited interchange** | Portable projects, Save/Save As/live save, Recent, bounded recovery, remembered local handles, offline projects, deterministic relink, and collections. | No multiple shipping sequences, project archive/collect-media flow, OTIO/EDL/XML interchange, multi-tab recovery coordination, or real-time collaboration. | [Project inventory](../README.md#what-works-today), [known limitation](../README.md#known-limitations), [architecture](../ARCHITECTURE.md#store-action-contracts) |
| Accessibility, localization, customization | **Shipping intent / limited evidence** | Keyboard-accessible native controls, command palette, focus/status handling, responsive editor, and accessible timeline/Inspector operations are built into the current UI. | No formal accessibility-conformance claim, localization system, or mature workspace/layout customization comparable with desktop peers is documented. | [Public inventory](../README.md#what-works-today), [architecture](../ARCHITECTURE.md#store-action-contracts) |
| Extensibility and platform | **Differentiated / limited reach** | Signed local `.myrelith-plugin` packages run through a fail-closed, isolated browser-owned path; the hosted app requires no install or account. | No marketplace/ecosystem, native OpenFX/VST compatibility, or verified Firefox/Safari path. Current product target is desktop Chromium, with codec support depending on browser, OS, and hardware. | [Plugin inventory](../README.md#what-works-today), [platform boundary](../README.md#try-it), [plugin contract](PLUGINS.md) |

## At-a-glance parity matrix

This matrix compresses the sourced detail below. “Strong” means a mature
workflow is evidenced, not that every editor implements it identically.

| Category | Myrelith | Kdenlive | Shotcut | OpenShot | Flowblade | Olive |
|---|---|---|---|---|---|---|
| Core timeline/edit grammar | Strong core; pro grammar gap | Strong | Strong | Strong approachable core | Strong | Alpha |
| Media/format/proxy breadth | Partial | Strong | Strong | Strong | Strong | Alpha / N/E |
| Effects/compositing | Partial | Strong | Strong | Strong | Strong | Alpha |
| Tracking/masks | Strong bounded workflow | Strong but officially limited | Strong | Strong | Strong/limited | Alpha / N/E |
| Color/scopes/HDR | Basic SDR | Strong SDR/10-bit, HDR incomplete | Strongest evidenced HDR workflow | Basic/medium | Medium | Alpha |
| Audio | Basic | Strong | Strong | Medium | Medium | Alpha/basic |
| Titles/subtitles/speech | Medium | Strong | Strong | Medium | Medium/basic | Alpha / N/E |
| Sequences/multicam/sync | Research-only | Strong | Limited | N/E | Limited | Alpha |
| Stabilization/lens/retiming | Strong visual; audio gap | Strong | Strong | Strong/limited | Strong | Alpha / N/E |
| Export/queue/format breadth | Narrow, capability-honest | Strong | Strong | Broad; hardware experimental | Strong | Alpha / N/E |
| Recovery/interchange/workflow | Strong local recovery; no interchange | Strong | Medium | Medium | Medium | Alpha/basic |
| Accessibility/customization | Intentional, limited formal evidence | Limited formal evidence | Limited formal evidence | Limited formal evidence | Limited formal evidence | Alpha |
| Extensibility/platform | Novel sandboxed plugins; Chromium-only | Broad desktop ecosystem | Cross-platform; plugins experimental | Cross-platform integrations | Linux + G'MIC/Fluxity | Alpha |

## What Myrelith should preserve

Parity work should not flatten the product into “Kdenlive in a tab.” These are
already strategic strengths:

- browser-local editing with no account, upload requirement, ads, cookies, or
  in-app analytics;
- portable project files plus explicit offline/relink/recovery semantics;
- one shared preview/export composition model instead of separate best-effort
  evaluators;
- exact integer-frame authoring and an audio-master playback clock;
- honest codec/effect/plugin capability failures rather than silent format or
  effect substitution;
- bounded resource ownership and unusually strong hostile-project/plugin
  handling;
- a modern, approachable interface that exposes real capability without a
  traditional desktop application's initial complexity wall.

## Recommended roadmap

### Priority 0 — complete the everyday editing grammar

**1. Source Monitor and three-point editing.** Add source In/Out, timeline
In/Out, JKL/shuttle controls, insert, overwrite, lift, extract, replace, and a
real roll edit. Reuse one integer-frame edit planner and one history operation
per command. This closes the most important daily-workflow gap against Kdenlive,
Shotcut, and Flowblade; adding dozens of filters first would leave assembly
editing unnecessarily slow.

**2. Finish retiming audio.** Add pitch-safe time stretch for constant speeds
and ramps through one shared live/export contract. The current silent-audio
policy is correct as a fail-closed boundary, but it makes an otherwise strong
retiming feature unsuitable for common dialogue, music, and montage work.

**3. Establish the first production audio effect/automation seam.** Start with
keyframed gain and pan, a track/master mixer, EQ, compressor, limiter, and
EBU-style loudness/true-peak analysis. Every effect must share deterministic
preview/export evaluation; do not build a Web Audio-only preview path that
cannot render the same output offline.

### Priority 1 — ship the already-researched structure roadmap

Keep the dependency order already proven in
[editor-structure research](EDITOR_STRUCTURE_RESEARCH.md#prioritized-follow-up-slices):

1. **12a — adjustment layers** using only effects valid at a post-composite
   boundary;
2. **12b — project-level multiple-sequence graph** and project-wide history;
3. **12c — bounded same-settings compound/nested sequences**;
4. **12d — manual-sync multicam** with fixed-master or follow-video audio.

This order matters. Multicam without a project-level sequence graph would
create disposable special-case state, and nesting before project-wide history
would make one child edit ambiguously affect several parents.

### Priority 2 — broaden creative control

**Color and effects:** add `.cube` LUT import, RGB curves, lift/gamma/gain or
color wheels, effect presets/copy-paste, more blend modes, track/master effects,
and direct Program Monitor mask handles. Design a versioned color-management
model before promising 10-bit/HDR; HDR is not just another export checkbox.

**Keyframes and titles:** expand animation to crop, text properties, audio gain/
pan, and every declared safe numeric effect parameter; add a unified curve/dope
sheet surface. Follow with reusable title/lower-third templates, multi-element
title composition, roll/crawl, and keyframed text styling.

**Captions:** add ASS styling/interchange, batch timing/text tools, and optional
fully local speech-to-text. Transcription should create ordinary editable
caption cues and remain optional; it should not introduce a cloud requirement.

### Priority 3 — professional delivery and interchange

**Render jobs:** add saved custom presets, persistent queued jobs, timeline/
marker ranges, image-sequence and audio-only output, chapters, and clearly
separated browser-decided hardware capability. Keep direct-file transactional
integrity and final capability rechecks.

**Project portability:** add collect/archive-with-media, deterministic missing-
media reporting, and OpenTimelineIO first; add EDL/XML only where their lossy
limits can be disclosed precisely. This will matter more to professional users
than real-time cloud collaboration.

**Format reach:** add codecs/containers only from measured user demand and with
bounded local decoders/encoders. A small, reliable prioritized matrix is a
better browser product than claiming FFmpeg parity and then failing on memory,
licensing, or export fidelity.

**Later color/platform work:** pursue managed 10-bit/HDR and Firefox/Safari only
after explicit source, compositor, scopes, monitor, encoder, metadata, and
browser support matrices are proven end to end.

## Do not chase yet

- Full FFmpeg-format parity inside the browser.
- A native OpenFX/VST compatibility layer before the signed plugin host and
  essential built-ins have real ecosystem demand.
- Simultaneous live eight-angle multicam before proxy/decoder/surface budgets
  are proven; paused/on-demand angle selection is a valid first product.
- HDR marketing before a managed 10-bit source-to-monitor-to-export path exists.
- Cloud collaboration, accounts, or cloud AI that weakens the local-first
  promise.
- WebGPU rewrites without a larger useful compute workload; the existing scope
  experiment already found upload/dispatch/readback overhead slower and more
  memory-heavy than the CPU path.
- Experimental AI/object-generation integrations merely because another editor
  advertises them. Core edit speed, audio, sequences, and delivery will improve
  far more real projects.

## Suggested parity target

A realistic first “big editor” milestone is not complete Kdenlive feature
count. It is this outcome:

- Kdenlive/Shotcut-class assembly editing;
- pitch-safe retiming and a trustworthy essential audio strip;
- adjustment layers, nested sequences, and bounded multicam;
- LUT/curves/wheels plus reusable effect/title presets;
- queued/range/image/audio delivery and OTIO/archive workflows;
- all while retaining Myrelith's current privacy, recovery, capability, and
  preview/export-parity guarantees.

Reaching that bar would make Myrelith a serious browser-native alternative with
its own reason to exist. Chasing every desktop codec, plugin, generator, and
edge-case effect would be a much larger, multi-year ecosystem project and is
not required before the editor feels professionally complete.

## Release and comparability snapshot

| Editor | Current official context | Comparability note |
|---|---|---|
| Kdenlive | **26.04.3**, released 2026-07-06; current manual is 26.04. [K1](https://kdenlive.org/news/) [K2](https://docs.kdenlive.org/en/index.html) | Mature, actively maintained, cross-platform desktop NLE. |
| Shotcut | **26.8.1**, released 2026-08-01. [S1](https://shotcut.org/blog/) | Mature, actively maintained, cross-platform desktop NLE. |
| OpenShot | **3.5.1**, released 2026-04-06; current online manual is 3.5.1. [O1](https://www.openshot.org/blog/2026/04/06/openshot-351-faster-performance-smoother-editing-better-previews/) [O2](https://openshot.org/static/files/user-guide/) | Stable cross-platform editor, positioned toward an approachable workflow. |
| Flowblade | Repository identifies **2.24.2** as latest, released 2026-05-29. [F1](https://github.com/jliljebl/flowblade) | Mature Linux-only NLE; its project website has some stale version labels, so the upstream repository and current manual are authoritative here. |
| Olive | Upstream calls Olive **alpha**, “highly unstable,” and offers a 0.2 unstable build. Its published 0.2 nightly is a 2024 rebuild whose last code change is reported as 2023-09-24. [V1](https://github.com/olive-editor/olive) [V2](https://github.com/olive-editor/olive/releases) | Useful architecture reference, but not a stable parity target. All feature evidence below remains Alpha even where a workflow is visible. |

## Editor-by-feature evidence table

| Editor | Feature category | Status | Official evidence |
|---|---|---|---|
| Kdenlive | Timeline and editing | Shipping | Multitrack editing, virtually unlimited A/V tracks, 3-point editing, non-blocking render, keyframes, grouping, insert/overwrite/lift/extract, markers, and configurable shortcuts/layouts. [K3](https://docs.kdenlive.org/en/getting_started/introduction.html) [K4](https://docs.kdenlive.org/en/user_interface/menu/sequence_menu.html) |
| Kdenlive | Media, formats, proxies | Shipping | Broad FFmpeg/MLT-backed media support, project bins/library, image sequences, automatic/custom proxies, and camera-created external proxies; proxy generation can run as background jobs. [K3](https://docs.kdenlive.org/en/getting_started/introduction.html) [K5](https://docs.kdenlive.org/en/getting_started/configure_kdenlive/configuration_proxy_clips.html) [K6](https://docs.kdenlive.org/en/getting_started/configure_kdenlive/configuration_environment.html) |
| Kdenlive | Effects, compositing, animation | Shipping | Ordered clip/bin/track/master effects, effect zones, presets, custom stacks, keyframes with multiple interpolation/easing modes, transitions/compositions, masks, and 360/3D categories. [K7](https://docs.kdenlive.org/en/effects_and_filters.html) |
| Kdenlive | Tracking and masks | Limited | Motion Tracker can generate reusable keyframes; shape, rectangular, rotoscope, chroma, and tracked masks ship. The manual explicitly calls masking/tracking “limited but nonetheless powerful.” [K8](https://docs.kdenlive.org/en/compositing/masking_and_tracking.html) [K9](https://docs.kdenlive.org/en/compositing/masking_and_tracking/tracking.html) |
| Kdenlive | Color, scopes, 10-bit/HDR | Limited | Histogram, RGB parade, vectorscope, waveform, grading effects/LUT workflows, and a 10-bit effects/composition/render pipeline ship. Effects/compositions can be filtered for 10-bit compatibility; the reviewed manual does not establish a complete HDR metadata/monitoring workflow. [K10](https://docs.kdenlive.org/en/user_interface/menu/view_menu.html) [K11](https://docs.kdenlive.org/en/more_information/whats_new.html) [K12](https://docs.kdenlive.org/en/exporting/render.html) |
| Kdenlive | Audio | Shipping | Track/master mixer with mute, solo, balance, volume, direct track recording and track effect stacks; audio effects include compression, limiting, normalization, EQ/filter, reverb, pitch/time, and plugin families. [K13](https://docs.kdenlive.org/en/effects_and_filters/audio.html) [K14](https://docs.kdenlive.org/en/effects_and_filters/audio_effects/volume_and_dynamics/index.html) |
| Kdenlive | Titles, subtitles, speech | Shipping | Built-in title editor/templates plus Glaxnimate integration; semantic subtitle tracks/layers, ASS styling, SRT/ASS/VTT/SBV import and SRT/ASS export, spellcheck, Whisper/Vosk transcription, and translation workflows. [K15](https://docs.kdenlive.org/en/titles_and_graphics/titles/titles.html) [K16](https://docs.kdenlive.org/en/effects_and_filters/subtitles.html) [K17](https://docs.kdenlive.org/en/effects_and_filters/speech_to_text.html) |
| Kdenlive | Multicam, sync, nested sequences | Shipping | Multitrack monitor supports multicam selection; clips align by matching audio or SMPTE-like timecode; nested timelines/sequences have shipped since 23.04. [K18](https://docs.kdenlive.org/en/user_interface/monitors.html) [K19](https://docs.kdenlive.org/en/cutting_and_assembling/right_click_menu.html) [K20](https://docs.kdenlive.org/en/project_and_asset_management/file_management/project_files.html) |
| Kdenlive | Stabilization, lens, retiming | Shipping | VidStab media job, variable/reverse speed with pitch compensation, keyframed time remapping/speed ramps, and transform/distort/perspective effect families are documented. [K21](https://docs.kdenlive.org/en/user_interface/menu/media_menu.html) [K7](https://docs.kdenlive.org/en/effects_and_filters.html) [K19](https://docs.kdenlive.org/en/cutting_and_assembling/right_click_menu.html) |
| Kdenlive | Export, queue, hardware codecs | Limited | Large preset matrix, zones/marker multi-export, subtitle embed/burn, 10-bit and alpha outputs, generated render scripts/job queue, and non-blocking render ship. Hardware-accelerated presets are explicitly labeled experimental; parallel processing also carries an experimental warning. [K12](https://docs.kdenlive.org/en/exporting/render.html) |
| Kdenlive | Project, recovery, interchange, collaboration | Shipping / Limited | Autosave/backups, project archive with assets, relink/document checking, libraries, nested sequences, and OpenTimelineIO import/export ship. No real-time multi-user editing is claimed in the reviewed manual. [K22](https://docs.kdenlive.org/en/project_and_asset_management.html) [K23](https://docs.kdenlive.org/en/project_and_asset_management/file_management/auto_save.html) [K11](https://docs.kdenlive.org/en/more_information/whats_new.html) |
| Kdenlive | Accessibility, localization, customization | Limited | Editable keyboard shortcuts, toolbars/layouts, themes, and a multilingual manual/UI ecosystem are visible. No formal accessibility-conformance claim was found in the reviewed sources. [K2](https://docs.kdenlive.org/en/index.html) [K3](https://docs.kdenlive.org/en/getting_started/introduction.html) |
| Kdenlive | Extensibility and platform | Shipping / Limited | Linux, Windows, macOS, and BSD are listed. Effects come through frei0r/avfilter/MLT plus LADSPA families and downloadable templates; this is ecosystem extensibility rather than a documented general-purpose, isolated plugin SDK. [K24](https://kdenlive.org/) [K7](https://docs.kdenlive.org/en/effects_and_filters.html) |
| Shotcut | Timeline and editing | Shipping | Multitrack thumbnails/waveforms, 3-point edits, append/insert/overwrite/lift/ripple delete, roll edits, grouping, split/rejoin, markers/ranges, keyframes/easing, smart bins, and flexible tracks. [S2](https://shotcut.org/features/) |
| Shotcut | Media, formats, proxies | Shipping | FFmpeg-backed broad format support, mixed-resolution/frame-rate timeline, alpha and image sequences, native editing without import, proxy editing, preview scaling, batch conversion, network streams, and capture. [S2](https://shotcut.org/features/) |
| Shotcut | Effects, compositing, animation | Shipping | Cross-track compositing, many blend modes, keyframed video/audio filters, masks, chroma key, 3D LUTs, transform/corner pin, transitions, 360 tools, and Glaxnimate/Lottie animation integration. [S2](https://shotcut.org/features/) |
| Shotcut | Tracking and masks | Shipping | Object Motion Tracker, simple/chroma/file masks, mask apply, corner pin, and keyed filter parameters are in the current feature list. [S2](https://shotcut.org/features/) |
| Shotcut | Color, scopes, 10-bit/HDR | Limited | Histogram/RGB parade/waveforms/vectorscope, grading wheels, LUTs, full-range and linear processing, end-to-end 10-bit, HDR10/PQ and HLG preview/export ship. HDR still has filter, Linux preview, conversion, mixing, and metadata/encoder constraints. [S2](https://shotcut.org/features/) [S3](https://www.shotcut.org/blog/new-release-26.6.25/) |
| Shotcut | Audio | Shipping | Multitrack mixing, voiceover recording, loudness/peak/waveform/spectrum/surround scopes, spatial layouts, RNNoise, dynamics/EQ/reverb/pitch filters, speed pitch compensation, and speech-to-text/text-to-speech. [S2](https://shotcut.org/features/) |
| Shotcut | Titles, subtitles, speech | Shipping | Rich/simple text, generators and Glaxnimate animations; subtitles can be created, imported, edited, exported, rendered, embedded, or burned, with SRT/VTT/ASS/SSA import and speech conversion. [S2](https://shotcut.org/features/) |
| Shotcut | Multicam, sync, nested sequences | Limited | Audio-based clip alignment/synchronization and complex MLT XML loaded as a clip are documented. The current feature list does not claim a dedicated angle-switching multicam workspace. [S2](https://shotcut.org/features/) |
| Shotcut | Stabilization, lens, retiming | Shipping | Stabilize, 360 Stabilize, Lens Correction/Fisheye, time remap, speed ramps, reverse, freeze frame, and pitch compensation are listed. [S2](https://shotcut.org/features/) |
| Shotcut | Export, queue, hardware codecs | Shipping | FFmpeg codecs, hardware decode/scale/encode, presets, batch export/conversion, job control, ranges/chapters, image sequences, alpha, 10-bit/HDR, network streaming, PSNR/SSIM, and integrity checks. [S2](https://shotcut.org/features/) |
| Shotcut | Project, recovery, interchange, collaboration | Shipping / Limited | MLT XML save/load/export with autosave, cached thumbnails/waveforms, portable app mode, EDL export, notes, bins, markers, and project comments ship. No real-time multi-user editing is claimed. [S2](https://shotcut.org/features/) |
| Shotcut | Accessibility, localization, customization | Limited | Editable shortcuts, action search, dockable panels, saved layouts, themes, UI translations, grids and safe areas ship. No formal accessibility-conformance claim was found. [S2](https://shotcut.org/features/) |
| Shotcut | Extensibility and platform | Experimental | Windows, Linux, and macOS ship, with Frei0r generators. OpenFX plus VST2/LV2 support is explicitly limited/experimental: no embedded plugin UI, incomplete compatibility, and increased crash risk. [S2](https://shotcut.org/features/) [S3](https://www.shotcut.org/blog/new-release-26.6.25/) |
| OpenShot | Timeline and editing | Shipping | Unlimited tracks, trim/slice/snap/transform, frame stepping, curve keyframes, time mapping, transitions, ripple editing, multi-selection, and a default faster timeline/keyframe panel ship in 3.5.x. [O3](https://www.openshot.org/features/) [O4](https://www.openshot.org/blog/2026/03/16/openshot-35-faster-smoother-and-more-powerful-than-ever/) |
| OpenShot | Media, formats, proxies | Shipping | FFmpeg-backed read/write, cross-platform projects and optimized preview media are documented; 3.5.1 creates or links lower-resolution preview files while final export uses originals. [O1](https://www.openshot.org/blog/2026/04/06/openshot-351-faster-performance-smoother-editing-better-previews/) [O3](https://www.openshot.org/features/) |
| OpenShot | Effects, compositing, animation | Shipping | Layer compositing, 400+ transitions, animated properties, static/animated masks on effects, chroma key, 3D LUTs, Blender-powered 3D titles, and broad video/audio effects. [O3](https://www.openshot.org/features/) [O4](https://www.openshot.org/blog/2026/03/16/openshot-35-faster-smoother-and-more-powerful-than-ever/) [O5](https://openshot.org/static/files/user-guide/effects.html) |
| OpenShot | Tracking and masks | Shipping | Tracker and Object Detector effects, mask support across effects, animated masks, inversion and mask timing controls ship. Experimental ComfyUI tracking/segmentation is separate from that stable baseline. [O5](https://openshot.org/static/files/user-guide/effects.html) [O4](https://www.openshot.org/blog/2026/03/16/openshot-35-faster-smoother-and-more-powerful-than-ever/) |
| OpenShot | Color, scopes, 10-bit/HDR | Limited | Brightness/contrast, hue/saturation, chroma key and `.cube` 3D LUT/Rec.709 grading workflows are documented. Dedicated video scopes, managed HDR preview/export, and an end-to-end 10-bit pipeline are N/E in the reviewed current manual. [O5](https://openshot.org/static/files/user-guide/effects.html) |
| OpenShot | Audio | Shipping / Limited | Waveforms, channel mapping/mixing, transition-aware crossfades, and compressor, expander, parametric EQ, delay/echo and creative audio effects ship. A track/bus/master console comparable to deeper NLE mixers is N/E. [O4](https://www.openshot.org/blog/2026/03/16/openshot-35-faster-smoother-and-more-powerful-than-ever/) [O5](https://openshot.org/static/files/user-guide/effects.html) |
| OpenShot | Titles, subtitles, speech | Shipping / Limited | SVG title templates, Blender animated titles and an editable Caption effect with SRT/VTT text ship. Separate subtitle streams/embedding and local speech-to-text are N/E in the reviewed manual. [O3](https://www.openshot.org/features/) [O5](https://openshot.org/static/files/user-guide/effects.html) |
| OpenShot | Multicam, sync, nested sequences | N/E | The current 3.5.1 feature/manual set reviewed here does not document multicam angle editing, audio/timecode sync, or live nested sequences. [O2](https://openshot.org/static/files/user-guide/) |
| OpenShot | Stabilization, lens, retiming | Shipping / Limited | Stabilizer, Tracker, spherical/fisheye projection, keyframed speed changes, slow/fast and reverse ship. A camera/lens profile correction workflow is N/E. [O3](https://www.openshot.org/features/) [O5](https://openshot.org/static/files/user-guide/effects.html) |
| OpenShot | Export, queue, hardware codecs | Experimental | Broad FFmpeg formats, presets, audio/video/image-sequence output and improved GPU decode/encode ship. Upstream preferences still label GPU hardware acceleration experimental; a persistent multi-job render queue is N/E. [O6](https://openshot.org/static/files/user-guide/export.html) [O7](https://openshot.org/static/files/user-guide/preferences.html) |
| OpenShot | Project, recovery, interchange, collaboration | Shipping / Limited | Autosave, bounded undo/history, zipped recovery copies, missing-file prompts, relative project assets, EDL and Final Cut Pro XML interchange ship; EDL itself has documented limitations. No real-time collaboration is claimed. [O7](https://openshot.org/static/files/user-guide/preferences.html) [O8](https://files.openshot.org/static/files/user-guide/files.html) [O9](https://openshot.org/files/user-guide/import_export.html) |
| OpenShot | Accessibility, localization, customization | Limited | 3.5.1 adds UI scale and improves translation coverage; themes, translations, desktop drag/drop and cross-platform projects ship. No formal accessibility-conformance claim was found. [O1](https://www.openshot.org/blog/2026/04/06/openshot-351-faster-performance-smoother-editing-better-previews/) [O10](https://www.openshot.org/files/user-guide/introduction.html) |
| OpenShot | Extensibility and platform | Experimental | Linux, macOS, ChromeOS and Windows are documented. Blender integration and JSON/OpenShot Cloud API compatibility ship; ComfyUI workflows are explicitly experimental and require advanced setup. [O10](https://www.openshot.org/files/user-guide/introduction.html) [O4](https://www.openshot.org/blog/2026/03/16/openshot-35-faster-smoother-and-more-powerful-than-ever/) |
| Flowblade | Timeline and editing | Shipping | Multitrack editing, six edit tools, insert/append/overwrite, multitrim with trim/roll/slip, JKL, markers, keyframes, clip parenting/sync, multiple sequences, and bins ship. [F1](https://github.com/jliljebl/flowblade) [F2](https://jliljebl.github.io/flowblade/webhelp/basic_editing.html) [F3](https://jliljebl.github.io/flowblade/webhelp/edit_tools.html) |
| Flowblade | Media, formats, proxies | Shipping | MLT/FFmpeg-backed common video/audio/image/SVG/image-sequence support plus project-wide proxy/original switching ship. Proxy mode is all-or-nothing and missing originals can prevent switching back. [F1](https://github.com/jliljebl/flowblade) [F4](https://jliljebl.github.io/flowblade/webhelp/proxy.html) |
| Flowblade | Effects, compositing, animation | Shipping | Full-track/free-move compositing, keyed filters/compositors, blend/transform/alpha tools, masks/rotomasks, LUT3D, G'MIC effects, and rendered container clips ship. [F5](https://jliljebl.github.io/flowblade/webhelp/compositor.html) [F6](https://jliljebl.github.io/flowblade/webhelp/filters_list.html) [F7](https://jliljebl.github.io/flowblade/webhelp/tools.html) |
| Flowblade | Tracking and masks | Shipping / Limited | Two-pass motion tracking can create/apply tracking data and drive an alpha-shape filter mask; filter masking also supports alpha, luma, file and color-select sources. [F8](https://jliljebl.github.io/flowblade/webhelp/advanced.html) |
| Flowblade | Color, scopes, 10-bit/HDR | Limited | Curves, lift/gain/gamma, grading, white balance, Levels histogram, LUT3D, RGB parade and vectorscope are evidenced. The reviewed sources do not establish a managed HDR/10-bit end-to-end workflow. [F6](https://jliljebl.github.io/flowblade/webhelp/filters_list.html) [F9](https://github.com/jliljebl/flowblade/blob/master/flowblade-trunk/docs/RELEASE_NOTES.md) |
| Flowblade | Audio | Shipping / Limited | Track/master VU mixer, volume/pan/mute, waveform levels, audio separation, normalization, noise gate, dynamics/EQ-style filters and Ardour session export ship. Deeper bus/automation/plugin-host workflows are N/E. [F7](https://jliljebl.github.io/flowblade/webhelp/tools.html) [F6](https://jliljebl.github.io/flowblade/webhelp/filters_list.html) [F10](https://jliljebl.github.io/flowblade/features.html) |
| Flowblade | Titles, subtitles, speech | Limited | Layered Titler, credit scroll and scriptable animated text/background generators ship. A semantic subtitle track, subtitle import/export and speech transcription are N/E. [F7](https://jliljebl.github.io/flowblade/webhelp/tools.html) [F11](https://jliljebl.github.io/flowblade/webhelp/generatorsfluxity.html) |
| Flowblade | Multicam, sync, nested sequences | Limited | Waveform audio sync provides a “simplified version of multicam”; multiple sequences, sequence import/split, and pre-rendered selection/sequence container clips ship, but a live angle-switching/nested-sequence workflow is N/E. [F8](https://jliljebl.github.io/flowblade/webhelp/advanced.html) [F12](https://jliljebl.github.io/flowblade/webhelp/container_clips.html) |
| Flowblade | Stabilization, lens, retiming | Shipping | Two-pass stabilization, rendered stabilized media, slow/fast motion, reverse, freeze frame, perspective and defish-style filters are documented. [F8](https://jliljebl.github.io/flowblade/webhelp/advanced.html) [F6](https://jliljebl.github.io/flowblade/webhelp/filters_list.html) |
| Flowblade | Export, queue, hardware codecs | Shipping | Presets/custom FFmpeg args, range export, persistent out-of-process batch render queue, common codecs, VAAPI/NVENC encoders, MLT XML, Ardour session and frame export ship. [F1](https://github.com/jliljebl/flowblade) [F13](https://jliljebl.github.io/flowblade/webhelp/rendering.html) |
| Flowblade | Project, recovery, interchange, collaboration | Shipping / Limited | Projects contain bins and multiple sequences; relative-subfolder lookup, standalone relinker, per-project data stores, import from projects/sequences and persistent render jobs ship. Real-time collaboration and a documented crash-recovery history are N/E. [F2](https://jliljebl.github.io/flowblade/webhelp/basic_editing.html) [F7](https://jliljebl.github.io/flowblade/webhelp/tools.html) [F8](https://jliljebl.github.io/flowblade/webhelp/advanced.html) |
| Flowblade | Accessibility, localization, customization | Limited | Configurable timeline behavior, shortcuts, layouts/themes, shuttle controls and multiple community translations are documented. No formal accessibility-conformance claim was found. [F10](https://jliljebl.github.io/flowblade/features.html) [F9](https://github.com/jliljebl/flowblade/blob/master/flowblade-trunk/docs/RELEASE_NOTES.md) |
| Flowblade | Extensibility and platform | Shipping / Limited | Linux is the supported platform; Windows/macOS are explicitly unsupported. G'MIC and the Python Fluxity generator API provide meaningful extensibility, but not a general native effect-plugin host. [F14](https://jliljebl.github.io/flowblade/download.html) [F7](https://jliljebl.github.io/flowblade/webhelp/tools.html) [F15](https://jliljebl.github.io/flowblade/webhelp/fluxity.html) |
| Olive | Timeline and editing | Alpha | The stale 0.2 wiki documents projects/sequences, insert/overwrite, ripple/roll/slip/slide/razor tools, linking, nesting, markers, JKL and a curve editor. Upstream still labels the application highly unstable alpha. [V1](https://github.com/olive-editor/olive) [V3](https://github.com/olive-editor/olive/wiki/Menus) |
| Olive | Media, formats, proxies | Alpha / N/E | Import and sequence/project commands are evidenced, but the reviewed official sources do not provide a current supported-format, proxy, optimized-media, or relink contract. [V3](https://github.com/olive-editor/olive/wiki/Menus) |
| Olive | Effects, compositing, animation | Alpha | The wiki documents a GLSL node graph with blend, blur, transform, generators, drop shadow/stroke and transitions. The wiki itself warns that it is work-in-progress and may be outdated. [V4](https://github.com/olive-editor/olive/wiki/Nodes) |
| Olive | Tracking and masks | Alpha / N/E | No dependable tracking, rotoscope, or reusable mask workflow is evidenced in the reviewed current upstream sources. [V1](https://github.com/olive-editor/olive) [V4](https://github.com/olive-editor/olive/wiki/Nodes) |
| Olive | Color, scopes, 10-bit/HDR | Alpha / Limited | The 0.2 menu wiki exposes an OpenColorIO project configuration/input color-space field, but current scopes, HDR monitoring/export and a supported 10-bit pipeline are N/E. [V3](https://github.com/olive-editor/olive/wiki/Menus) |
| Olive | Audio | Alpha / Limited | Audio input plus pan and volume nodes and an Audio Monitor are documented. Mixer hierarchy, scopes, dynamics/EQ suite and plugin compatibility are not dependable current baselines. [V4](https://github.com/olive-editor/olive/wiki/Nodes) [V3](https://github.com/olive-editor/olive/wiki/Menus) |
| Olive | Titles, subtitles, speech | Alpha / N/E | The reviewed upstream sources do not document a dependable title authoring, semantic subtitle, subtitle interchange, or speech workflow. [V1](https://github.com/olive-editor/olive) |
| Olive | Multicam, sync, nested sequences | Alpha / Limited | Multiple projects/sequences and a Nest command are documented; dedicated multicam angle switching and automatic audio/timecode sync are N/E. [V3](https://github.com/olive-editor/olive/wiki/Menus) |
| Olive | Stabilization, lens, retiming | Alpha / N/E | The reviewed official sources do not establish dependable stabilization, lens correction, tracking-assisted motion or retiming workflows. [V1](https://github.com/olive-editor/olive) [V4](https://github.com/olive-editor/olive/wiki/Nodes) |
| Olive | Export, queue, hardware codecs | Alpha / N/E | An Export command exists in the old menu reference, but current codec coverage, render queue, presets, hardware encode and delivery guarantees are not documented as stable. [V3](https://github.com/olive-editor/olive/wiki/Menus) |
| Olive | Project, recovery, interchange, collaboration | Alpha / Limited | Save/open multiple projects, undo/redo and an XML-like project model are evidenced. Autosave/recovery, relink, interchange and real-time collaboration are N/E as dependable current features. [V3](https://github.com/olive-editor/olive/wiki/Menus) [V1](https://github.com/olive-editor/olive) |
| Olive | Accessibility, localization, customization | Alpha / Limited | Custom layouts, action search and shortcut-driven tools are visible in stale docs; no current accessibility or localization support statement is dependable enough for parity use. [V3](https://github.com/olive-editor/olive/wiki/Menus) |
| Olive | Extensibility and platform | Alpha | Windows, macOS and Linux builds plus a modular GLSL node architecture are evidenced, but all remain inside an explicitly unstable alpha product. [V1](https://github.com/olive-editor/olive) [V4](https://github.com/olive-editor/olive/wiki/Nodes) |

## Source bibliography

### Kdenlive

- [Kdenlive news / release history](https://kdenlive.org/news/)
- [Kdenlive 26.04 manual](https://docs.kdenlive.org/en/index.html)
- [Introduction and feature overview](https://docs.kdenlive.org/en/getting_started/introduction.html)
- [Sequence menu and timeline edit operations](https://docs.kdenlive.org/en/user_interface/menu/sequence_menu.html)
- [Proxy clips](https://docs.kdenlive.org/en/getting_started/configure_kdenlive/configuration_proxy_clips.html)
- [Proxy/transcode job environment](https://docs.kdenlive.org/en/getting_started/configure_kdenlive/configuration_environment.html)
- [Effects and filters](https://docs.kdenlive.org/en/effects_and_filters.html)
- [Masking and tracking overview](https://docs.kdenlive.org/en/compositing/masking_and_tracking.html)
- [Motion tracking](https://docs.kdenlive.org/en/compositing/masking_and_tracking/tracking.html)
- [Scopes](https://docs.kdenlive.org/en/user_interface/menu/view_menu.html)
- [What is new through 26.04](https://docs.kdenlive.org/en/more_information/whats_new.html)
- [Rendering](https://docs.kdenlive.org/en/exporting/render.html)
- [Audio tools](https://docs.kdenlive.org/en/effects_and_filters/audio.html)
- [Audio volume and dynamics](https://docs.kdenlive.org/en/effects_and_filters/audio_effects/volume_and_dynamics/index.html)
- [Title clips](https://docs.kdenlive.org/en/titles_and_graphics/titles/titles.html)
- [Subtitles](https://docs.kdenlive.org/en/effects_and_filters/subtitles.html)
- [Speech to text](https://docs.kdenlive.org/en/effects_and_filters/speech_to_text.html)
- [Monitors and multicam view](https://docs.kdenlive.org/en/user_interface/monitors.html)
- [Audio/timecode alignment and speed](https://docs.kdenlive.org/en/cutting_and_assembling/right_click_menu.html)
- [Project files and sequences](https://docs.kdenlive.org/en/project_and_asset_management/file_management/project_files.html)
- [Media jobs and stabilization](https://docs.kdenlive.org/en/user_interface/menu/media_menu.html)
- [Project and asset management](https://docs.kdenlive.org/en/project_and_asset_management.html)
- [Autosave](https://docs.kdenlive.org/en/project_and_asset_management/file_management/auto_save.html)
- [Kdenlive platform page](https://kdenlive.org/)

### Shotcut

- [Shotcut release news](https://shotcut.org/blog/)
- [Shotcut full feature list](https://shotcut.org/features/)
- [Shotcut 26.6 HDR and external-plugin limitations](https://www.shotcut.org/blog/new-release-26.6.25/)

### OpenShot

- [OpenShot 3.5.1 release](https://www.openshot.org/blog/2026/04/06/openshot-351-faster-performance-smoother-editing-better-previews/)
- [OpenShot 3.5 release](https://www.openshot.org/blog/2026/03/16/openshot-35-faster-smoother-and-more-powerful-than-ever/)
- [OpenShot 3.5.1 manual](https://openshot.org/static/files/user-guide/)
- [OpenShot feature list](https://www.openshot.org/features/)
- [Effects, captions, masks, color, tracking and audio](https://openshot.org/static/files/user-guide/effects.html)
- [Export](https://openshot.org/static/files/user-guide/export.html)
- [Preferences, autosave/recovery and hardware acceleration status](https://openshot.org/static/files/user-guide/preferences.html)
- [Project assets and missing files](https://files.openshot.org/static/files/user-guide/files.html)
- [EDL and Final Cut Pro XML interchange](https://openshot.org/files/user-guide/import_export.html)
- [Introduction, platforms and project format](https://www.openshot.org/files/user-guide/introduction.html)

### Flowblade

- [Flowblade upstream repository and current release](https://github.com/jliljebl/flowblade)
- [Basic editing, sequences, bins and project paths](https://jliljebl.github.io/flowblade/webhelp/basic_editing.html)
- [Timeline edit tools](https://jliljebl.github.io/flowblade/webhelp/edit_tools.html)
- [Proxy editing](https://jliljebl.github.io/flowblade/webhelp/proxy.html)
- [Compositing](https://jliljebl.github.io/flowblade/webhelp/compositor.html)
- [Filter list](https://jliljebl.github.io/flowblade/webhelp/filters_list.html)
- [Standalone tools, mixer, relinker and G'MIC](https://jliljebl.github.io/flowblade/webhelp/tools.html)
- [Advanced editing, sync, tracking and stabilization](https://jliljebl.github.io/flowblade/webhelp/advanced.html)
- [Release notes](https://github.com/jliljebl/flowblade/blob/master/flowblade-trunk/docs/RELEASE_NOTES.md)
- [Feature overview](https://jliljebl.github.io/flowblade/features.html)
- [Generators](https://jliljebl.github.io/flowblade/webhelp/generatorsfluxity.html)
- [Container clips](https://jliljebl.github.io/flowblade/webhelp/container_clips.html)
- [Rendering and persistent batch queue](https://jliljebl.github.io/flowblade/webhelp/rendering.html)
- [Platform support](https://jliljebl.github.io/flowblade/download.html)
- [Fluxity plugin API](https://jliljebl.github.io/flowblade/webhelp/fluxity.html)

### Olive

- [Olive upstream repository and alpha warning](https://github.com/olive-editor/olive)
- [Olive releases](https://github.com/olive-editor/olive/releases)
- [Olive 0.2 menus and hotkeys wiki](https://github.com/olive-editor/olive/wiki/Menus)
- [Olive nodes wiki](https://github.com/olive-editor/olive/wiki/Nodes)
