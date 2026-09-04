# Myrelith — Session Handoff

Read this first in a new session. It is the deep context; [PLAN.md](PLAN.md)
records the completed MVP roadmap and gates; [../ARCHITECTURE.md](../ARCHITECTURE.md)
holds the binding rules. Post-MVP work comes from explicitly selected issues
and the open list below.

## Myrelith rebrand (2026-08-09)

The current product, package, repository, documentation, UI, benchmark, future
container target, and public hostname are Myrelith. New portable projects use
`.myrelith`, `myrelith-project`, and `__myrelith_text__:`. Parsing intentionally
accepts the legacy `.webcut`, `webcut-project`, and `__webcut_text__:` values
and normalizes them before current validation. Preference reads fall back to
the former localStorage keys, and the two historical IndexedDB database names
remain stable so an in-place upgrade does not orphan Recents, recovery, or
remembered media grants. A hostname change is a new browser origin, so its
storage cannot be transferred automatically; users migrate with portable
project files and grant local media access again when requested.

PR #91 passed exact-head CI at `82a1ed4` and was normally merged as
`d393416`. The GitHub repository is `zyfvhcfh87-rgb/Myrelith`. Cloudflare
Pages project `b55a0fe2-bb44-42b1-8dc5-2b55d618f0e6` owns the primary
`myrelith.pages.dev` origin with `master` auto-deploys. The former Pages
project is retained as `myrelith-legacy` on its old hostname only as a
temporary origin-migration bridge; it is not the canonical public URL.

## Status (2026-08-07)

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
| Post-MVP project system — Slice 1 foundations | ✅ done | presets + portable `.myrelith`; Chrome: 2.000s 60fps source stays 2.000s at 30fps, clean console |
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
| **Post-MVP #31 — project aspect ratios** | ✅ implementation complete | four exact creation families × four size tiers; unchanged `.myrelith` schema; 183 focused + 1,659 total tests; in-app Chromium monitor/export/720px gate with a clean console |
| **Post-MVP #32 — four default tracks per kind** | ✅ complete | fresh documents create `V1`–`V4` + `A1`–`A4`; saved track sets stay unpadded; 157 focused + 1,661 total tests; in-app Chromium 720px gate; PR #37 normally merged and Issue #32 closed |
| **Post-MVP #33 — editable text overlays** | ✅ complete | procedural timed text clips; accessible add/edit/move/resize/delete; shared preview/export Canvas2D renderer; schema 3→4 migration; 304 focused + 1,747 total tests; real 1280/720px Chromium text-only export gate; PR #47 normally merged and Issue #33 closed |
| **Post-MVP #34 — full clip Inspector** | ✅ complete | schema-5 visual/audio editing, shared preview/export rendering, contextual Inspector, direct Program Monitor manipulation, and explicit remembered/quick file paths; 1,784 tests plus real-media reopen/playback/export and 720px Chromium acceptance; PR #49 normally merged as `571fff6` and Issue #34 closed |
| **Post-MVP #35 — preview direct manipulation** | ✅ complete | Issue #34's complete Program Monitor controls plus four explicit corner-scale handles; 82 focused + 1,785 total tests; rotated/cropped/anchored/flipped real-media Chrome gate at 1280×720 and 720×800; PR #51 normally merged as `4f9eaaa` |
| **Post-MVP #43 — keyframing and animation curves** | ✅ complete | schema-6 scalar curves for position/scale/rotation/opacity; one pure scrub/playback/export evaluator; accessible Inspector curves + timeline markers; 1,804 tests; real-media playback/export and 720px Chromium gate, clean console |
| **Post-MVP #54 — performance evidence foundation** | ✅ complete | deterministic production harness and source-bound artifacts merged on `9920491`; canonical fixture, cold-launch/render/import/memory/export metrics, cleanup proof, and advisory gates |
| **Post-MVP #55 — launcher/editor bundle split** | ✅ implementation complete | editor JS/CSS and Export/Text/Animation first-use chunks are absent from the initial launcher graph; initial gzip JS+CSS -19.7%; three-sample launcher median -10.6% and p95 -11.3%; production Chromium network/failure/focus gate clean; delivery tracked by PR #83 |
| **Post-MVP #56 — bounded media-analysis scheduling** | ✅ complete | app-owned two-job/two-decoder scheduler; cancellation/generation cleanup, selected/visible/background aging priority, progress diagnostics, schema-4 benchmark evidence; reviewed head `902078f` normally merged through PR #84 as `b431623` |
| **Post-MVP #57 — runtime and document-memory telemetry** | ✅ complete | schema-3 local telemetry with explainable document/history estimates, bounded worker/audio health evidence, cache-drain checks, optional lab APIs, and measured overhead; PR #82 normally merged as `f7eedab` |
| **Post-MVP #60 — virtualized/searchable Media Pool** | ✅ implementation complete | variable-height grid virtualization, deterministic text/type/status filters, retained keyboard selection and drag/relink identity, visible-row scheduler priority, bounded 500-source Chromium QA; local branch only |
| **Post-MVP #65 — Media Pool collections** | ✅ implementation complete | portable ordered collections with stable multi-membership, collection-only undo/redo, integrated filters, accessible keyboard/drag organization, deletion/relink safety, 196 focused + 1,975 total tests, and 500-source Chromium recovery QA on port 5175 |
| **Post-MVP #59 — indexed frame planning** | ✅ implementation complete | immutable per-track clip/transition indices; exact ordinary/text/crossfade/animation parity; schema-5 sparse/dense Chromium evidence measured 94.26%/94.81% p95 improvement |
| **Post-MVP #58 — adaptive preview resolution** | ✅ implementation complete | session-only Auto/Full/Half/Quarter monitor quality; project-space compositor scaling across ordinary/text/transition frames; reusable scaled worker surfaces; explicit full-resolution export; full 4K harness memory plateau -6.4% median/-7.5% p95; real Chromium 4K/720px gates |
| **Post-MVP #64 — timeline markers** | ✅ implementation complete | schema-7 sequence markers; deterministic pure operations/navigation, undoable store actions, portable migration/round trips, accessible clustered ruler/editor, command palette + keyboard paths; 125 focused + 1,979 total tests; clean in-app Chromium gate on exclusive port 5174; delivery tracked by draft PR |
| **Post-MVP #68 — caption tracks + SRT/VTT** | ✅ implementation complete | schema-8 semantic tracks/cues; exact frame/timestamp round trips, atomic strict import, accessible bounded editor, shared preview/export text composition, undo/recovery; 2,046 total tests and clean Chromium QA on exclusive port 41868 |
| **Post-MVP #45 — versioned effect stack** | ✅ implementation complete | schema-10 ordered descriptors with registry validation/migration/capability fallback and unknown preservation; atomic history operations; shared preview/export exposure/contrast/saturation; accessible Inspector; 306 focused + 2,108 total tests; clean Chromium/recovery/export-ready gate on exclusive port 41845 |
| **Post-MVP #46 — minimal blend modes** | ✅ implementation complete | explicit normal/multiply/screen/overlay intent; schema-9 migration preserving schema-8 captions and unknown blend intent; isolated Canvas2D composition plus capability fallback seam; accessible Inspector/history; clean preview/export/reload Chromium gate on exclusive port 41846 |
| **Post-MVP #69 — constant-speed retiming** | ✅ implementation complete | schema-11 exact rational `SourceTimeMap` after the schema-10 effect stack; deterministic linked trim/split/move/transition/keyframe/thumbnail/seek/composition behavior; shared preview/export audio-mute and output-resource policy outside exact 1×; accessible Inspector timing controls; complete automated gates and clean in-app Chromium QA on exclusive port 41869 |
| **Post-MVP #72 — speed ramps** | ✅ implementation complete | schema-12 deterministic piecewise `SourceTimeMap` curves with hold/linear/smooth easing and bounded freezes; accessible linked/undoable Inspector editing; shared duration/seek/thumbnail/transition/composition/audio/export mapping; validation and real Chromium evidence on exclusive port 41872 |
| **Timeline automation follow-up — playhead-local speed sections** | ✅ complete | Speed at playhead authors held boundaries; explicit whole-clip fallback remains; video clips show labeled normal/slow/fast/freeze sections plus exact boundaries; effect/property keys share de-duplicated markers; 130 focused + 2,603 total tests and clean in-app Chromium interaction/design QA on port 41892 |
| **Post-MVP #67 — snapping and alignment guides** | ✅ implementation complete | one browser-free resolver for playhead/clip/transition/marker anchors; zoom-stable 8px threshold, deterministic ties and eligibility, shared pointer/keyboard paths, persistent accessible preference + Alt bypass, ephemeral guide, and exact preview/one-commit history behavior; 136 focused + 2,023 total tests; clean Chromium gate on exclusive port 41867 |
| **Post-MVP #70 — OPFS editing proxies** | ✅ implementation complete | exact decoder/AVC-MP4 preflight; versioned provenance/LRU OPFS sidecar; cancellable one-job/one-decoder generation; fresh-proxy preview with original-only export; 170 post-rebase focused + 2,186 total tests; 4K long-GOP Chromium gate on exclusive port 41870 |
| **Post-MVP #71 — basic color correction and video scopes** | ✅ implementation complete | stable version-1 exposure/contrast/saturation contract extended compatibly with temperature/tint; explicit unpremultiplied sRGB/alpha/clamp semantics; shared preview/export composition; dedicated 4 Hz histogram/waveform/vectorscope worker; accessible stack/scopes controls; 2,224 total tests and clean Chromium QA on exclusive port 41871 |
| **Post-MVP #44 — motion-analysis and stabilization research** | ✅ research complete | bounded cancelable job/cache contracts; deterministic similarity stabilization and point/box tracking go gates; safe manual lens model; delivery split into #108–#111; product lens renderer remains absent |
| **Post-MVP #108 — motion-analysis job/cache foundation** | ✅ complete | production one-job/one-decoder controller; worker-owned real-source decode/downsample with exact frame closure; strict schema-1 OPFS derived cache; source/currentness rollback; PR #115 squash-merged as `73ceeea`; issue closed |
| **Post-MVP #109 — bounded video stabilization** | ✅ complete | production #108 consumer; O(n) similarity smoothing; exact project-space safe coverage; ordinary Position/Rotation/equal-Scale tracks; PR #116 squash-merged as `2c9e35a`; issue closed |
| **Post-MVP #110 — bounded point and box tracking** | ✅ complete | exact-frame Program Monitor selection; bounded forward/backward local tracking; explicit loss; ordinary Position and optional Scale authoring; PR #117 squash-merged as `a91f1af`; issue closed |
| **Post-MVP #111 — parity-safe manual lens remap** | ✅ complete | build-unreferenced CPU oracle + accepted RGBA8 WebGL2 candidate; seven-fixture pixel/geometry parity, 720p/1080p/4K timing, finite memory, cancellation, context-loss/fresh-owner proof; PR #114 squash-merged as `56826a6` |
| **Post-MVP #171 — OS file drop import** | 🚧 in progress locally | file-only window guard; Media Pool batch drop; one-file timeline drop after import; duration-accurate asset ghost + insertion marker; shared placement planner/controller; Files never enter stores |
| **Post-MVP #119 — bounded manual lens correction** | 🚧 implementation complete locally | schema-14 versioned intent; accessible Inspector/history controls; promoted source-space WebGL2 preview/export path; explicit coverage/unavailability; seven-surface 4K budget; local CI/review gates pending |
| **Post-MVP #77 — signed sandboxed plugins** | 🚧 PR #123 remediation validated locally | production preview/export/migration wiring; fail-closed render and stale-generation gates; bounded host-acknowledged teardown; safe startup recovery; hostile-package and real Chromium acceptance; full/exact-head publication gates pending |
| **Post-MVP #179 — marquee selection + grouped move** | ✅ implementation complete | Select-tool left-drag over empty lanes previews and commits box selection; selected/link-expanded clips move horizontally as one collision-safe, one-history edit; 3,364 tests + desktop Chromium interaction/undo/redo gate clean |
| **Post-MVP #180 — Compatibility/HEVC export flush error** | ✅ fixed locally; native Chrome regression locked | #178's 96→48 kHz mapping remains correct; the remaining 59.94/60 fps failure was Chrome AAC rejecting 800/801-sample frame-aligned startup chunks at flush; one bounded shared assembler now feeds 2,048 startup samples then 1,024-sample blocks without codec/profile substitution; 3,370 tests plus real sink exports in repository Chromium and installed Chrome pass |
| **Post-MVP #188 — pitch-safe retiming** | ✅ final implementation and acceptance complete; delivery via PR #217 | PR #213's constant 0.25×–4× WSOLA now also follows canonical variable-speed ramps in shared live/export code; exact 1× remains direct; held 0× spans fade to silence; combined eight-session and lifecycle gates plus real Chromium speech/music export-reopen evidence are green |
| **Post-MVP #189 — audio automation, mixer, and effects** | ✅ merged in PR #215 as `138db35` | schema-16 automation, schema-17 mixer, schema-18 clip/track/master effects; shared live/export signal order; loudness and presets; exact-head CI/review green |
| **Post-MVP #190 — bounded adjustment layers** | ✅ merged in PR #214 as `024ea9b` | schema-15 resource-free video-track items; full history/edit/persistence/recovery; safe post-composite color effects and bounded animation; deterministic shared preview/export order; zero additional compositor surfaces; Chromium interaction/undo/redo/responsive gate clean |
| **Post-MVP #191 — multiple project sequences** | ✅ implementation and acceptance complete; delivery via PR #218 | project-format-6 same-settings sequence collection; explicit portable root/session active; whole-project history, CRUD UI, validation, persistence/recovery/media reconciliation, and explicit export target; Bugbot's project-identity and adjustment-only Match findings fixed; 3,732 total Vitest and 17 runner tests plus build/lint/audit green; in-app Chromium v5 migration/CRUD/root/undo/redo/export/recovery/720px gate clean; repaired code head CI/Bugbot green |
| **Post-MVP #192 — bounded live compound sequences** | ✅ implementation and acceptance complete locally | schema-19 live sequence instances; depth-8 / 4,096-leaf whole-project admission; atomic compound edits and independent reminting; shared immutable preview/playback/export plans; black/silent gaps; portable recovery/relink; 3,758 Vitest, 17 runner, and 15 Chromium tests green plus live compound/recovery/relink QA |
| **Public preview foundation** | ✅ complete | PR #39 normally merged as `256887b`; `v0.1.0-alpha.1` prerelease + verified web archive; private multi-arch GHCR package digest `sha256:837cc8e…`; exact Cloudflare production deployment `c85ceeb0`; GitHub About/resources/topics populated |
| **Current public preview — `v0.2.0-alpha.1` First Light** | ✅ published | annotated tag resolves to `2a845c8`; verified 43-file web archive `sha256:aef2445b…`; public Linux AMD64/ARM64 GHCR index `sha256:ee060a7e…`; exact-head PR + master CI, 3,335 Vitest tests, 17 runner tests, and 10 Chromium tests passed |
| **Refactor Stage 5 — project media reconnection seams** | ✅ complete | pure descriptor matching + one injected active-relink transaction behind the unchanged facade; 146 focused + 1,704 total tests; checked-in recovery smoke and headed Chromium offline/permission/individual/folder/cancel/replacement matrix, clean console |
| **Refactor Stage 6 — media import decision seams** | ✅ complete | pure partial-track + FPS/commit policy behind the unchanged resource-owning facade; 162 focused + 1,725 total tests; checked-in recovery smoke and headed Chromium UI import/FPS-cancel/Unsupported→Retry→Ready matrix, clean console |
| **Refactor Stage 7 — Mediabunny export adapter owners** | ✅ complete | stable facade split into visual/audio/sink resource owners plus one shared fake harness; 156 focused + 1,725 total tests; headed Chromium buffered/direct A/V reopen + native playback, exact 9,600-sample presentation, commit/cancel/write-failure cleanup, clean console |
| **Refactor Stage 8 — export presentation + feature CSS** | ✅ complete | export lifecycle stays in one owner behind stateless sections; the ordered ten-file CSS manifest produces byte-identical CSS; 91 focused + 1,725 total tests; checked-in recovery smoke plus headed 390/720/1280/1440px focus/keyboard/overflow QA, clean console |
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
Phase 5 / MVP manual gate on 2026-07-12, so Myrelith is MVP-complete; the
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
audio; a pure new-document factory; and a versioned portable `.myrelith` contract
with deterministic serialization, strict validation, migration entry points,
resource bounds, stable asset descriptors, and no session-only URLs, handles,
decoder state, visuals, or undo history. Media assets now retain canonical
integer microseconds and conform that duration to the active document rate. A
10-second 60 fps source in a 30 fps project is therefore 300 frames, not 600.

Project-system Slice 2 centralizes media import behind one app controller. A
selected File is analyzed exactly once, stays outside Zustand while a decision
is open, and enters mediaStore only as one complete asset. Exact rational native
and project rates drive an explicit Keep project rate / Match source rate /
Cancel dialog; Myrelith never changes project FPS silently. Match is safe only
for an empty timeline and a supported project preset. It updates the document
and re-conforms every unused asset from canonical microseconds; once clips
exist, Match remains visible but disabled because edited-timeline retiming is a
separate operation. Every rejected/cancelled path closes Mediabunny Input and
revokes the uncommitted source URL. Preview now forwards the committed asset's
Blob and native rate directly to the worker instead of re-demuxing it.

Project-system Slice 3 makes those foundations user-visible. Myrelith now opens
on a responsive Home screen with explicit Create and Resume paths. Create uses
the authoritative resolution/frame-rate/audio catalogs. Resume validates a
`.myrelith` candidate before touching the editor, then analyzes selected source
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
raw paths and handles never enter `.myrelith`, Zustand, or domain data. Resume
queries each remembered handle: a retained read grant analyzes and reconnects
the exact descriptor automatically, while a `prompt` state becomes one
**Allow media & open** click whose permission requests start before the first
await. Denied, missing, moved, changed, unsupported-browser, and cleared-site-
data cases stay on the existing manual relink fallback. Old projects seed the
sidecar after their next successful handle-aware relink.

Project-system Slice 5 adds an origin-local project library without changing
the portable `.myrelith` format. Validated handles become removable Recent
shortcuts in supporting Chrome builds. Dirty work writes a separate bounded
recovery journal: at most three complete generations per editing lineage,
twelve Recent entries, eight journals, and a fixed serialized-character budget.
Recovery never clears dirty state or claims the project was Saved; Home offers
it explicitly after reload/crash and requires confirmation before permanent
discard. Successful revision-current Save and intentional Projects exit clear
the journal. Recovery failures remain separate from file-save truth, and a
failed exit rebuilds its deleted safety copy before editing continues. No media
bytes, paths, object URLs, or handles enter `.myrelith` or Zustand.

The real-Chrome gate passed 2026-07-14: four recovery writes retained exactly
three generations; reload offered, but did not silently activate, the local
copy; Review + Recover restored the latest four-track document and kept it
honestly unsaved; confirmed Discard removed the journal; the reusable project
picker entry rendered; the Home layout stayed intact; and the final console was
clean.

Project-system Slice 6 separates the durable media catalog from its connected
session resources. A validated `.myrelith` now activates even when some or all
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

The real-Chrome gate passed 2026-07-14 with a disk-backed `.myrelith` and MP4:
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

The in-app Chromium gate passed 2026-07-18 at 1280×720 through Myrelith's ordinary
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
boundary the asset remains visible with a `resource-limit` diagnostic; Myrelith
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
only and remains outside Zustand and `.myrelith`, so another browser or resumed
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
for its multi-thread option, and is packaged GPL-2.0-or-later with x264. Myrelith
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
distribution remains a separate gate: add the Myrelith license and third-party
notices/source links, finish FFmpeg/LGPL and Dolby review, and run representative
low-memory testing before making a release-compliance claim. Future project
storage is also separate opt-in media caching with quota/eviction UX and
multi-tab recovery ownership; do not imply recovery or a portable `.myrelith`
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
returns a source Myrelith can inspect. The 256 MiB ceiling bounds Myrelith's
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
frame rate, and audio rate, choose a `.myrelith`, reopen a Recent file, or review
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
Use **Add text** to create a timed title, caption, lower-third, label, or
callout without importing media. The inspector edits its content, portable
font family, size, weight/style, colors, alignment, opacity, and outline or
background treatment. Selected text can be moved or resized directly in the
Program Monitor with pointer, touch, or keyboard controls; those edits commit
once on release while preview and export share the same bounded Canvas2D text
layout and painting path. Text clips move, trim, ripple, split, slide, link,
unlink, and delete like other timeline clips; Slip is an explained no-op
because procedural text has no hidden source range. Save/load preserves the
exact timing, geometry, and supported style or rejects the document clearly.
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
mediabunny sinks); both images span the asset's FULL duration.
`timeline/clipVisualPlan.ts` maps filmstrip time through fixed-aspect SVG
patterns in integer-frame buckets and waveform time through a normalized
source-time SVG viewBox; `ClipVisualLayer.tsx` renders that prepared visual
plan without owning stores or gestures. A long clip is
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
  `clipAnimation.ts` (Issue #43's canonical bounded track validation, immutable
  keyframe edits, and deterministic hold/linear/cubic-Bézier evaluation for the
  six supported scalar visual properties),
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
  paint plan. `videoCompositionPlan.ts` also emits Issue #33 procedural text
  items without source-media requests and resolves Issue #43 curves at the
  requested timeline frame before ordinary/crossfade requests. Invalid or
  malformed groups and curves fall back deterministically.
- `src/domain/frameIndex.ts` — Issue #59's immutable half-open point index.
  Canonical disjoint ranges use binary search; malformed or overlapping input
  preserves the historical first-match behavior. The retained video planner
  builds one clip and transition index per visible track and reuses them for
  every requested frame.
- `src/domain/textOverlay.ts` + `textLayout.ts` — Issue #33's strict text
  defaults/validation and bounded, deterministic wrapping authority shared by
  preview and export. Text uses reserved procedural asset ids and a portable
  generic-font allowlist, so unsupported choices are rejected rather than
  silently substituted.
- `src/domain/audioMixPlan.ts` — shared live/export audible contributors,
  virtual real-handle ranges, absolute envelopes, and bounded linear or
  equal-power gain evaluation; ordinary mute/solo/hard-cut behavior remains
  the fallback.
- `src/domain/projectSettings.ts` — authoritative project presets, strict
  settings validation, and the pure empty-document factory. Fresh documents
  own four independent video tracks followed by four independent audio tracks;
  persisted documents are never padded to that creation-time default.
- `src/domain/projectFile.ts` + `src/domain/projectFile/` — stable facade over
  focused versioned `.myrelith` serialization, migration, and validation modules;
  migration entry point, strict untrusted-input validation, and bounded durable
  asset metadata; excludes every session-owned field. Issue #17 advances the
  outer project format to 4 and nested timeline schema to 3 for independent
  video/audio timestamp bounds and transition audio intent; Issue #33 advances
  the nested timeline schema to 4 for strict procedural text overlays; Issue
  #34 advances it to 5 for clip visual/audio settings; Issue #43 advances it to
  6 for canonical scalar animation tracks. Older
  snapshots migrate conservatively; Issue #18's image-media migration still
  produces `still` `[0, 1)` without changing timed media or text semantics.
- `src/domain/proxyCache.ts` — Issue #70's browser-free versioned manifest,
  sampled-fingerprint/provenance/profile validation, even 720p geometry, size
  estimate, and shared preview-versus-final-export representation policy.
- `src/domain/motionAnalysis.ts` + `motionTrackingResearch.ts` — Issue #44's
  browser-free, deterministic, bounded similarity stabilization and point/box
  tracking feasibility core. Accepted tracking samples map only to existing
  Position X/Y and optional Scale X/Y tracks.
- `src/domain/analysisCache.ts` + `lensCorrection.ts` — strict analysis-cache
  provenance/staleness contract and versioned normalized manual lens model.
  The former is implemented by Issue #108's origin-local derived sidecar; the
  latter remains research-only and is not an enabled renderer effect.
- `src/app/motionAnalysisController.ts` + `motionAnalysisRuntime.ts` +
  `motionAnalysisWorkerBridge.ts` — Issue #108's production one-job/
  one-decoder admission, source/currentness ownership, worker lifecycle,
  serializable status, and editor-lifecycle integration. The controller returns
  derived bytes only and never edits the timeline document.
- `src/pipeline/motionAnalysisDecode.ts` +
  `src/workers/motion-analysis.worker.ts` — real-source sequential decode,
  grayscale downsample, exact `VideoFrame` closure, and acknowledged bounded
  windows of at most 300 retained frames / 32 MiB.
- `src/app/analysisStorage.ts` — strict schema-1 OPFS analysis sidecar with
  result-first/manifest-last publication, late-commit rollback, exact
  provenance lookup, bounded LRU eviction, and recoverable corruption/quota/
  unavailability behavior.
- `src/app/motionAnalysisResearchController.ts` +
  `src/workers/motion-analysis-research.worker.ts` — build-unreferenced Issue
  #44 probe/runtime seam: one queued job, one reserved decoder slot, disposable
  workers, exact support probes, abort settlement, and resource diagnostics.
- `src/state/projectSessionStore.ts` — serializable launch/editor screen,
  active-project labels, operation phase, relink status, and separate
  save/recovery status; no Files, Blobs, URLs, parsed candidates, browser
  handles, or recovery payloads. `src/state/projectLibraryStore.ts` holds only
  serializable Recent/recovery summaries for Home.
- `src/state/proxyStore.ts` — serializable per-asset capability/progress/error
  facts plus honest cache/origin quota and persistence estimates; it owns no
  Blob, file handle, worker, scheduler, or project truth.
- `src/state/transportStore.ts` — ephemeral playback/tool/selection state,
  including ordered unique `selectedClipIds` plus primary `selectedClipId`, and
  document-agnostic `reconcileClipSelection(existingIds)` for stable stale-id
  pruning, plus signed `dragPreview.deltaFrames` shared by every linked move
  participant. Issue #179 adds `dragPreview.clipIds` for the exact selected/link
  closure and `selectionMarquee` for the live box-intersection preview; both
  remain ephemeral and outside document history,
  authoritative timeline `zoom`, `zoomMode`, remembered `customZoom`, and the
  translation-only `timelineOriginFrame`, plus uncommitted Program Monitor
  text-geometry and Issue #34 clip-visual previews; selection, gesture drafts,
  preset/custom zoom, and origin setters never enter document undo/redo history.
- `src/app/selectionReconciliationController.ts` — original Issue #12 Slice 5
  composition seam: observes document-reference changes, supplies the current
  clip-id set to transport, and keeps selection consistent without either store
  importing the other or selection entering history/persistence.
- `src/app/proxyController.ts` + `proxyStorage.ts` + `localDerivedStorage.ts`
  — Issue #70 composition boundary: stable provenance keys, per-attempt OPFS
  files, manifest-first replacement/LRU, one-job/one-decoder scheduling,
  source-change cancellation, fresh preview capabilities, and narrowly scoped
  derived-data clearing. The files remain disposable and never enter portable
  project/recovery schemas.
- `src/ui/Inspector.tsx` + `src/ui/inspector/` — thin tab/composition host over
  focused timing, text, video, audio, crop, and linking panels. The original
  Issue #12 Slice 6 shared Link/Unlink command
  group: focusable `aria-disabled` controls, visible described availability,
  exact rendered-intent/latest-state race checks, live rejection announcements,
  retained primary selection, and post-Unlink focus handoff. Issue #33 adds the
  validated text-content and presentation editor plus one-step deletion. Issue
  #34 adds contextual Video/Audio sections and mirrors ephemeral visual drafts
  without entering document history. Issue #43 adds a keyboard- and
  screen-reader-operable property/keyframe/curve editor synchronized with the
  playhead and the same history-backed document actions.
- `src/ui/TextOverlayDialog.tsx` + `TextOverlayControls.tsx` — Issue #33's
  accessible add flow and Program Monitor move/resize surface. Pointer/touch
  gestures preview ephemerally and commit once; keyboard controls use 1px or
  Shift+10px steps with explicit accessible names and instructions.
- `src/ui/VisualOverlayControls.tsx` — Issue #34's accessible Program Monitor
  move, scale, rotate, crop, anchor, and flip surface. Pointer/touch gestures use
  fresh bounds, rAF-coalesced drafts, stale-document rejection, and one commit
  on release; keyboard controls cover every operation. Issue #43 resolves
  animated values at the playhead and routes edits on animated properties to
  exact playhead keyframes while keeping static property behavior unchanged.
- `src/app/projectController.ts` + `src/app/projectController/` — stable facade,
  public contracts, production dependency wiring, and one stateful Slice 3
  session ownership root: validates
  candidates off-store, restores granted local handles, requests remembered
  permission only from the Open click, generation-cancels late work, and
  performs the awaited outgoing-session teardown before committing a complete
  new document/media session. Its public facade is unchanged.
  `src/app/projectMediaMatching.ts` owns store-free descriptor/report matching,
  saved partial-track reapplication, deterministic file/folder tie-breaks, and
  stable connected-asset reconstruction. `src/app/activeMediaRelinkCoordinator.ts`
  owns the dependency-injected inspect/revalidate/URL-transfer/report/remember/
  rollback transaction shared by individual Relink and accepted folder matches;
  the controller supplies the active generation, store port, staged-selection
  claim, and serializable progress projection.
  `src/app/localMediaHandles.ts` owns picker types plus the origin-local media
  handle registry. `src/app/localProjectStorage.ts` owns bounded Recent and
  recovery IndexedDB records; `src/app/projectLibraryController.ts` keeps their
  handles/snapshots outside state. `src/ui/ProjectLaunch.tsx` is the Home, New
  Project, Resume, Recent, and explicit-Recovery UI facade.
- `src/app/pluginRuntimeController.ts` + `src/app/pluginRuntime/` — stable public
  facade over explicit request/result contracts, stateless policy helpers, and
  one app-owned scheduling/cancellation/fail-closed runtime ownership root.
- `src/pipeline/static-image-inspection.ts` — Issue #18 original Slice 1 bounded,
  content-based PNG/JPEG/WebP/AVIF inspection. It owns immutable source,
  candidate-dimension, decoded-allocation, and animation facts plus stable
  unsupported, malformed, and resource-limit failures; it imports no UI or
  state.
- `src/pipeline/proxyGeneration.ts` — Issue #70's exact source decoder plus
  AVC/MP4 encoder revalidation, sequential pool-size-one CanvasSink conversion,
  awaited encoder/OPFS backpressure, and success-only output commit with
  cancellation/failure cleanup.
- `src/pipeline/static-image.ts` — atomic browser/worker first-frame decode
  seam. It reinspects the exact Blob, canonicalizes the sniffed MIME, transfers
  one caller-owned `ImageBitmap` or `VideoFrame`, validates orientation-aware
  geometry and native allocation, and owns prompt abort plus exact
  decoder/frame/bitmap cleanup.
- `src/domain/staticImage.ts` — Issue #18 bounded still-duration validation and
  exact project-rate frame conversion.
- `src/state/preferencesStore.ts` + `src/app/preferencesController.ts` — the
  persisted, versioned **Default still-image duration** preference plus the
  separate `myrelith.export-selection:v1` last-known-valid export choice. Export
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
  The Stage 5 extraction gate passed 146 focused tests across 7 files and all
  1,704 tests across 91 files, plus build, lint, audit, diff, and the checked-in
  Chromium recovery smoke. Headed Chromium used a real generated PNG and the
  public controller facade to verify offline activation, individual Relink plus
  handle persistence, remembered prompt-to-grant restore, explicit folder
  ambiguity, cancellation, and project replacement with exactly one late URL
  revocation; the console reported zero warnings and zero errors.
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
- `src/app/mediaImportDecisions.ts` — store-free import policy: creates exact
  Keep/Match prompts, reapplies confirmed partial-track choices after re-probe,
  and validates the active document/rate before resolving the commit rate. It
  owns no browser resource or mutation.
- `src/app/mediaImportController.ts` — import composition root and unchanged
  public facade: owns selected Files/handles and retained retry resources
  outside Zustand, publishes guarded
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
  Issue #70 adds `ProxyControls.tsx` for exact support reasons, progress,
  cancel/retry/regenerate/remove, and local proxy usage/quota/persistence.
- `src/ui/timeline/ClipView.tsx` + `gestureBounds.ts` — Slice 3 repeats one
  bounded still tile across the complete timeline duration, exposes a clear
  still-image accessible name/Slip explanation, gives still trims unbounded
  source headroom, and constrains still Slip to exactly zero.
- `src/ui/ExportDialog.tsx` + `ExportDialogSections.tsx` +
  `ExportProfilePicker.tsx` + `exportProfileUi.ts` — preset-first
  capability-aware export UX. `ExportDialog` is the sole lifecycle owner for
  generation-safe checks, lazy controller loading, retry/cancellation, focus,
  and download/direct-file results; the sections render those facts without
  state or resources, while the picker owns validated advanced drafts and size
  inputs. `Toolbar.tsx` only owns trigger/open state and restores focus when
  the dialog closes.
- `src/app/layout.css` + `src/app/styles/` — ordered style manifest plus
  feature-owned project-launch, shell, timeline/transport, preview, media-pool,
  toolbar, export, responsive, inspector, and placeholder rules. The manifest
  preserves the previous cascade exactly; its import order is binding.
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
- `src/pipeline/export-mediabunny.ts` — stable Phase 5.1b/c/d composition
  facade. `export-mediabunny-visual-source.ts` owns the asset Blob/kind
  resolver → Input/CanvasSink/timestamp-iterator path, retained bounded
  frame-zero image sources, lease-owned ImageBitmap copies, canonical
  visual-plan request order, and exact source cleanup.
  `export-mediabunny-audio-source.ts` owns lazy AudioSampleSink cursors,
  streaming resampling/channel downmix, and exact crossfade-handle readers that
  reject EOF, PCM gaps/discontinuity, or unavailable interpolation rather than
  synthesizing samples. `export-mediabunny-sink.ts` owns
  OffscreenCanvas/CanvasSource + AudioSampleSource encoding, exact validated
  MP4/WebM muxing, buffered `BufferTarget` and transactional direct
  `StreamTarget` delivery, backpressure, and terminal cleanup. Shared resolver
  and typed error facts live in `export-mediabunny-common.ts`; the facade keeps
  existing imports stable and owns no live resource. The pinned Mediabunny
  patch preserves exact WebM/Opus presentation length and reopen metadata;
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
- `src/workers/decode-types.ts` — neutral structural types shared by current
  rendering and the retained decode compatibility path. The deprecated
  `decode-protocol.ts` keeps the old chunk-worker message contract.
- `src/workers/render-protocol.ts` — render-worker message types (types only).
  The primary path sends each timed-video Blob once through `configureAsset`
  or each static-image Blob once through `openImage`, then lightweight entries
  discriminated as `video` or `image`. Video entries carry clip lane, asset,
  integer source frame, exact µs timestamp, and playback/seek mode; image
  entries carry literal frame/timestamp zero. `closed` acknowledges completed
  worker cleanup before bounded-timeout bridge termination. The deprecated
  chunk-batch messages are defined in `render-legacy-protocol.ts` and remain
  only for migration tests. `setDoc` must precede renders built from it.
- `src/workers/render.worker.ts` + `src/workers/renderWorker/core.ts` — thin
  worker wiring around the Blob-backed compositing owner: timed video
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
- `src/workers/render-legacy.ts` and `src/engine/render-legacy-bridge.ts` —
  compatibility delegates isolating the obsolete chunk-batch renderer. The
  current render worker and bridge preserve the old public methods/messages by
  delegation; current streaming code does not import the retired decode
  worker, bridge, or chunk-source implementations.
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
  Wired by `src/app/mediaVisualsController.ts` (3rd composition root) through
  `src/app/mediaJobScheduler.ts`: at most two asset jobs/two decoder slots,
  selected-clip then exact visible-range then background priority with aging,
  one generation per asset, typed failure containment, progress diagnostics,
  and cooperative cancellation. `mediaStore` owns only transferred result
  URLs; removed/replaced/stale generations close Inputs and revoke late URLs
  even when a new project reuses the same durable asset id.
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
- `src/ui/timeline/clipVisualPlan.ts` + `ClipVisualLayer.tsx` — pure live
  display/window/source-time planning plus the stateless generated-media JSX.
  They own no pointer session or document mutation; ordinary and rebased
  timeline slices share the same prepared filmstrip/waveform geometry.
- `src/ui/timeline/useClipGestureSession.ts` — the 4.2 gesture heart: one
  session ref routes body/edge pointerdowns by the CURRENT tool (getState(),
  not the render closure!), owns pointer capture and every cancellation path,
  publishes rAF-coalesced transport previews, and dispatches at most one
  document action per gesture. It retains the immutable pointerdown document
  reference, clears its preview if that reference changes, and skips stale
  pointerup commits. Slip clamps live against mediaStore asset bounds;
  owner-only cross-track metadata leaves linked partners on their own lanes.
- `src/ui/timeline/ClipView.tsx` — store-backed clip presentation and the stable
  pressed-button interaction root. It preserves independent focus/selected/
  primary visuals, hides decorative link badges from its accessible name, and
  highlights every live linked-preview participant. Long clips render only
  their intersection with the bounded window; filmstrip buckets and the
  normalized waveform viewBox remain aligned to the original source.
  The Stage 3 presentation extraction gate passed 93 focused tests across 6
  files, all 1,682 tests across 89 files, the checked-in Chromium persistence
  smoke, build, lint, audit, and diff checks. Real Chromium additionally
  matched video/audio geometry at ordinary origin zero and a rebased
  1,000,000-frame origin with zero console warnings or errors.
  The Stage 4 gesture-session extraction gate passed 108 focused tests across
  7 files, all 1,685 tests across 89 files, the checked-in Chromium persistence
  smoke, production build, lint, audit, and diff checks. Headed Chromium also
  passed modifier-edge selection, unequal-offset linked preview/commit,
  stale-document cancellation, forced pointer-capture failure, owner-only
  cross-track movement, and exact one-entry history with zero console warnings
  or errors.
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
  Timeline also publishes its exact transient on-screen frame range through
  the media-visuals app facade so queued analysis can be reprioritized without
  persisting viewport state or crossing directly into pipeline code.
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
  import mediabunny via `/@fs/E:/ClaudeSpace/Myrelith/node_modules/mediabunny/dist/modules/src/index.js`,
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
- `npm run test:browser` starts an isolated Vite server on :41732 and runs the
  real-Chromium crash/reopen IndexedDB recovery gate. On a fresh checkout, run
  `npx playwright install chromium` once before the gate.
- HMR of worker files fully reloads the page (in-page state like
  `__testFile` dies); module-map caches stale plain-URL imports —
  cache-bust probes with `?probe=N` (this double-instances mediabunny →
  its "loaded twice" console warning; harness artifact, ignore).

## Open items and recent closeouts (beyond PLAN.md phases)

- Issue #189 merged through PR #215 as `138db35`. Schema 18 carries bounded clip/track/master audio-
  effect descriptors; live playback and export share the automated mix order,
  EQ, compressor, limiter, and stereo-linked noise-gate DSP. Loudness is a
  cancellable, explicit-range derived LUFS + FIR inter-sample true-peak scan;
  Inspector reports live/export effect readiness separately; Voice, Music, and
  Podcast presets replace ordinary descriptor stacks.
- Its exact-head gates passed all 259 Vitest files / 3,672 tests plus all 17 runner
  checks, production build/typecheck (4,945 modules), clean lint, a production
  dependency audit with 0 vulnerabilities, clean diff hygiene, and all 14
  Chromium browser tests. The 1280x720 Inspector regression proves master
  effect controls remain reachable; 720px transport groups remain disjoint and
  mixer controls retain 24px targets. The user explicitly waived the final
  user pass and authorized publication and merge; GitHub #189 is closed.
- Issue #188's bounded constant-rate first slice merged through PR #213 as
  `c846555`.
  `SourceTimeAudioPolicy` admits constant stretch. `createTimelineAudioMixPlan`
  emits tick windows. `pipeline/audioStretch.ts` is first-party WSOLA. Live
  and export pull the same session after 4,096-frame rechunk. Exact 1× stays
  on the old path.
- Issue #188's final ramp slice extends that same session rather than adding a
  second audio path. `createTimelineAudioMixPlan` clones one bounded
  `SourceTimeMap` descriptor with exact source-tick anchors and merged 0× hold
  ranges. Every grain re-anchors to adjacent canonical document-frame ticks,
  then interpolates only inside that sample interval. Uneven host pulls are
  byte-identical to one pull and cannot add or drop scheduled samples.
- Positive slow/fast legs stay pitch-preserved. Held 0× spans receive a bounded
  3 ms fade into exact silence; an entirely frozen contributor opens no decoder
  or stretch session. Exact 1× and PR #213's constant path remain unchanged.
  Invalid/reverse maps fail closed, live decode failures warn per clip, export
  failures reject, and cancel/seek/project replacement close sessions beside
  their decoder cursors.
- Constant and ramp sessions share the existing maximum of eight, 96,000-sample
  pull cap, 4,096-frame decoder rechunk, and 0.75 s live lookahead. The ramp
  descriptor remains bounded by 256 authored points and never allocates a
  duration-sized rate table or output buffer.
- Focused domain/pipeline/UI regressions cover direct/constant compatibility,
  positive and freeze ramps, exact source/sample boundaries, partition
  independence, pitch, discontinuity, latency, session admission, failures,
  cancellation, and repeated playback/export ownership. Repository Chromium
  generated speech and music WAVs, exercised 0.5×, 2×, positive and freeze
  ramps with #189 automation/effects and a #190 adjustment item, settled six
  playback generations to zero resources, exported and reopened exact 29.97
  fps / 48,048-sample A/V, decoded the result to verify non-silent authored
  speech/music pitch bands, and proved the live freeze interval sample-exact.
  It cancelled a second export and produced no console warnings/errors. The
  full 15-test Chromium suite is green. Complete gates pass 259 Vitest files / 3,702
  tests, all 17 repository runner checks, production build/typecheck (4,946
  modules), oxlint, the production high audit with 0 vulnerabilities, and diff
  hygiene. Exact-head review also locked absolute NTSC live sample boundaries,
  all-1× sub-frame compatibility, and decoder-free/offline whole-freeze
  preflight while preserving same-asset video and actual linked-crossfade
  handles without retaining transition-free, one-sided, or still-silent
  incoming pre-roll links. The final preflight uses one lazy O(n log n)
  structural link/transition index with per-track clip lookups, resolves source
  capacity before cross-track conflicts, and keeps immutable descriptor bounds
  separate from connected Blob ownership. A 100,000-clip ambiguous-link gate
  and an unavailable-versus-available cross-track regression preserve the
  surviving connected handle dependency. Code-derived resource accounting
  covers the maximum 4×/96,000-sample pull, rechunk, and WSOLA arrays below
  5 MiB/session and 40 MiB across eight sessions. Vite retains only its
  existing large-chunk advisory.
- Issue #72 is implementation-complete on `codex/issue-72-speed-ramps`.
  Timeline schema 12 adds an optional deterministic piecewise curve above the
  schema-11 constant fallback. Curves have one bounded integer origin, strictly
  increasing integer-frame points, canonical 0% or 25%–400% rational speeds,
  and explicit hold/linear/smooth outgoing easing. Duplicate-time edits replace;
  duplicate persisted points reject. A terminal freeze rejects so every clip
  duration remains finite, while a freeze bounded by a later positive point is
  valid. The 11→12 migration adds an empty curve without changing constant clips.
- `domain/sourceTimeMap.ts` integrates every segment from one BigInt-backed
  integer primitive, so direct evaluation and split/trim origins agree exactly.
  The same authority now drives duration, seeking/scrubbing, ordinary and
  transition composition, filmstrip tiles, waveform slices, source-handle
  capacity, animation remapping, preview, and export. Malformed in-memory curve
  intent uses the preserved constant visual fallback, fails audio closed, and
  is rejected by portable validation rather than silently rewritten.
- Ramp authoring reuses the Inspector's accessible curve patterns: add/select at
  the playhead, edit speed and outgoing easing, remove, clear, seek from the
  ordered point list, and receive linked/locked/bounds feedback. Linked A/V
  partners update atomically and every accepted gesture is one exact undo entry.
  Exact integer-origin 1× and all-1× curves retain the direct path; constant
  non-1× and variable positive ramps use shared pitch-safe WSOLA; only authored
  0× hold spans are silent.
- Issue #72's complete automated gate passes 2,226 Vitest cases across 159 files
  plus all 16 benchmark-runner cases, production build/typecheck, oxlint, the
  production high-severity audit with 0 vulnerabilities, and clean diff checks.
  Vite retains only its existing non-fatal large-chunk advisory.
- Real Chromium on exclusive strict port 41872 imported and relinked a
  22,145,940-byte, 90-second H.264/AAC source at 640x360/30 fps, then edited one
  linked 900-frame A/V pair into frame 0 at 100% smooth, frame 300 at 0% hold,
  and frame 450 at 200% smooth. The live duration became 825 timeline frames for
  900 source frames; scrubs at frames 325 and 425 retained the same frozen
  preview, playback advanced from frame 280 into the freeze, and undo/redo
  switched the hold segment and derived duration between 825 and 750 frames.
- A fresh recovery reload plus real media relink preserved all three points,
  easing choices, linked state, duration, and the explicit shared audio-silence
  policy. The full browser export produced
  `C:\Users\Aryel\Downloads\Issue 72 ramp browser QA.mp4`: 10,779,269 bytes,
  27.5 seconds, 1280x720 H.264 at 30 fps with stereo 48 kHz AAC. Decoded export
  frames 325 and 425 share MD5 `b8c95f7067d085238dc338d8bbdf3d2d`, while
  post-freeze frame 700 is `322361091126915850d683b8297e3764`; the intentional
  silent track measured -91.0 dB mean/max. Browser warnings/errors were zero.
  Screenshots are retained at
  `C:\Users\Aryel\AppData\Local\Temp\myrelith-issue72-freeze-scrub.png`,
  `...\myrelith-issue72-export-ready.png`, and
  `...\myrelith-issue72-recovered-ramp.png`; port 41872 was released.
- Issue #72 started from clean `master`
  `357d760c0105dda6d60e1300e61ab72401c3ba9a`, tree
  `3c02d0b20058efd4ac93aed148a6ed9df126b40b`, and tracked-index manifest
  `sha256:8c96e30b8cf8e6b62d4e34d70e74ce48883cdb01e1f7f596f83618150050ece3`.
  The final commit and PR head are the authoritative delivered identity.
- Issue #69 is implementation-complete on
  `codex/issue-69-constant-retiming`. Timeline schema 11 adds a durable exact
  rational `SourceTimeMap` for timed decoded media after schema 10's versioned
  effect descriptors. One million integer ticks per source frame and a public
  vocabulary of whole 25-percentage-point rates retain fractional out-points
  independently from whole-frame timeline duration without split/trim phase
  drift. Schema-9 projects retain the effect 9→10 migration before the 10→11
  exact-1× source-time migration; current portable snapshots always emit the
  map and durable keyframe source-time intent, while pure in-memory legacy
  fixtures retain a compatible 1× fallback at operation boundaries.
- `domain/sourceTimeMap.ts` is the single mapping authority for ordinary and
  transition composition, selectors/seeking, filmstrips, waveforms, handle
  capacity, trims, splits, slips, moves, and keyframe retiming. The pure retime
  operation keeps the clip start fixed, selects the greatest whole timeline
  span that fits the exact source interval, rejects overlap/locked/still/text
  edits by reference, reconciles transitions, clamps fades, and lets linked A/V
  groups commit atomically as one history entry, including mixed-rate groups
  with members already at target. Unsafe timeline ends and keyframe frame
  collisions reject atomically. Keyframes retain exact durable source-time
  intent across repeated and round-trip retimes without quantization drift.
- Non-1× audio is intentionally unavailable until Myrelith has a pitch-safe
  time-stretch implementation. The shared audio plan omits those contributors,
  live playback and export therefore agree on silence, and the Inspector says
  so explicitly. Exact 1× maps with integer source origins retain the previous
  audio path byte-for-byte. Muted audio-only contributors are also excluded
  from output asset requirements, offline/export gating, retained Blobs, and
  fetches; an asset still contributing video remains required.
- Issue #69's post-review automated gates pass: 375 focused tests across the
  eight retiming/review contract files, all 2,159 Vitest cases across 150 files,
  all 16 benchmark-runner cases, production build/typecheck, oxlint, the
  production high-severity audit with 0 vulnerabilities, and clean diff checks.
  Vite retains only its existing non-fatal large-chunk advisory.
- The integrated Issue #69 source identity is based on clean effect-stack
  `master` `c33ffa35aad0d8c2c993b6ccb6c9fbed4065c34c` /
  `sha256:77119aeef265c5fed69dbd0b7aaeea4d36dbb7da01dd52f2469e2027e81e8b04`.
  The completed dirty checkpoint before this evidence note was
  `sha256:4034ac7db9317fcd78e9444b21e124b96ffd94e742ea6e94af2bfd2d0facfa3d`;
  the final commit id is the authoritative delivered identity.
- Real Chromium on exclusive port 41869 opened and validated a schema-10
  effect-era portable fixture through the schema-11 migration, selected its
  timeline clip, verified 100% 120→120 and 150% 120→80 with the live audio-mute
  explanation, then Reset to exact 1×. A Position X key authored at frame 1
  quantized to frame 0 at 150% and recovered to frame 1 after Reset, proving
  durable source-time intent at the observable boundary. The fixture's media
  remained deliberately offline, so decoded-frame QA is covered by the shared
  composition/runtime tests rather than claimed as a browser result. Chromium
  reported zero warnings/errors and port 41869 was released after the pass.
- Issue #60 was normally merged through PR #85 as `809474f`; Issue #60 closed
  automatically.
  `mediaPoolModel` owns browser-free stable indexing, AND-token search,
  exact type/status facets, grid-row packing, and variable-height window math.
  `useMediaPoolVirtualizer` measures the existing sidebar scroll owner and
  renders one overscanned contiguous window. Cards keep asset ids as React,
  drag, relink, and accessibility identity; only mounted cards subscribe to
  thumbnails/waveforms. Search/filter/selection remain transient UI state and
  never mutate the project.
- Visible Media Pool ids now travel through the existing app facade into
  `mediaVisualsController`; selected timeline media still wins, while either
  visible timeline or Media Pool media outranks background work. The bounded
  scheduler, generation checks, cancellation, and resource ownership are
  unchanged.
- The 500-item component fixture proves fewer than 40 mounted cards, End-key
  focus/selection, cross-window drag and relink payloads, deterministic filters,
  and zero React commits for an offscreen visual update. The final complete gate
  passed 1,885/1,885 Vitest cases across 117 files plus all 16 Node runner cases,
  production build/typecheck, oxlint, zero-vulnerability production audit, and
  diff checks. There is no separate repository accessibility-audit command;
  semantic roles/names and keyboard behavior are covered by RTL and Chromium.
- In-app Chromium imported 500 real PNGs in five supported 100-file batches;
  the >100 guard supplied the error-state gate. Desktop rendered 12–15 cards,
  the 1,180px viewport rendered 8 in two columns, and the settled 800px viewport
  rendered 3 in one column. End reached positions 500/501 with focus retained;
  exact search returned one row in 136 ms end-to-end, empty/type/status states
  stayed deterministic, recovery reopened 500 sources offline with the relink
  control present at position 500, and the console had no warnings/errors.
  Browser file-chooser automation could not attach to the single-file relink
  input, so its actual file handoff remains covered by the passing component
  test rather than claimed as a Chromium action.
- Reproducible source identity started from clean baseline `df9ceef` /
  `sha256:0355e4252ca15f8d757ae5d9fffa97195d6e2945487f4af94901ef0175ff4782`
  and reached the browser-validated implementation checkpoint
  `sha256:0ff135313894df54a9aba0f638dc7d6b5e499236e265513d6e4d5b957df2c841`.
  The final commit id is the authoritative post-work source identity; the
  checkpoint intentionally predates handoff text and the final padding-alignment
  follow-up.
- Issue #65 adds project-format v5 Media Pool collections. Each ordered
  collection stores only its stable id, normalized unique name, and stable
  descriptor ids; an asset can belong to several collections without another
  media descriptor, URL, handle, or byte copy. Version 1–4 projects migrate to
  an empty collection catalog, while save, live save, recovery, and Resume carry
  v5 membership unchanged.
- `mediaStore` owns bounded collection-only undo/redo. Removing a collection
  leaves every source intact; removing an asset prunes it from current, past,
  and future collection snapshots. Offline descriptors keep their membership,
  and reconnecting the same stable id does not rewrite organization.
- The Media Pool applies selected-collection membership before its existing
  search/type/status pipeline and virtual row planner. Collection tabs use
  roving keyboard focus and remain drop targets while cards virtualize; each
  durable card exposes checkbox multi-membership, including offline cards.
- Issue #65's final gates passed: 7 focused files / 196 tests, 132 files /
  1,975 tests plus 16 benchmark-runner tests in `npm test`, production
  build/typecheck, oxlint, a zero-vulnerability production dependency audit,
  and clean diff checks. Vite still prints its existing non-fatal large-chunk
  advisory.
- Real Chromium on the exclusive `http://localhost:5175` imported 500 PNGs,
  kept the rendered card count bounded, searched the final asset in 57 ms,
  reached item 500 by keyboard, exercised collection CRUD/reorder/history and
  multi-membership, and stayed free of page overflow at 800×720. A new launcher
  tab recovered the project with 500 truthful offline descriptors while
  preserving all three collection names/counts and both memberships on the
  filtered asset. The console had no warnings/errors. Browser automation could
  not synthesize the HTML5 drag `DataTransfer`; the virtualized final-card drop
  remains covered by the passing component test rather than claimed as a
  Chromium action.
- Issue #65 source identity started at clean `7036e23` /
  `sha256:d3c715957a67cc796e3b3ace716712b8f55ef1e5a83c93c8759fe4fd5ec26360`
  and reached implementation checkpoint
  `sha256:5b708007c1d877db8fbb95f3660a4bb091e37a294498fe9759f55af34f9a7faf`.
  That checkpoint intentionally predates this handoff evidence; the final
  commit id is the authoritative delivered source identity.
- The Soft Studio visual overhaul is implementation-complete. The launcher now
  presents the real create/open/recovery flows through a warmer local-first
  hierarchy; project creation exposes the existing reviewed canvas presets as
  visual choices; and the editor keeps its real Media Pool, Program Monitor,
  contextual Inspector, transport, and timeline contracts inside one calmer
  navy system. Add Text moved from project actions to an accessible compact T
  beside the timeline tools. Generated photography ships as optimized WebP
  assets rather than fabricated editor content. The full suite passes
  1,806/1,806 tests across 105 files; build, oxlint, high-severity production
  audit, and diff checks pass with only the known Vite chunk-size advisory.
  In-app Chromium verified launcher, setup, editor, Inspector tabs, media/text
  interactions, Add Text focus restoration, exact reference viewports, narrow
  layouts without horizontal overflow, and zero console warnings/errors.
- Issue #43 is implementation-complete. Nested timeline schema 6 persists
  exact clip-local scalar curves for Position X/Y, Scale X/Y, Rotation, and
  Opacity; schema-5 projects migrate to empty curves without changing static
  appearance. One bounded pure evaluator owns hold, linear, and custom cubic
  Bézier behavior for Inspector, Program Monitor, scrub, playback, crossfades,
  and export. The accessible Inspector adds/selects/moves/edits/copies/removes/
  resets keys while timeline diamonds stay bounded. The full suite passes
  1,805/1,805 tests across 105 files; build, oxlint, and diff checks pass with
  only the known Vite chunk-size advisory. In-app Chromium reopened and
  quick-relinked real 320×180 H.264 media, proved keyed X=0/X=300 monitor and
  Inspector sync, custom Bézier editing, copy/move/remove/reset with exact undo,
  live playback interpolation, three timeline diamonds, and a completed
  120-frame MP4 export. At 720×800 the page had zero horizontal overflow and
  the curve controls remained contained; the final console had zero warnings
  or errors. Publication/Issue closure is intentionally not implied.
- Issue #35 is complete. Issue #34 had already delivered selected visual bounds,
  pointer move/scale/rotate/crop/anchor/flip gestures, immediate Inspector drafts,
  keyboard alternatives, one pointer-up document mutation, undo/redo,
  persistence, and shared preview/export rendering. The remaining Issue #35 gap
  was the single farthest-corner scale target: the Program Monitor now renders
  four explicitly named corner handles, resolves each cropped anchor-relative
  vector from the fresh pointer-down document, and safely preserves a freeform
  axis whose corner coincides with the anchor. The 82-test Inspector/preview
  gate and all 1,785 tests across 101 files pass; build, oxlint, production
  audit, and diff checks are clean. Real Chrome physically dragged all four
  corners on rotated, cropped, off-center-anchor, horizontally flipped
  320×180 media; every drag updated Inspector before release and created one
  history entry on release. At 720×800 all four fixed-size targets remained at
  least 28 px, independently hit-testable, and inside a page with no horizontal
  overflow or console warnings/errors. PR #51 passed CI at reviewed head
  `13ae345`, was normally merged as `4f9eaaa`, and retained `codex/feature`.
- Issue #34 is complete. Its frozen contract and six implementation slices live
  in PLAN.md and on the GitHub issue. The first slice owns nested timeline
  schema 5, visual/audio settings, schema-4 migration, strict validation,
  geometry-safe fade clamping, and one-entry document actions. Shared visual
  rendering now applies natural-scale normalized crop and explicit flips;
  shared live/offline audio now applies enable, stereo balance, frame fades,
  and transition envelopes from the same document facts. The contextual
  Inspector now exposes grouped resettable Video and Audio sections, linked
  A/V context, immediate sliders/toggles, bounded keyboard controls, and honest
  locked/disabled states. Program Monitor manipulation now covers move, scale,
  rotate, crop, anchor, and flip with ephemeral synchronized previews, keyboard
  alternatives, locked-state rejection, and one history entry per completed
  gesture. Slice 6 acceptance and publication closeout are complete.
  Slice 1 passes 218 focused and 1,761 total tests plus build, oxlint, production
  audit, and clean-diff gates. Slices 2–3 pass 117 focused and 1,768 total tests
  plus build, oxlint, production audit, and clean-diff gates. Slice 4 passes
  212 focused and 1,771 total tests plus build, oxlint, production audit, and
  clean-diff gates; in-app Chromium passed the video-control, focus, immediate
  preview/reset, 1280×720, 720×800, overflow, and clean-console checks.
  Slice 5 passes 87 focused and 1,782 total tests plus build, oxlint, production
  audit, and clean-diff gates; in-app Chromium passed pointer and keyboard
  manipulation, one-step undo, fixed-size control targets at 100× scale,
  responsive overflow, accessibility, and clean-console checks.
  Slice 6 adds explicit **Import & remember / Quick import**, **Relink &
  remember / Quick relink**, and **Choose & remember / Quick open** paths. The
  handle paths keep reusable browser permissions; the ordinary file inputs are
  always available without a proprietary picker or silent fallback. In-app
  Chromium quick-opened a validated portable project, opened its linked A/V
  clips offline, failed closed on an over-specific source-bounds fixture, then
  quick-relinked the real 2-second AVC/AAC fixture with one connected and zero
  skipped. It edited transform, scale lock, rotation, anchor, flip, opacity,
  crop, mono volume, and fades; played decoded media; recovered every value in
  a fresh tab; rendered the exact MP4/H.264/AAC selection; exposed and captured
  the completed MP4 download; kept offline mono Balance disabled from durable
  descriptor metadata; fit both picker surfaces at 720 px without horizontal
  overflow; and produced no console warnings or errors. The final focused gate
  passes 117 tests, the full suite passes 1,784 tests across 101 files, and
  build, oxlint, production audit, and clean-diff gates are green. PR #49 passed
  GitHub CI at reviewed head `2746016`, was normally merged as `571fff6`, and
  retained `codex/feature`; the final closeout closed only Issue #34.
- Issue #33 implementation and acceptance are complete. Text overlays are
  procedural timed clips with strict schema validation, generic browser font
  families, bounded wrapping, background/outline/shadow styling, and one shared
  Canvas2D path for preview and export. Add, select, edit, move, resize, delete,
  timeline geometry edits, undo/redo, save/load, schema 3→4 migration, and
  source-free export are covered. The 304-test focused gate, 1,747-test full
  gate, production build, oxlint, production audit, and diff checks passed.
  In-app Chromium created and edited a multiline text-only project without
  importing media, committed keyboard move/resize in exact 10 px steps,
  rejected an overlapping V1 range with a visible error, completed a real
  1920×1080 MP4 export, retained usable selected controls at 720×800, and had
  no unexpected console or page errors. Automatic speech-to-text, SRT/VTT,
  animated templates, motion graphics, and per-character effects remain out of
  scope. Reviewed head `05731fb` was normally merged through PR #47 as
  `eba39b6`; the retained `codex/feature` branch still contained the reviewed
  head, and only Issue #33 was closed as completed.
- The public-preview foundation is complete. PR #39 was reviewed at `a0f385a`,
  passed Linux CI, and normally merged as `256887b`. The
  `v0.1.0-alpha.1` prerelease points to that exact merge, includes the verified
  1,124,158-byte static build and checksum, and published the private
  legacy `ghcr.io/zyfvhcfh87-rgb/webcut:0.1.0-alpha.1` multi-architecture image at
  digest `sha256:837cc8ea8d2b5b206283580b5806053cf861886c26d03668abab27f58646ec8b`.
  Cloudflare production deployment `c85ceeb0-0913-44ec-8ea4-db79c815dd31`
  served the exact merge through the original preview hostname; the live launcher and
  legal routes were re-read after deployment. GitHub detects MIT and now shows
  the description, homepage, topics, community resources, release, and package.
  Myrelith has an MIT license, privacy notice, third-party/source notices,
  community and security policies, versioned changelog, CI, public `/privacy/`
  and `/licenses/` pages, and a non-root static container workflow. This permits an
  explicitly experimental alpha release; it does **not** certify patent
  clearance, production readiness, representative low-memory behavior, or all
  downstream redistribution obligations. Keep the AC-3/E-AC-3 FFmpeg and codec
  caveat visible in every release until a dedicated legal review resolves it.
- `v0.2.0-alpha.1` **First Light** was published on 2026-08-23 after release
  prep PR #176 passed exact-head CI and Bugbot at `e198ed1` and was normally
  merged as `2a845c8`. The annotated tag peels to that exact merge. Its verified
  43-file, 2,914,162-byte static web archive has SHA-256
  `aef2445b99969fb4285fdd287fd9f4cde5552938e9b890eee4b2e0bf8de73a96`;
  the attached checksum file and GitHub asset digest agree. Tag-triggered
  container run `32644089661` published the public `0.2.0-alpha.1` and
  `sha-2a845c8` tags as the same Linux AMD64/ARM64 OCI index at
  `sha256:ee060a7ea03d58dafc55152341db19d284dfd853c33354540a20043414a8aabd`,
  with provenance and SBOM attestations. Anonymous release, asset, package-page,
  and registry checks passed; the dynamic release badge resolved to the new
  version. The local Docker Desktop daemon was unavailable, so no local
  container-start smoke was claimed. Local release validation passed 3,335
  Vitest tests across 233 files, 17 benchmark-runner tests, production build,
  oxlint, a production audit with 0 vulnerabilities, and all 10 checked-in
  Chromium tests. The existing alpha, browser/codec, FFmpeg/patent, low-memory,
  and downstream-redistribution caveats remain in force.
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
  in-app converter exists. The project license and public notices were added
  for the alpha preview; representative low-memory certification and dedicated
  FFmpeg/codec patent review remain separate release work.
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
  (the render worker replaced the single-asset path). Their structural types
  now live in neutral `decode-types.ts`, while the obsolete chunk-batch render
  behavior is isolated behind named compatibility delegates. The retired
  modules and old exports remain because their tests document decoder
  semantics; deletion is a separate post-MVP cleanup. The Stage 2 isolation
  gate passed 186 focused tests across 8 files, all 1,672 tests across 88
  files, build, lint, audit, and diff checks. Real Chromium also passed H.264
  scrub, recovery/relink, same-asset-ID source replacement, and acknowledged
  worker shutdown with zero console warnings or errors.
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

## Post-MVP issue #54 - performance evidence foundation

**COMPLETE AND PUBLISHED (2026-08-07; PR #81).**

- The opt-in production benchmark route owns a deterministic, validator-clean
  100-asset / 8-track / 30-minute fixture with 320 clips, 39 crossfades,
  20 procedural text clips, and 25 representative 4K descriptors. Bounded live
  sources include one generated 4K AVC/MP4, six 4K still connections, and four
  audio connections.
- The production runner records launcher/editor readiness, scrub and render
  latency, dropped frames, audio underruns, import readiness, complete
  CDP-scoped Chromium process-memory plateau/growth, and export real-time ratio.
  JSON and Markdown include per-process raw memory rows and host provenance,
  median/p75/p95, variance, exact source/fixture SHA-256 fingerprints, CDP GPU
  renderer/vendor/driver plus acceleration identity, browser, runtime, device,
  warnings, and independently checked cleanup/restoration. Missing renderer,
  GPU, CDP, or full PID coverage makes memory unavailable rather than partial.
  Input-to-present diagnostics publish only after a test-injected browser
  paint/compositor boundary following the matching completed worker draw.
- Fixture identity includes the portable project, connected source/scrub plan,
  and stable generation settings/sample plan; browser-dependent encoded bytes
  are excluded so identical logical runs retain one canonical identity. The
  pre-run canonical-state check recomputes that identity. Fixed media supports
  continuous trials through 2,000 ms playback
  and 31 export frames; both CLI and runtime reject longer requests before
  measurement instead of entering the encoded held tail.
- `npm run benchmark` builds an explicitly enabled production bundle in one
  unique OS-temporary directory, previews that exact directory, and recursively
  removes it on success/failure without touching ordinary `dist/`. It writes
  ignored JSON/Markdown/screenshot artifacts under `.tmp/benchmarks/`. Proposed
  gates remain advisory until repeated representative-device baselines ratify
  them. The exact workflow and gate definitions live in `docs/PERFORMANCE.md`.
- The default production build contains zero matches for the benchmark path,
  title, fixture version, or component name. The explicitly enabled build emits
  dedicated `PerformanceBenchmarkApp` JS/CSS chunks and serves only the exact
  route. The architecture guard permits only the exact benchmark runtime to
  compose app/state and the exact benchmark component to reuse UI; no blanket
  `src/dev` composition-root exception remains.
- Canonical `npm test` now runs both 1,847/1,847 Vitest cases across 110 files
  and all 16 Node runner cases without recursion. Focused benchmark coverage,
  production build/typecheck, oxlint, and production dependency audit all pass
  with 0 vulnerabilities. Fresh smoke and full Chromium runs captured their
  artifacts, reported 0 dropped frames and 0 audio underruns, revoked 11/11
  fixture URLs (plus 2/2 and 7/7 imported URLs respectively), restored every
  isolated store, and logged no browser warning/error. The full run retained
  frame-render p95 and export-ratio p75 misses as advisory trend evidence, not
  enforcement failures.
  Both fresh runs shared canonical fixture fingerprint
  `sha256:07f2bd5bd724e5b6b7c07e2fbd26a5b67b7c3c80bba87f8f0d8fdce2bcb904f7`.
  Smoke/full process-memory evidence contained 2/7 complete CDP process-table
  samples respectively, using Windows private bytes from
  `powershell:Get-Process`; both artifacts validated against schema 2.
- In-app Chrome independently rendered the ready fixture at 1248x1248 with no
  framework overlay, warning/error log, or horizontal page overflow. Zoom In
  changed the real slider from 0.725 to 0.748. The automated production run's
  1440x900 screenshot rendered the completed human-readable summary.
- Reviewed head `f873818` was normally merged through PR #81 as `9920491`;
  Issue #54 closed automatically.

## Post-MVP issue #55 - launcher and editor bundle split

**IMPLEMENTATION COMPLETE (2026-08-07); DELIVERY TRACKED BY PR #83.**

- `App.tsx` now owns only the eager launcher path and accessible editor
  loading/failure states. `EditorShell.tsx` owns the lazy editor composition,
  shortcuts, runtime lifecycles, and editor CSS. New/open/recovery preloads the
  shared editor module before controller activation, so a missing chunk cannot
  mutate project truth or flash an incomplete editor.
- Remembered-project recovery starts that preload as soon as its candidate is
  available and keeps the final action disabled until the editor is ready. The
  permission activation itself still begins synchronously inside the user's
  click, preserving the transient File System Access activation window; preload
  failure leaves both the launcher and resume candidate unchanged. Leaving the
  Resume screen while preload is pending clears its busy state before another
  launcher flow begins.
- The ordered CSS cascade is split without reordering: `launcher.css` eagerly
  loads the launcher plus recovery states, while `layout.css` begins at the
  editor shell. Architecture tests walk static runtime imports and fail if the
  launcher regains EditorShell/Toolbar/Inspector or if EditorShell eagerly
  regains ExportDialog/TextOverlayDialog/AnimationCurveEditor.
- Export, Add Text, and animation curves use shared accessible Suspense/error
  boundaries whose dialog fallbacks own focus and contain editor shortcuts.
  Animation remains mounted after first use so tab switches do not discard its
  local edit state. Export registers its disposer through a tiny loaded-module
  lifecycle seam, letting project replacement stop a real export without
  importing the controller on every editor entry.
- The ordinary initial production graph moved from 1,088.92 kB raw / 290.93
  kB gzip JavaScript plus 83.71 / 16.50 kB CSS to 890.86 / 241.60 kB
  JavaScript plus 22.54 / 5.32 kB CSS. Initial gzip JS+CSS is 19.7% smaller.
  EditorShell, its CSS, Export, Text, and Animation are separate deferred
  chunks; the existing large-chunk warning remains advisory.
- Exact-source three-sample artifacts under ignored `.tmp/benchmarks/` record
  launcher median 163.5 -> 146.1 ms (-10.6%) and p95 238.4 -> 211.5 ms
  (-11.3%) on the same Chromium 151 / RX 6600 host and canonical fixture.
  The harness's unrelated stress render/memory/export proposals remain
  advisory and retain their honest misses. `docs/PERFORMANCE.md` holds the
  comparison and interpretation.
- Production Chromium proved the launcher request graph excludes editor and
  secondary chunks; Create then loads the editor only; Export and Add Text load
  on first use and restore trigger focus. A forced editor-chunk 503 left the
  setup form/project truth untouched, exposed the truthful Reload action, and
  recovered to a clean launcher. The 720x800 editor had no horizontal overflow
  and the ordinary success path logged zero warnings/errors.
- After integrating published PRs #82 and #84, the complete gate passes
  1,877/1,877 Vitest cases across 116 files plus all
  16 Node benchmark-runner cases, TypeScript/production build, warning-free
  oxlint, production dependency audit with 0 vulnerabilities, diff checks,
  two exact-source three-sample benchmark runs, and the production Chromium
  acceptance/failure matrix above.

## Post-MVP issue #56 - bounded media-analysis scheduler

**COMPLETE AND PUBLISHED (2026-08-07; PR #84).**

- `MediaJobScheduler` owns a bounded priority queue with a default maximum of
  two active asset jobs and two reserved decoder slots. Jobs expose generation,
  progress, queue wait, active decoder, completion, cancellation, and typed
  failure facts through bounded serializable snapshots. Native
  `scheduler.yield()` is used when available, with a zero-delay timer fallback.
- `mediaVisualsController` now schedules every filmstrip, still thumbnail, and
  waveform job instead of launching the complete pool at once. The primary
  selected clip's asset outranks assets intersecting Timeline's exact visible
  half-open frame range, which outrank background assets; queue aging prevents
  starvation and reprioritization preserves generation/FIFO identity.
- Removal, replacement, supersession, and disposal abort queued or active work.
  Mediabunny Inputs are disposed exactly once, late generated URLs are revoked,
  stale generations cannot mutate stores, a failed sibling releases the other
  result before compatibility disconnects the source, and one failed asset does
  not block later work.
- Performance artifact schema 4 adds deterministic
  `issue-56-100-assets-v1` evidence. The fixture-kind plan models 145 legacy
  launch-all decoder slots; both smoke and full production Chromium runs peaked
  at two active jobs/two decoders, drained a queue of 100 to zero, completed
  101 jobs, cancelled one, failed zero, observed progress, and started selected
  and visible work before background. Schema 4 keeps the scheduler wait and
  event-loop-delay distributions for comparison without proposing a product
  threshold from one machine.
- Full Chromium cleanup revoked 11/11 fixture and 7/7 imported URLs, restored
  every isolated store, disposed preview/transport/export, and captured no
  browser warning/error. Product performance proposal outcomes varied between
  consecutive full runs, as expected for advisory single-device trend data;
  they remain visible in each artifact and are not scheduler enforcement gates.
- Validation passed 1,867/1,867 Vitest tests across 113 files plus all 16 Node
  runner cases, production build/typecheck, oxlint, production audit with zero
  vulnerabilities, `git diff --check`, smoke/full production benchmarks, and
  in-app Browser QA. Six real H.264/AAC files all reached Ready with filmstrips;
  Zoom In remained responsive (0.719→0.741) and the console stayed clean.
- All review feedback was resolved. Exact head `902078f` passed CI, the full
  gate, and a final Codex review with no major issues, then was normally merged
  through PR #84 as `b431623`; Issue #56 closed automatically.

## Post-MVP issue #57 - runtime and document-memory telemetry

**COMPLETE AND PUBLISHED (2026-08-07; PR #82).**

- The issue #54 harness now emits schema 3 / `issue-57-v1` evidence. A pure
  domain estimator separates authored UTF-8 size, undo/redo serialization,
  additional shared retained-graph cost, and structural-sharing savings. Its
  fixed assumptions and exclusions are embedded in every artifact; it is not
  presented as browser heap usage.
- The isolated fixture builds six deterministic undo snapshots while ending
  on the exact authored document and preserving the existing fixture
  fingerprint. Export temporarily replaces and then restores the complete
  document/history state, not only the current document.
- Render-worker telemetry is dormant by default and enabled/reset only by the
  benchmark. Typed bridge snapshots classify live sources/decoders, queue
  depth/max depth, cache hits/misses, retained still bytes, streaming bitmap
  and canvas cache estimates, and VideoFrame/ImageBitmap/static-source close
  counts. Audio diagnostics add active decoder cursors and pending buffers.
- Each process-memory batch is now a bounded long-health cycle: playback,
  live worker/audio capture, scrub pressure, pause/drain, GC/paint settling,
  drained capture, then the unchanged complete CDP process-table sample.
  Drained worker samples fail their explicit cache-drain check if any decoder,
  pending copy/open, render/decode queue, or streaming bitmap remains.
- A balanced ABBA control/instrumented scrub metric measures aggregate
  telemetry overhead across identical frame sequences with an advisory 10%
  proposal. Long-animation-frame observation is bounded at
  500 entries. `measureUserAgentSpecificMemory()` remains optional lab-only
  evidence; absence or rejection becomes `unavailable` without degrading the
  editor or benchmark. No memory byte cap was introduced.
- Focused coverage passed 190 tests. The complete gate passed 1,852/1,852
  Vitest cases across 111 files plus all 16 Node runner cases, production
  build/typecheck, oxlint, diff checking, and the production audit with 0
  vulnerabilities. A fresh Chromium smoke artifact validated against schema 3
  with two complete private-byte process samples, two passing drains, measured
  long-animation-frame entries, explicit unavailable lab-memory evidence,
  11/11 generated URLs revoked, all isolated stores restored, and no console
  warning or error. Reviewed head `a857455` passed CI and was normally merged
  through PR #82 as `f7eedab`; Issue #57 closed automatically.

## Post-MVP issue #59 - indexed frame planning

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-07).**

- Added a browser-free, immutable half-open frame index. Sorted disjoint clip
  and transition ranges use binary search; invalid or overlapping authored
  ranges deliberately preserve the old first-match scan semantics.
- `createVideoCompositionPlanner()` now snapshots one clip and transition
  index per visible track. Repeated frame requests reuse those indices, while
  rebuilding a planner after an authored document change naturally rebuilds
  them. Ordinary clips, procedural text, animation curves, and crossfade paint
  order retain exact legacy output.
- Advanced the performance artifact to schema 5 / `issue-59-v1`. It records
  dense and sparse distributions for the legacy and indexed planners, checks
  exact JSON parity before timing, and includes explicit transition-boundary
  frames in every scenario.
- A production Chromium run against validation snapshot `69b7bad` measured
  dense p95 at 0.04492 ms legacy versus 0.00258 ms indexed (94.26% faster),
  and sparse p95 at 0.05871 ms versus 0.00305 ms (94.81% faster). Both
  scenarios matched all 256 parity frames, including 36 boundary frames, and
  the run restored stores and revoked every generated URL.
- The complete isolated gate passed 1,884/1,884 Vitest cases across 118 files,
  all 16 Node runner cases, production build/typecheck, oxlint, diff checking,
  and a production audit with 0 vulnerabilities. In-app Chromium creation,
  procedural-text preview, stepping, playback/pause, and console QA also
  passed cleanly.

## Post-MVP issue #58 - adaptive preview resolution

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-07).**

- A pure `PresentationProfile` resolves Auto/Full/Half/Quarter into output
  dimensions, one uniform presentation scale, device-pixel policy, and an
  explainable playback/scrub/paused/export reason. Auto keeps paused frames at
  Full and selects the smallest playback bucket that covers the measured
  monitor pixels; missing viewport evidence conservatively resolves to Full.
- The quality preference is session-only. The compact accessible Program
  Monitor selector and viewport observer send presentation intent through the
  app controller and render bridge; document geometry and project files remain
  unchanged.
- The worker resizes and reuses its visible, scratch, transition-leg, and
  transition-group surfaces. A profile change supersedes stale work. The shared
  compositor applies one outer project-space scale, so transforms, crops, text,
  animation, stills, and transition geometry retain the same authored meaning.
- Export supplies an explicit Full profile and remains fixed to the project
  dimensions regardless of the live preview selection.
- Focused coverage exercises profile resolution, store behavior, controller
  transport/DPR changes, bridge supersession, worker surface reuse, scaled
  ordinary/text/transition composition, and explicit full-resolution export.
  Real Chromium verified a 3840 × 2160 project at 3840 × 2160 when Auto-paused,
  960 × 540 while playing, and back to 3840 × 2160 on pause without changing
  the 449 × 249 CSS monitor box; the selector stayed usable at 720 × 800 and
  the export dialog remained fixed at 3840 × 2160 with a clean console.
- Matched clean full-harness snapshots (`df9ceef` before, staged Issue #58 tree
  after) retained 0 dropped frames and 0 audio underruns. Seven complete CDP
  process-table samples lowered the memory-plateau median from 2045.7 to
  1914.0 MiB (-6.4%) and p95 from 2151.8 to 1989.8 MiB (-7.5%). Frame-render
  p95 moved 41.57→40.06 ms (-3.6%) and scrub input-to-present p95
  49.67→49.29 ms (-0.8%): decoding full-resolution source frames still
  dominates those latency samples, so the result is memory-first rather than a
  large decode-speed claim. Export stayed effectively unchanged (median
  real-time ratio 7.301→7.332). The growth-rate p95 was noisy because one
  allocation spike was followed by a reclamation; no leak improvement is
  claimed from that derived metric. Both artifacts cleaned 11/11 URLs, restored
  every isolated store/controller, and captured no console warnings or errors.

## Post-MVP issue #64 - timeline markers

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-09).**

- Timeline schema 7 persists an explicit, bounded sequence-marker list with
  stable ids, integer frames, labels, palette colors, and optional notes.
  Schema-6 projects migrate to an empty list; current/legacy branded save,
  recovery, and portable project paths share the same strict validator.
- `domain/timelineMarkers.ts` owns immutable add/edit/move/duplicate/delete and
  next/previous navigation. `(frame, id)` order makes equal-frame and boundary
  results deterministic. Clip-derived output duration stays unchanged while a
  separate UI extent keeps far markers scrollable and included in Full Zoom.
- Marker selection and the explicit editor are session-only. Document-store
  actions create one undo entry per committed gesture; reconciliation drops
  deleted/stale marker selection without resurrecting it through history.
- The ruler renders accessible color flags, selected/offscreen feedback, an
  explicit label/frame/color/note editor, focus-local Delete/Duplicate/
  Previous/Next controls, global add/navigation shortcuts, and discoverable
  command-palette actions. Marker controls stop ruler scrub gestures.
- Visible marker planning binary-searches the sorted array and clusters by
  pixels, bounding rendered controls by viewport width. Focused coverage
  includes 20,000 spread and equal-frame markers, existing ruler render
  isolation, keyboard editing, migration, history, and portable round trips.
- Final local gates are green: 125 focused tests, all 1,979 repository tests
  plus the 16 benchmark-runner tests, TypeScript + production Vite build,
  oxlint, and the canonical production dependency audit (0 vulnerabilities).
  Vite retains the repository's advisory large-chunk warning.
- Real in-app Chromium verification used only
  `npm run dev -- --port 5174 --strictPort` and
  `http://localhost:5174`. It covered create/edit/move-to-frame-10000,
  fixed-viewport offscreen reveal, equal-frame clustering, duplicate,
  focus-local Delete, undo, command discovery, next/previous shortcuts, and
  recovery status at 1280×720; the browser warning/error log was empty.
- Publication is a draft PR only. Merge, deployment, and issue closure remain
  separate and are not authorized by this implementation.

## Post-MVP issue #68 - caption tracks with SRT/VTT round trips

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-09).**

- Timeline schema 8 persists semantic caption tracks and cues with stable,
  portable ids; half-open integer-frame ranges; plain multiline text;
  BCP-47-compatible language; subtitle/caption role; classic/boxed/minimal
  style preset; and track visibility. Schema-7 projects migrate to an empty
  list, while current save, live save, load, recovery, and Resume use the same
  strict validator. SRT has no durable cue-id field, so its imports mint ids;
  WebVTT cue identifiers are retained only when portable and non-colliding.
- `domain/captions.ts` owns immutable track/cue validation and edit semantics.
  Cues may overlap, touching ranges do not overlap, and no more than eight
  visible cues may be active at one frame. The document is bounded to 32
  tracks, 20,000 cues per track, 50,000 cues and 2,000,000 caption characters
  total, 4,000 characters per cue, and frame 1,000,000,000. Empty/outer-space
  text and markup reject instead of being silently changed.
- `domain/captionFiles.ts` uses exact integer arithmetic at the document's
  rational frame rate. Import floors start milliseconds and ceils end
  milliseconds so every file-covered frame survives. Export ceils starts and
  floors ends to the millisecond boundaries that map back to the same authored
  frame range. Tests cover 24, 25, 30, 50, 60, 24000/1001, and 30000/1001.
  SRT and WebVTT support BOM/CRLF, multiline cues, and VTT NOTE blocks. VTT
  STYLE/REGION/X-TIMESTAMP-MAP/cue settings and all caption markup reject with
  typed, line-specific errors. The complete file parses and validates before
  one history commit, so malformed input is atomic.
- Caption composition remains explicit in `videoCompositionPlan`: active
  semantic cues are appended above visual tracks and reuse the shared Canvas2D
  text layout/paint implementation without becoming clips or requesting media
  decode resources. The same plan drives paused seek, playback, and full-size
  export; captions also extend derived document/export duration.
- The lazy Caption editor provides accessible track metadata, bounded 200-row
  cue rendering, listbox Arrow/Home/End navigation with seek, add/edit/delete,
  previous/next, split, touching-cue merge, shift-all/shift-from-selected, file
  import, and SRT/VTT download. Focus is trapped in the dialog, Escape closes
  it, and focus returns to the toolbar. Each edit/import is ordinary undoable
  document history.
- Final local gates are green: 144 test files / 2,046 tests plus the 16
  benchmark-runner tests, TypeScript + production Vite build, oxlint, and
  `npm audit --omit=dev --audit-level=high` with 0 vulnerabilities. Vite still
  prints the repository's non-fatal large-chunk advisory.
- Real Chromium QA used only `http://127.0.0.1:41868`. It covered add/edit and
  metadata, dialog accessibility/focus return, caption-only preview pixels,
  exclusive-end seek disappearance, recovery reopen, valid multiline SRT
  import (`0–30`, `30–75`), line-specific malformed-SRT rejection with both
  existing cues unchanged, SRT/VTT downloads, and Ctrl+Z import reversal.
  A caption-only Compatibility export produced a 30-frame, 1920×1080,
  30 fps H.264 MP4 (`sha256:9c9f2d165261b445be98474c1db82e52c5ea6fc894f72f66a4522fdaee0411e6`);
  Chromium reopened it at readyState 4, played it natively with no media error,
  and showed the same caption pixels. Console evidence reported 0 warnings and
  0 errors. Visual/video evidence is in `output/playwright/issue-68/`.
- Reproducible source identity started at clean
  `c8bb2757833fa69da2360a56460bea6fd03274c0` /
  `sha256:1be12fbeed146910d5339d4f10696f719c9e0d247290d6bb8b0eeb378faedd1d`
  and reached the browser-validated implementation checkpoint
  `sha256:4fdd045a9fbdcda1938124f51cd9fd49b53dc114e1a2acd7e8767a9aaecc1473`.
  The checkpoint intentionally predates this evidence block and the final
  keyboard-friendly metadata-draft follow-up; the final commit id is the
  authoritative delivered source identity.
- Publication is a ready-for-review PR because later merge was explicitly
  authorized. The coordinating task still owns review/rebase/merge order;
  this implementation does not merge, deploy, or close the issue itself.

## Post-MVP issue #46 - minimal blend modes and compositing foundation

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-09).**

- Timeline schema 9 persists an explicit blend-mode intent on every visual
  clip. New and migrated clips write `normal`; `multiply`, `screen`, and
  `overlay` round-trip exactly. Bounded unknown strings are retained through
  save, recovery, undo/redo, and portable project paths while current rendering
  safely resolves them to source-over-compatible Normal. Schema-8 caption
  tracks migrate intact while their clips receive the blend default.
- `domain/blendModes.ts` owns the browser-free names, compatibility resolution,
  transition-group rule, and sRGB source-over reference-pixel model. The
  normative layer order, opacity timing, straight/premultiplied-alpha boundary,
  clipping, isolation, color-space, and transition semantics are recorded in
  `docs/BLEND_MODES.md` and locked by exact pixel fixtures.
- Preview and export share the same composition plan. Canvas2D probes each
  concrete operation, restores its previous state even when probing throws,
  and falls back to source-over without discarding stored intent. A backend
  capability adapter leaves an explicit WebGL parity-registration seam; no
  shader backend is claimed today.
- Text layers render into isolated scratch surfaces before clip opacity and
  blend are applied once. Crossfade legs remain Normal inside one isolated
  group and the agreed group mode is applied once to the destination; mixed or
  unsupported requests resolve the group to Normal. Scratch pixels are cleared
  before reuse and on every success/failure exit, and Canvas state restoration
  is guarded by `finally` paths.
- The Inspector exposes an accessible native selector and explicit reset,
  disables both on locked tracks, and explains preserved unsupported intent.
  The canonical document-store action creates one undo step per selection.
- After rebasing onto caption head
  `78d0d0756a9b9248d8c08f485bf4892407279347`, the reconciliation-focused gate
  passed 280 tests across 10 files. The complete repository gate passed all
  2,077 Vitest cases across 146 files and all 16 benchmark-runner cases.
  Production build/typecheck, oxlint, diff checking, and
  `npm audit --omit=dev --audit-level=high` are green; Vite retains only the
  repository's advisory large-chunk warning. The explicitly requested
  all-dependency `npm audit --audit-level=high` reports two inherited
  high-severity development-only transitives (`nanoid` and `undici`); this
  branch's `package.json` and lockfile are identical to `origin/master`.
- Real in-app Chromium used only
  `npm run dev -- --port 41846 --strictPort` and `http://localhost:41846`.
  The original gate used a 1920x1080 project with overlapping V1/V2 text layers
  to exercise all four choices, Screen undo to Overlay and redo to Screen,
  reset to Normal, locked control disabling, Overlay preview, and a successful
  MP4 export-ready result. The post-rebase gate added a semantic caption cue
  above the same isolated composition, reached MP4 Export ready, then reloaded
  recovery and retained the cue, both clips, and exact Overlay intent. The
  final browser warning/error log was empty, no error overlay appeared, and
  port 41846 was released. The inspected post-rebase screenshot is
  `issue-46-rebase-schema9-persisted.png` in the task visualization artifacts.
- Publication is a ready-for-review PR targeting `master` because later merge
  was authorized for the coordinating task. This implementation does not merge,
  deploy, or close the issue itself.

## Post-MVP issue #67 - snapping and alignment guides

**IMPLEMENTATION COMPLETE (2026-08-09).**

- `domain/timelineSnapping.ts` is the single browser-free source of truth for
  playhead, clip-start/end, transition-start/end, and marker candidates. It
  converts the 8px tolerance through the current zoom into integer frames,
  clamps to gesture bounds, and breaks ties deterministically by distance,
  candidate kind, frame, track order, and stable ids.
- Candidate planning excludes the moving clip/link group, locked or hidden
  tracks, ineligible track kinds, and their attached transitions. Global
  playhead and marker anchors remain eligible across compatible lanes.
- Clip move/trim/ripple/slide previews and applicable Ctrl/Cmd+Arrow moves use
  the same resolver. The ruler uses it for playhead scrubbing. Holding Alt
  bypasses snapping for that move without changing the persisted preference;
  the toolbar exposes the preference as a keyboard-focusable pressed-state
  button with explanatory accessible text.
- The visible guide is transport-only state with an adjacent live status. A
  pointer preview changes no document/history state, pointerup dispatches the
  existing single document action, cancel/lost capture clears the preview, and
  an already-aligned keyboard move creates no phantom undo entry.
- Focused validation passed 136 tests across the resolver, preferences,
  transport state, toolbar, ruler, move, and edit gesture surfaces. The final
  regression gate passed all 2,023 Vitest tests plus all 16 benchmark-runner
  tests; TypeScript + production Vite build and oxlint are green; the required
  production dependency audit reports 0 vulnerabilities. Vite retains only
  the repository's advisory large-chunk warning.
- Real headed Chromium QA used only
  `npm run dev -- --port 41867 --strictPort`. At 1px/frame and 2px/frame it
  covered playhead, marker, and transition-edge snaps; closer hidden/locked and
  wrong-kind anchors; pointer preview/history isolation; one-entry commit;
  Alt bypass; persistent off/reload/on preference; keyboard snap and snapped
  no-op; guide cleanup; 1280×720 and 800×720 layouts; and an empty console
  warning/error log. The synthetic store-seeded timeline fixture deliberately
  avoided media decode/export because snapping owns authored timeline geometry,
  not pipeline resources.
- Source fingerprints: clean base `c8bb275` was
  `sha256:89ee303aad205fd8ef1736e2ea63cc2cc454660442d4543d554de4d91088be87`;
  the completed implementation checkpoint was
  `sha256:8cc9e64ea4f5b3f21d20dda536fca647fc8945f568cfe31f698c166855942bc0`.
  The final commit SHA is the authoritative publication identity.
- Delivery is a ready-for-review PR targeting `master`, with merge and issue
  closeout left to the coordinating task's dependency-order review.
- The post-Issue-#68 rebase onto
  `78d0d0756a9b9248d8c08f485bf4892407279347` combined both completion records
  in this file and PLAN.md. Caption schema 8, its schema-7 migration, caption
  operations/import/render/editor code, and snapping production behavior were
  unchanged; only the snapping unit-test fixture needed the current schema 8
  plus explicit empty `captionTracks`.
- Post-rebase validation passed 15 targeted architecture/snapping/caption files
  with 233 tests, all 145 repository files with 2,062 tests, all 16
  benchmark-runner tests, TypeScript + production Vite build, oxlint, and diff
  checks. The requested all-dependency high-severity audit reports the same two
  dev-only transitive findings as `master` (`nanoid` through Vite/PostCSS and
  `undici` through jsdom); manifests/lockfile are unchanged and the production
  dependency audit remains 0 vulnerabilities. Browser QA was not repeated
  because conflict resolution and the only compatibility fix were docs/tests;
  the original headed Chromium snapping evidence above remains applicable.
- The final post-Issue-#46 integration rebase onto
  `1a09f782e28ac3f23a0b599ed56a86eca763ff2f` keeps captions semantic/topmost,
  preserves schema 8 and its 7→8 migration, and preserves schema 9 blend intent,
  the 8→9 Normal default, and the shared preview/export compositor. Only this
  evidence log and PLAN.md conflicted. The snapping fixture advanced to schema
  9 with empty caption tracks and explicit `normal` blend intent; no caption or
  blend schema/migration/composition source changed in the snapping commit.
- Final integration validation passed 21 targeted files / 385 tests across all
  three slices, all 147 repository files / 2,093 tests, all 16 benchmark-runner
  tests, TypeScript + production Vite build, oxlint, and diff checks. The
  all-dependency audit retains the same two inherited dev-only highs while the
  production audit reports 0 vulnerabilities. Browser QA was carried forward
  because the final rebase resolution and compatibility change were docs/test
  fixture only; no production or observable behavior changed.

## Post-MVP issue #45 - versioned visual-effect stack foundation

- Timeline schema 10 adds an explicit non-negative registry `version` to every
  ordered `EffectDescriptor`. The 9→10 migration upgrades the owned
  `builtin.color-adjust` legacy shape with defaults while assigning version 0
  to unknown types and retaining their type, enabled state, order, and complete
  bounded primitive payload. Save/load snapshots clone every descriptor field.
- `domain/effectStack.ts` is the pure registry authority. Each registration owns
  its parameter validation, migration hook, capability declaration, defaults,
  label, and evaluation function. Resolution returns ordered `ready`,
  `disabled`, `invalid`, or `unsupported` records; unsafe entries are preserved
  and bypassed without aborting later effects.
- The proof effect exposes exposure (-4…4 stops), contrast (-100…100%), and
  saturation (-100…100%). Its Canvas2D filter chain is applied in authored
  order during the source draw before opacity/destination blend. Empty or fully
  bypassed stacks do not write filter state. Ordinary media needs no scratch;
  text and crossfade legs reuse and release the compositor's existing bounded
  caller-owned surfaces.
- Preview, seek/playback, and export receive the same animation-resolved clips
  through `videoCompositionPlan` and execute effects only in
  `pipeline/render.ts`. There is no React evaluator and no second export path.
- Pure add, enable/bypass, parameter patch, exact-index reorder, reset, and
  remove operations reject locked/missing/invalid edits without mutation. Store
  adapters commit every success as one history snapshot. Reset retains unknown
  forward-compatible parameter keys; unsupported descriptors still expose
  bypass/reorder/remove so their data is not stranded.
- The Inspector adds a fourth roving tab plus native labeled controls, ordered
  position text, status badges/details, and explicit Move up/down, Reset, and
  Remove labels. Unknown/invalid states remain visible and actionable.
- Focused validation passed 306 tests across effect registry, operations,
  history, project migration/round-trip, compositor, Inspector, and architecture
  files. Full validation passed 148 Vitest files / 2,108 tests and all 16
  benchmark-runner tests. TypeScript/production build, oxlint, production audit,
  and diff checks are recorded in the delivery PR.
- Source fingerprints: clean base `718c0d28e3611e2bad3b511d45ce1e3adcba0270`
  was `sha256:5acd7a8b1c89f0eafeef6ca504d183c18f415835da1fb994a65a97427ad84745`;
  the completed dirty implementation checkpoint was
  `sha256:f791a282c72b571bdaff260e32a0232eb8ee0caf80cf40b1c66a9688d66e7a41`.
- Real Chromium on exclusive `http://127.0.0.1:41845/` created a text clip,
  reached Effects by ArrowRight focus movement, added two effects, edited all
  three proof parameters, visibly changed the Canvas output, bypassed/reordered/
  reset/removed, restored reorder and removal with undo/redo, and recovered both
  ordered descriptors after reload. An effected 150-frame 1920×1080 MP4 reached
  `Export ready` with a Blob download link through the shared compositor. The
  in-app browser did not expose a download event for that Blob link, but export
  completed successfully; the final console contained 0 warnings/errors and
  port 41845 was released.
- The publication is a ready PR to `master` with `Closes #45`. Do not merge it
  here; the coordinating task will review and integrate #45 before rebasing #69
  and then #70.
- PR review remediation keeps one `domain/effectBounds.ts` contract between
  live editing and portable validation. Exact-limit edits serialize; any
  per-clip, per-document, parameter, key/value, string, or finite-magnitude
  overflow returns the same document and adds no undo entry. Inspector Add is
  disabled with the shared reason when the selected budget is exhausted.
- Preview effect status now comes from the worker's actual Program Monitor
  compositor capability report via bridge/controller/session projection. The
  Inspector reads this state and never evaluates effects itself. Export still
  probes its separately owned context through the shared compositor, so its
  capability can legitimately differ from preview.
- Procedural text now paints background, outline, and fill unfiltered into the
  existing reusable leg, then filters that completed layer on its single
  destination draw before opacity/blend. This adds no surface, retains
  crossfade group behavior, and restores/clears borrowed contexts in `finally`.
- Post-review validation passed 11 focused files / 466 tests, all 149 Vitest
  files / 2,124 tests, all 16 benchmark-runner tests, TypeScript plus production
  build, oxlint, the architecture boundary guard, production audit at 0
  vulnerabilities, and clean diff checks. The benchmark captured hardware-
  accelerated Chromium with no browser warnings/errors; its advisory stress
  thresholds remain benchmark evidence, not Issue #45 acceptance gates.
- Real Chrome used only `http://localhost:41845/` with `--strictPort`. A
  procedural text clip with background, outline, and shadow received two
  ordered effects, both reported `ready` from the actual worker capability
  handshake. Bypassing versus applying exposure -2 changed the isolated
  Program Monitor screenshot SHA-256 from
  `65e1584f19213d0e5116cd46b7b619dde3495ea4c1c19a8ba4e3f000773583ff`
  to `00966aed3643a50ad08fcd5da8977a9cb295ebc65d5a86a05032a1fc6c3a10f0`.
  The final console had 0 warnings/errors, no error overlay appeared, and port
  41845 was released.
## Post-MVP issue #70 - OPFS editing proxies

**IMPLEMENTATION COMPLETE (2026-08-10).**

- The published matrix in `PROXY_CODEC_SUPPORT.md` is the shipped contract:
  pinned Mediabunny 1.50.9 must open the source, its exact video config must
  pass the existing `proxy-generation` decoder revalidation boundary, and the
  browser must prove exact AVC/MP4 output geometry, bitrate, key-frame interval,
  and actual source frame rate before Generate enables. The disposable probe
  initializes the real conversion-canvas state and writes only to a null target.
  The shipped 720p/2 Mbit/s proxy is video-only; audio stays on the original
  path.
- Schema-1 cache truth lives only under
  `myrelith-derived/proxy-cache-v1`. Entries record stable asset id, explicit
  sampled-SHA-256 fingerprint algorithm, original identity, complete profile
  and generator version, per-attempt filename, output facts/bytes, and
  creation/last-use times. Replacement commits the new manifest before
  deleting the old physical file, so same-provenance regeneration cancellation
  cannot truncate the committed proxy. Quota eviction is LRU, protects the
  asset being regenerated, and targets both 80% origin usage and 64 MiB
  headroom when the browser supplies estimates. Parsing rejects unknown keys
  and bounds all strings/numbers/reduced rational rates before aggregate cache
  arithmetic. Controller acceptance is a two-phase finalize/rollback decision;
  remove and clear invalidate work, await scheduler idle, and share serialized
  storage mutation, so a queued late commit cannot resurrect cache/UI state.
- `MediaJobScheduler` allows one proxy job and one decoder. CanvasSink uses a
  pool of one, every CanvasSource add and OPFS write is awaited, and cancel,
  replacement/removal, unsupported input, quota, worker/decode, manifest, and
  output failures release Input/output/staged-file ownership. Generate,
  queued/running cancel, retry, regenerate, remove, clear-all, progress, bytes,
  whole-origin quota, and persistence state are exposed without claiming
  durable project data. A failed/corrupt estimate still leaves the narrow
  disposable-clear recovery action available. Generation uses the exact durable
  primary-video PTS span, supports negative/nonzero first PTS, normalizes output
  timestamps to zero, and cannot extend video to a longer audio duration.
- The editor acquires an async ref-counted controller lease. Concurrent
  StrictMode init/unmount/re-entry shares initialization, and only the last
  release unsubscribes, disposes the scheduler, drains work/storage, and clears
  runtime state. Expanded video/proxy cards are single-row in both CSS and the
  pure Media Pool row planner, so virtual height/spacers remain exact.
- Preview and final export call one browser-free selection policy. Preview may
  open only a fresh proxy and can keep displaying it while the original is
  offline; proxy open/decode failure becomes a proxy error and falls back to a
  connected original. Final export always selects and revalidates the original
  and explicitly blocks while it is offline. No proxy field was added to
  `TimelineDoc`, `.myrelith`, recovery, descriptors, remembered handles, or
  export preferences.
- Focused post-rebase validation passed 170 tests across the proxy/domain/storage,
  preview/export, Media Pool/Preview, launcher, and architecture surfaces. The
  complete gate passed all 2,186 Vitest cases across 155 files plus all 16
  benchmark-runner cases. TypeScript/production Vite build and oxlint pass;
  Vite retains only the existing advisory large-chunk warning. The production
  high-severity audit reports 0 vulnerabilities; the all-dependency audit
  retains the unchanged two dev-only highs in `nanoid` and `undici`, with
  package manifests unchanged from the base.
- Real Chromium used only
  `npm run dev -- --port 41870 --strictPort`. The generated H.264 stress source
  was 50,948,082 bytes, 3840x2160, 30 fps, 12.000 seconds, and a 300-frame GOP.
  The exact input/output preflight enabled generation; cancel left no bytes;
  success took 2.9 seconds and reported a 1280x720 3.0 MiB proxy (about 16.2x
  smaller / 93.8% fewer bytes and 88.9% fewer pixels). A later same-source
  regeneration cancel preserved the committed proxy. Reopening the portable
  project with the original offline rendered and played the cached proxy;
  Export named and refused the offline original. Relinking revalidated the
  proxy fingerprint and produced an original-backed 1920x1080 H.264/AAC MP4
  Export-ready result in 4.413 seconds. The final warning/error log and Vite
  overlay count were both zero, screenshots covered offline proxy playback and
  connected Export-ready state, and port 41870 was released.
- Independent review remediation reran the same 50,948,082-byte 3840x2160,
  30 fps, 12-second, 300-frame-GOP fixture through the exact timeline asset.
  Fixture SHA-256 was
  `76f110d8dea87582d50aa2b091225051278771e9f4a934b466549901fbe9b079`.
  Original worker-complete seeks were 456.6 ms median / 1176.7 ms p95, with
  worker render at 456.2 / 1176.2 ms; the 1280x720 proxy measured 15.9 / 21.5 ms
  and 15.8 / 21.3 ms respectively (about 96.5% lower median worker cost). A
  serialized unpaced live-bridge trial, capped at 119 frames and four seconds,
  rendered 35/119 original frames in 4081.3 ms (8.576 fps, 84 budget misses)
  versus 119/119 proxy frames in 2631.5 ms (45.221 fps, no budget misses).
  Browser paint-boundary samples (527.6 ms original, 1072 ms proxy) are reported
  separately and excluded from the benefit claim because the extension-owned
  background tab throttled animation-frame presentation. Method limitation:
  this establishes selected-source decode/composite capacity on this one local
  H.264 fixture and machine, not universal codec/GPU performance.
- After rebasing cumulatively onto schema-11 master `532a728`, a fresh strict-
  port Chromium smoke reopened the persisted proxy as ready, exposed both the
  schema-11 Timing controls and schema-10 Effect stack, and repeated the exact
  selected proxy path at 15.5 ms median / 22.3 ms p95 completion and 15.2 /
  21.8 ms worker render. The same unpaced cap rendered 119/119 frames in
  2634.3 ms (45.173 fps, zero misses). Browser warnings/errors remained zero,
  the visible progress copy used plain `Measuring...`, and port 41870 was
  released. The full production benchmark also completed with clean console
  and resource restoration; its repository-wide proposed thresholds remain
  advisory and are not Issue #70 acceptance claims.
- Source evidence: clean base `718c0d28e3611e2bad3b511d45ce1e3adcba0270`
  had tree SHA-256
  `47e1f912b11b21a3cf4e7db082f7e9807b9d2b1bbff258b75b2ddb1e2b7dc8e4`
  and benchmark-style clean fingerprint
  `sha256:f19f13ad8edaf45d414b2429a5ac0150748be745819e1d1d046f64ea9f8d61d1`.
  The completed implementation checkpoint before this evidence log was
  `sha256:7e99874165d746522fa419469ae3f81a769f03a3a38c3647eaef1b9b390639dd`;
  the final commit SHA is authoritative.
- Delivery is a ready PR targeting `master` with `Closes #70`. The milestone
  coordinator owns the requested #45, then #69, then #70 rebase/squash-merge
  sequence; this branch does not merge or close the issue itself.

## Post-MVP issue #71 - basic color correction and video scopes

**IMPLEMENTATION COMPLETE (2026-08-10).**

- `builtin.color-adjust` remains the stable version-1 descriptor. Newly authored
  effects store bounded exposure, contrast, saturation, temperature, and tint;
  older version-1 descriptors that omit temperature/tint still resolve those
  fields to zero without rewriting unknown authoring intent. Add, enabled/bypass,
  move, reset, remove, persistence, recovery, and undo/redo continue through the
  existing effect-stack and document-history contracts. No preset was added: five
  neutral defaults plus one reset action are the complete basic-correction UX.
- Pixel correction is display-referred, unpremultiplied 8-bit sRGB ImageData.
  Alpha is copied byte-for-byte; transparent RGB is still transformed, each
  descriptor clamps before the next descriptor, and final channels round to the
  nearest byte. Exposure, contrast, Rec.709-luma saturation, temperature red/blue
  gains, and tint magenta/green gains run in documented stack order. The existing
  Canvas filter path remains for exposure/contrast/saturation-only stacks; any
  ready temperature/tint request moves the complete ready color stack to the
  exact pixel path so ordering cannot drift.
- The shared compositor applies correction to complete isolated media/still,
  crossfade-leg, and text layers before opacity and blend composition. Preview and
  export call that same compositor and capability contract. A missing pixel-access
  capability produces an honest effect status instead of silently approximating
  temperature/tint.
- Video scopes analyze only the completed presented frame. The render worker
  downsamples to a fixed 160x90 sample, allows at most one pending analysis at a
  four-Hz maximum, and sends it to a dedicated analysis worker. Generation guards
  reject stale work; disable, document replacement, and close terminate pending
  analysis and release the sampling canvas. Histogram, waveform, and vectorscope
  use bounded fixed-size arrays, ignore fully transparent pixels, and treat partial
  alpha as displayed over black.
- The Program Monitor exposes a session-only Scopes toggle and accessible ARIA
  tablist with roving keyboard focus. Histogram, waveform, and vectorscope canvases
  include live status text; unsupported pixel readback is reported explicitly.
  The Inspector exposes labeled range/number pairs for all five parameters plus
  the existing enable, order, reset, and remove controls.
- Focused development validation passed 496 tests before the final additions. The
  final gate passed all 2,224 Vitest cases across 162 files plus all 16 benchmark-
  runner cases, production build/typecheck, oxlint, and the production high audit
  at 0 vulnerabilities. Vite emitted `video-scopes.worker-C8a-Vnob.js` separately;
  its only build diagnostic was the existing advisory large-chunk warning.
- Real Chromium used only
  `npm run dev -- --host 127.0.0.1 --port 41871 --strictPort`. A 1280x720 text
  fixture exercised two ordered color descriptors, all five parameters, ready
  status, reorder (`0.75`, `-0.5` -> `-0.5`, `0.75` after moving the second
  descriptor), bypass/re-enable, five-field reset,
  recovery reload, and scope disable/restart. Keyboard ArrowRight selected
  waveform then vectorscope; scopes reported 14,400 samples and advanced from
  frame 2 to frame 41 during playback. Browser warning/error logs were empty,
  screenshots were captured under `.tmp/issue-71-browser`, and port 41871 was
  released. After the exact-identity review correction, a fresh exact-source
  Chromium recovery smoke again showed both effects `READY`, the first descriptor
  at five zero defaults, a 14,400-sample histogram at frame 0, and no browser
  warnings/errors. Its screenshot is
  `.tmp/issue-71-browser-final/exact-head-recovery-scopes.png` with SHA-256
  `70c7b377961719f26e7d03f01969868169d4dd05a39e0e259865b26f008aa4a7`;
  strict port 41871 was released again.
- Delivery is a ready PR targeting `master` with `Closes #71`. This branch does
  not merge or close the issue and does not modify Issue #72's branch/worktree.

## Security hardening - six audit findings (2026-08-10)

**IMPLEMENTATION COMPLETE LOCALLY.**

- Origin-local file capabilities now use an opaque local-project binding plus
  asset id. Reopening the exact remembered project handle keeps its binding;
  selecting a copied project with the same portable document id receives a new
  one and cannot replay the original's media handles. Historical Recent and
  recovery records migrate through a narrowly scoped legacy binding without
  changing the stable IndexedDB database names.
- Proxy-cache schema 2 carries the same local owner. Offline proxies are
  visible only to that owner; schema-1 entries stay quarantined until a
  connected original proves their fingerprint and adopts them. Runtime proxy
  tokens, replacement, rollback, removal, and quota protection use the same
  owner boundary. Portable projects, recovery payloads, and export preferences
  remain unchanged.
- Remembered-handle loading uses at most eight concurrent IndexedDB reads,
  preserves descriptor order, and stops scheduling after a project-open
  cancellation. Render allocation is bounded before parsed projects, worker
  canvas resizing, or export can allocate compositor surfaces. Export rejects
  work beyond five million frames, 24 hours, or the destination-specific
  output estimate before it creates a sink or requests a frame.
- Docker remains an optional alternate package, not part of Cloudflare Pages.
  Pages still publishes only the normal Vite `dist` output. `.dockerignore` is
  now an exact production-input allowlist, so repository metadata, worktrees,
  temporary evidence, local environment files, logs, and unrelated workspace
  files are not sent as Docker build context.
- Validation passed all 2,205 Vitest cases across 159 files plus all 16
  benchmark-runner cases, production typecheck/build, oxlint, the exact Docker
  allowlist regression, and the production dependency audit with 0
  vulnerabilities. The complete browser suite passed recovery; its command-
  palette accessibility spec retained the independently reproduced `master`
  baseline failure for the existing 23 x 20 px audio-overload reset target.
  A separate real-Chromium create-project/editor smoke used only strict port
  41879, made no non-static network requests, reported zero warnings/errors,
  and released the port. Docker CLI 29.5.2 was present, but the local Docker
  Desktop Linux daemon was not running, so a real image build was unavailable.
- The all-dependency audit retains the base branch's two dev-only high
  advisories in `nanoid` and `undici`; neither is in the production dependency
  audit or the deployed static bundle. They are separate dependency-maintenance
  work, not hidden inside this six-finding change.

## Milestone 4 Part 9b / issue #74 - dynamic zoom and reframe presets

**IMPLEMENTATION COMPLETE (2026-08-10).**

- `domain/dynamicZoom.ts` is a pure authoring helper, not a second animation
  engine. Four small presets (gentle in/out and horizontal/vertical reframe)
  resolve editable start/end focus, safe zoom, duration, and existing easing
  into exactly two ordinary keyframes on each of Position X/Y and Scale X/Y.
  Apply replaces only those four properties, Reverse swaps the endpoints and
  reverses cubic-bezier timing, and Reset deliberately removes every authored
  curve on those four properties. Rotation, Opacity, crop, static transform,
  and any other animation-container fields remain untouched.
- Portable asset descriptors are the primary immutable source of width/height;
  a connected session asset is an explicit fallback only when descriptor
  dimensions are unavailable. The bounded framing math combines source size,
  project aspect, asymmetric crop, authored anchor, and static rotation in the
  same transform order as the compositor. Requested focus is projected into
  the feasible full-coverage region at both endpoints; convex interpolation of
  those safe endpoints retains coverage at interior frames.
- Stills use their authored timeline duration and are supported. A requested
  duration longer than a clip clamps to that clip; one-frame clips are rejected
  because two distinct keys cannot exist. Text is explicitly unavailable because
  the current ordinary clip-animation contract does not animate text geometry.
  Static crop and rotation are supported by the safety solver; a Rotation curve
  is rejected because one static bound cannot guarantee every animated angle.
  Transitions continue to evaluate the same normal clip animation on each
  composition leg, so there is no transition-specific preset state.
- The lazy Animation-tab editor keeps preset drafts local until Apply/Reverse.
  Every committed apply, reverse, or reset is one normal document-history entry;
  rejected/idempotent requests do not grow history and pointer movement never
  mutates the document. Inspector fields, monitor gestures, scrub, recovery, and
  export therefore stay synchronized through `resolveClipAnimationAtFrame`.
  Native labels, fieldsets, tab keyboard navigation, live status, and direct
  Apply/Reverse `aria-describedby` links expose every configuration value and
  disabled reason to keyboard and screen-reader users.
- Focused tests cover safe endpoints and eased interior frames across landscape,
  portrait, square, asymmetric-crop, off-center-anchor, and rotated inputs;
  normal resolver use at an interior integer frame; source-time ticks; still,
  text, lock, rotation-animation, and short-clip rules; exact persistence;
  one-entry undo/redo; reset boundaries; portable-descriptor priority; and the
  accessible UI. The final gate passed 2,261 Vitest cases across 166 files plus
  all 16 benchmark-runner cases, production typecheck/build, oxlint, clean diff
  checks, and `npm audit --omit=dev` with 0 vulnerabilities. Vite retained only
  its existing advisory large-chunk warning.
- Real headed Chromium used exactly `http://localhost:5182/` via
  `npm run dev -- --port 5182 --strictPort`. A real 1672x941 still in a
  1080x1920/30 fps project produced four visible ordinary tracks; a requested
  200 frames clamped to 150. Exact clip-local frames 0, 75, and 149 showed
  distinct full-coverage reframes. Reverse swapped the visible Position X
  endpoint values and timing curve; Reset removed the tracks; Ctrl+Z restored
  them. A 720x800 pass had no dynamic-panel horizontal overflow. Recovery reload
  retained exact keys while the source was offline, descriptor dimensions kept
  the editor ready, relink succeeded, and Chromium exported a 1080x1920 H.264
  MP4 with 180 decoded frames at 30 fps. Extracted output frames 30, 105, and
  179 visually retained the recovered reversed reframe. Final console evidence
  reported 0 warnings and 0 errors; artifacts and hashes are recorded in
  `output/playwright/issue-74-browser-evidence.txt`; port 5182 was released.
- Browser QA used one uncropped, unrotated still; the crop/anchor/rotation matrix
  is covered by pure and composition tests rather than additional browser
  fixtures. Subject tracking and AI reframing remain intentionally out of scope.
  No schema version changed. Issue #73 may touch the shared operations/store/
  Inspector/persistence-test/docs seams during rebase, but this work preserves
  the full animation container and does not own effect-stack or Effects-tab code.

## Working agreements (the user's explicit preferences)

- Changes may span every module needed for one complete fix. Keep dependency
  boundaries clear and verify logical steps separately; never skip a phase
  gate; commit with the message file + `-F` pattern, authored by Aryel and add
  `Co-authored-by: Codex <codex@openai.com>` for Codex-assisted work.
- End-of-turn summaries: SHORT, plain words, low jargon (user has AuADHD —
  dense dumps fog them; they like emoji and warmth). Deep detail belongs in
  commits/docs, not the summary.
- Be honest about mistakes and rejected-first-try test runs; the user
  values the "honest notes" sections.

## Milestone 4 issue #73 - masks and chroma key (2026-08-11)

**IMPLEMENTATION COMPLETE LOCALLY.**

- The built-in effect stack now owns version-1 `mask` and `chroma-key`
  descriptors. Rectangle, ellipse, and bounded cubic Bezier masks use normalized
  project-canvas coordinates after crop/transform; project-edge clipping,
  feather, invert, enable/bypass, and exact authored ordering are shared by
  preview and export. Chroma key exposes explicit color, tolerance, softness,
  and spill suppression with safe identity-compatible defaults.
- `ClipAnimation.effectTracks` is the schema-13 durable animation contract.
  Tracks address a stable effect id plus supported scalar parameter, reuse the
  pure scalar evaluator, follow source-time, retime, split, trim, duplicate, and
  remint rules, and are pruned atomically when their effect is removed or reset.
  Per-track and document budgets are bounded. Unknown or dangling targets remain
  stored for forward authoring intent but are ignored deterministically at
  evaluation and rendering time.
- Schema 12 migrates by identity to schema 13, including the valid historical
  case where `clip.animation` was omitted. Current save validation requires
  canonical bounded `effectTracks`. The broad-looking test-only change is a
  mechanical current-document update: 66 `schemaVersion: 12` literals across 48
  test files became schema 13; intentional schema-12 migration and legacy
  fixtures in `projectFile.test.ts` remain unchanged and include the omitted-
  animation regression.
- The compositor builds one explicit executable pixel chain, so ready color,
  chroma, and mask effects keep exact authored interleaving. Eligible historical
  color-only stacks retain the Canvas filter fast path and no-effect output is
  unchanged. Pixel-path media and transition legs render effects at alpha 1,
  then apply clip or weighted transition opacity to match text and the documented
  effects-before-opacity contract.
- The Inspector exposes accessible ordered cards, numeric inputs, checkboxes,
  mask-shape selection, synchronized Bezier draft editing, and stable-id effect
  keyframe controls. Text clips keep static effect editing, but mask animation is
  deliberately not offered there because Issue #43's text property set does not
  define effect tracks. No direct-manipulation mask overlay is exposed in this
  slice: the bounded numeric/list surface avoids adding a second gesture/history
  controller late; therefore pointer-up history is not claimed as browser-
  verified. Tracking roto, auto masks, and arbitrary shaders remain out of scope.
- Final-tree validation passed 293 focused mask/chroma/schema/render/store tests,
  the explicit 81-test budget/migration subset, all 2,260 Vitest cases across 163
  files plus 16 benchmark-runner checks, production build/typecheck, oxlint, and
  `npm audit --omit=dev` with 0 vulnerabilities. The first full run honestly
  failed 43 files after 2,217 passing tests because current test documents still
  declared schema 12; only those current fixtures were updated, and the corrected
  full run passed. The build emitted only the established large-chunk advisory.
- Real Chrome QA used exactly `http://localhost:5181/` from
  `npm run dev -- --port 5181 --strictPort`. A local 640x360 green/red/blue PNG
  was imported and placed on V1. Chroma plus rectangle and Bezier masks reported
  ready; width was keyed at exact clip-local frame 0 = 55% and frame 35 = 35%,
  reordered mask/chroma through undo/redo, and stayed project-space aligned after
  x=120 px, rotation=12 degrees, scale=0.9, crop-left=10%, and crop-top=5%.
  Invalid Bezier blur restored the valid stored path, bypass/re-enable worked,
  and reload -> recovery review -> offline restore -> relink preserved all three
  descriptors plus both keys. The only console warning was the intentionally
  rejected invalid path; there were no errors. Evidence:
  `.tmp/issue-73-browser/qa-frame0-keyframe.png` SHA-256
  `7FB94298EB1D8204BB64D9FB511D7F4E6ED32465095EFD824D6A7B45C1016649`
  and `.tmp/issue-73-browser/qa-frame35-keyframe.png` SHA-256
  `38E553EA5D5C3DCFBFE5DC20FAD863C59EA47CD1B47BC49E98340349D4A292E1`.
  Authored noncommuting order, colored-destination alpha, and encoded-export
  parity are covered by deterministic pixel/compositor tests, not claimed as
  browser-observed. Port 5181 was released.

## Milestone 4 issue #73 - review hardening follow-up (2026-08-11)

**IMPLEMENTATION COMPLETE LOCALLY.**

- Program Monitor effect readiness now resolves `effectTracks` at the current
  integer playhead. Document changes rebuild a compact index of effect owners;
  animation-frame refreshes evaluate only owners with animated effects, so
  status work scales with that bounded subset rather than every timeline clip.
  Pixel-readback fallback copy is generic and accurate for color, chroma, and
  mask effects.
- Every budget-disabled Add button has its own stable accessible description,
  including mixed aggregate string/parameter limits where only some effect
  types are unavailable. Lock-only disabling does not claim a budget reason.
- The shared 100,000-key project limit is enforced before every operation in
  this slice that can grow animation: ordinary/effect key insertion, multi-
  parameter at-frame updates, animated clip insertion, and split duplication.
  Replacements, moves, and removals remain valid at the cap. Reset preflights
  descriptor and aggregate budgets before it clears target tracks, preserving
  history and forward-compatible parameters on rejection.
- Animated insert/split also preflight aggregate effect count, parameter count,
  and effect-string growth through the shared effect-budget authority before
  cloning descriptors. Exact-cap rejection is history-neutral, while inserting
  or splitting an effectless clip remains legal because it adds no effect data.
- Bezier masks use scanline parity for zero-feather coverage and exact segment
  distances only inside clipped, feather-expanded edge neighborhoods. Scratch
  storage is grow-only `Uint8Array`/`Float32Array` sized to the clipped mask
  region, not a full-surface float64 field. Zero feather is proportional to
  processed pixels plus rows times flattened edges; typical feather work is
  bounded by the edge neighborhoods. At maximum feather, worst-case work can
  still approach flattened edges times clipped-region pixels, so no feather-
  independent performance claim is made. Ellipse feather uses a normalized,
  fixed-32-step bisection for the true project-space nearest boundary, with
  exact circle and axis cases; wide-ellipse center and adjacent samples remain
  continuous across all bounded aspect ratios. Zero feather uses only the
  implicit inside test, outside pixels skip distance work, and a conservative
  minor-radius bound skips fully covered interior pixels. At 1920x1080 on the
  local Ryzen 5900X, zero/5%/maximum feather took 59.1/155.0/548.0 ms and ran
  0/309,440/1,628,644 exact solves; all remain under the 2-second regression
  threshold.
- Review-hardening validation passed the earlier 67-test focus and 415-test
  broad subset, then a final 291-test ellipse/budget focus, all 2,281 Vitest
  cases across 163 files, and all 16 benchmark-runner checks. Standalone
  TypeScript, production build/typecheck, oxlint, and
  `npm audit --omit=dev` also passed; the audit found 0 vulnerabilities and the
  build emitted only the established large-chunk advisory.

## Milestone 4 issue #74 - schema-13 integration follow-up (2026-08-11)

**INTEGRATION COMPLETE LOCALLY.**

- The published issue-74 commit was rebased from `ddc26f3`/`e9fdbbd` onto the
  issue-73 merge commit `e0778ab`. The only textual conflicts were
  `src/domain/operations.ts` and `docs/PLAN.md`; both were resolved semantically.
  Schema-13 `effectTracks`, the effect edit APIs, compositor contracts, and the
  issue-73 hardening record remain intact while dynamic zoom still writes only
  the four ordinary Position X/Y and Scale X/Y tracks and spreads the complete
  animation container.
- Apply now preflights the net growth from its planned eight-key replacement
  against the shared 100,000-key document budget introduced by issue #73.
  Exact-cap rejection is identity- and history-neutral. Focused operations
  tests prove Apply and Reset
  retain existing effect descriptors and `effectTracks`; schema-13 persistence
  fixtures include the canonical empty effect-track array. The old-versus-new
  `git range-diff` contains only those expected schema, preservation, budget,
  test, and append-only documentation adjustments.
- Rebased-tree validation passed 17 issue-74 tests, a 177-test dynamic/schema/
  effects/compositor focus, all 2,299 Vitest cases across 167 files, and all 16
  benchmark-runner checks. Production build/typecheck, oxlint, clean diff
  checks, and `npm audit --omit=dev` also passed; the audit found 0
  vulnerabilities and the build retained only its established large-chunk
  advisory.
- Real headed Chromium ran at exactly `http://localhost:5182/` from
  `npm run dev -- --port 5182 --strictPort`. A real 1672x941 still on V1 first
  received a rectangle-mask Left effect key at clip frame 0. Dynamic Apply,
  exact clip-frame-75 scrub, Reverse, Reset, and Ctrl+Z all worked; the normal
  framing tracks disappeared and restored as expected, while the Mask card and
  Left effect key remained visible after every operation. The monitor retained
  full-canvas coverage. Final console evidence was 3 messages, 0 errors, and 0
  warnings, and port 5182 was released.
- Rebase screenshots are ignored local QA evidence:
  `issue-74-rebase-apply.png` (`B43F993EC9ECED990F8590CE89D4EFAC91E9164F11B6DC12156D7B6805F73ABE`),
  `issue-74-rebase-scrub-middle.png` (`3D73A49AA813ED891EA1DD949CF275B3B84DF5C1E3736F87A05086E39B928842`),
  `issue-74-rebase-reverse.png` (`2C2A3806A8EA7688FDEA2F6BFA4569161BCC093473BCD612FE381277DCACCE58`),
  `issue-74-rebase-undo-restored.png` (`34D96B246454E9ACDD6EF39EDDC8F8E737792C73E0A94A0D19F5595F0D9DF8E2`),
  and `issue-74-rebase-effect-track-survives.png`
  (`8FDFE3EA2A3F5AC061FDE573225DEA3B4DD8652E3C403A3BF9ABCA0B27489786`).
  The integration smoke reused one uncropped, unrotated still and did not repeat
  the earlier recovery/export matrix; deterministic tests and the original
  issue-74 Chromium evidence continue to cover those claims.

## Milestone 4 issue #74 - signed-flip and accessible-status follow-up (2026-08-11)

**REVIEW BLOCKERS RESOLVED LOCALLY.**

- The framing solver now composes horizontal and vertical reflection signs
  around the authored anchor before static rotation, matching the compositor's
  signed-scale order. Safe extents remain reflection-invariant, while the
  cropped visible-source center receives the signed transform needed to avoid
  uncovered canvas at off-center anchors. Focused tests include the exact
  square-source, Anchor X 20%, horizontal-flip counterexample plus horizontal,
  vertical, and combined flips with asymmetric anchors, crop, rotation,
  centered-anchor regressions, and eased interior integer frames.
- Apply and Reset now return explicit domain/store outcomes that distinguish a
  rejected edit from a valid identity-preserving repeat. The shared dynamic-
  zoom budget helper computes the same planned-minus-replaced key growth for
  both readiness and commit, so an exact-cap rejection says it exceeded the
  document keyframe budget and creates no history entry.
- Current lock, dimensions, duration, focus, zoom, rotation-animation, and
  budget reasons outrank prior load/success feedback. Editing any draft field
  clears stale operation feedback. Apply and Reverse remain directly described
  by the live status; disabled Reset uses its own stable reason for locked and
  no-framing-track states, then returns to the destructive-scope note when
  enabled. The safe-zoom explanation now explicitly includes flips.
- Final focused validation passed 22 tests across the framing math, document
  operations, store history/outcomes, and React editor. The full gate passed all
  2,304 Vitest cases across 167 files plus all 16 benchmark-runner checks.
- Real Chrome QA used exactly `http://localhost:5182/` from
  `npm run dev -- --port 5182 --strictPort`. A real 1672x941 still on a
  1080x1080 canvas used Anchor X 20% plus horizontal flip. Invalid duration,
  no-track Reset, and locked-track controls exposed their current described
  reasons; correction/unlock returned to Ready. Apply authored Position X
  1650.9736450584485 to 733.8918172157279 and the eased interior scrub retained
  full-canvas coverage. Reverse, Reset, Ctrl+Z restoration, and lock/unlock all
  behaved as expected. Console evidence was 3 messages, 0 warnings, and 0
  errors; port 5182 was released. Ignored evidence:
  `flipped-apply-interior.png`
  (`FA9FB733E3286EB1DB2A1009AA15E0970830A4D3901C626A9B380B4FCA86773D`)
  and `flipped-reverse-before-reset.png`
  (`0C2553F8C63CB606CAD3BDDA0D17E81F3C73C0CB4F46934D8416728DC64D65F2`).
  The browser-control cleanup handshake timed out after evidence capture on two
  attempts; the app console stayed clean and the verified Vite process/port was
  stopped directly.

## Milestone 4 Part 10b / issue #75 - optional WebGPU acceleration evaluation

**COMPLETE LOCALLY (2026-08-12): NO-GO.**

- The bounded candidate is Issue #71's completed-frame histogram/waveform/
  vectorscope analysis: Canvas2D still downsamples to 160x90 at four Hz with
  one pending job, and the dedicated CPU worker remains the production default.
- `domain/videoScopes.ts` now gives CPU and WGSL one exact integer/fixed-point
  binning contract while preserving the shipped Float64 direction at exact
  luma, waveform, Cb, and Cr half bins. The expanded upload carries four rare,
  independent midpoint-down facts in otherwise-unused alpha bits without
  increasing the buffer budget. The optional adapter
  requires complete startup parity,
  supports only the production sample shape, owns one device/pipeline, allocates
  at most 353,304 request-buffer bytes, destroys them in `finally`, observes
  device loss, and returns CPU output for unsupported/init/runtime/loss paths.
- Only `VITE_MYRELITH_WEBGPU_SCOPES_EXPERIMENT=1` lets the analysis child
  dynamically import WebGPU. Normal production builds contain no adapter/shader
  chunk; enabled builds add one 11.27 kB chunk. Disable/close sends an explicit
  release message, destroys the device, acknowledges cleanup, and retains a
  bounded parent termination fallback.
- `npm run benchmark:webgpu-scopes -- --warmup 10 --iterations 60` runs headed
  system Chrome on strict port 41875 and writes ignored source-bound evidence.
  The original decision run, captured before the final self-test release-race
  fix, produced exact output across 71 comparisons on Chrome 151 / Windows 11 /
  RX 6600, recovered from real device destruction through exact CPU output,
  ended at zero active buffers, logged 0 warnings/errors, and released the
  port. It is historical decision context, not exact-head acceptance evidence.
- That historical evidence set also included a flagged-app pass that created a
  text clip, loaded the adapter through the real scope-worker boundary,
  published 14,400 samples at frame 0, exercised keyboard tabs and disable/
  release, captured the documented screenshot hash, retained 0 warnings/errors,
  and released strict port 41875.
- That historical run measured CPU at 1.000 ms median / 1.400 ms p95 and
  WebGPU at 4.400 / 5.100 ms, plus 418.400 ms startup and 353,304 explicit
  transient bytes versus 30,720 CPU output bytes. WebGPU was 4.4 times slower
  at the actual workload.
  Keep CPU as the production choice. Full contracts, support limits, commands,
  fingerprints, and reconsideration criteria are in `docs/WEBGPU_EXPERIMENT.md`.
- Before the later shutdown follow-ups, the gates passed 118 focused lifecycle/
  integration tests, all 2,321 Vitest cases across 169 files plus 16 benchmark
  checks, normal and opt-in build/typecheck, oxlint, clean diff checks, and the
  production audit at 0 vulnerabilities. These are historical counts.

## Milestone 4 Part 10b / issue #75 - shutdown-handshake review follow-up

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-12); THE FINAL EXACT-HEAD BENCHMARK IS A PR-RECORDED MERGE GATE.**

- Render-worker close now awaits the scope child worker's explicit `released`
  acknowledgment before publishing `closed`. The existing 250 ms child
  termination fallback and independent 1,000 ms page-bridge fallback remain
  bounded, so an unresponsive child cannot deadlock editor teardown.
- The analyzer manager owns a completion promise for every retiring child.
  Disable followed immediately by close still drains the earlier retirement;
  acknowledgment, worker error, synchronous post failure, timeout, and late
  acknowledgment converge on exact-once termination and settlement.
- A release received while the opt-in WebGPU module is still loading now
  invalidates that import before analyzer creation. The child cannot publish
  `released` and then resurrect a device-backed analyzer in the same realm.
- Release also remains terminal across the awaited session request and both
  outcomes of the candidate parity self-test. If that self-test rejects after
  release, the candidate is released without changing `released` to fallback;
  the in-flight request and every later analysis abort instead of returning CPU
  output. Deterministic coverage holds that self-test at the exact race point.
- Regression coverage holds an otherwise-idle close behind a deferred child
  release, proves repeated release waits on the same retirement, exercises the
  exact 250 ms fallback and late acknowledgment, and reproduces the dynamic-
  import race. Before the final self-test race case was added, the focused gate
  passed 118 tests and the full gate passed all 2,321 Vitest cases across 169
  files plus all 16 benchmark-runner checks; those counts are historical.
- Normal and opt-in production builds/typecheck passed: the normal graph has no
  WebGPU adapter chunk, while the flagged graph emits one separate 11.27 kB
  chunk. Oxlint and the production high audit passed with 0 vulnerabilities.
- The headed Chrome 151 / RX 6600 benchmark captured before the final
  self-test release-race fix retained exact parity in 71 comparisons, CPU
  fallback after device destruction, zero active buffers, 0 warnings/errors,
  and strict-port release. CPU measured 1.000 / 1.400 ms median/p95 versus
  WebGPU 4.400 / 5.100 ms, with 418.400 ms startup. Its historical source
  fingerprint is
  `sha256:b37ec7c43331995499dc2396b298e069c69686718bac94283b2838360e6813dc`;
  it is decision context rather than exact-head acceptance evidence. The
  production no-go decision is unchanged.
- From the final clean committed head, rerun the headed 10-warmup/60-iteration
  benchmark, preserve its ignored `.tmp/issue-75-webgpu/` JSON/Markdown
  artifact, and publish its fingerprints plus parity/device-loss/cleanup/
  diagnostics/port results in PR evidence. Do not modify tracked docs after
  that run, because doing so would invalidate its exact source fingerprint.
## Part 10c issue #76 - sandboxed plugin capability design (2026-08-11)

**DESIGN AND NON-EXECUTING PROTOTYPE COMPLETE LOCALLY.**

- `docs/PLUGINS.md` is the normative gated contract. Packages are local-only,
  deterministic, completely hashed, Ed25519-signed, trust/revocation checked,
  and permission gated. First execution is WebAssembly only: one host-authored
  opaque-origin iframe broker, one dedicated worker, one bounded imported memory,
  no callable imports, and parent-owned watchdog/termination. Arbitrary remote
  URLs and package JavaScript are rejected rather than sandboxed optimistically.
- The only first contribution is a host-rendered ordered video effect. It may
  receive one isolated RGBA8 layer plus exact integer-frame/rational-rate facts
  and its own bounded params. It receives no files/handles/source bytes, network,
  origin storage, DOM/custom UI, audio, codecs, project mutation, export sink,
  clock/random source, thread/shared memory, or background execution. Every
  broader surface requires a separately versioned capability and security review.
- `docs/PLUGIN_THREAT_MODEL.md` maps assets, actors, nine trust boundaries,
  hostile inputs, mitigations, realistic attacker stories, residual browser/
  signer/side-channel risk, and Critical/High/Medium/Low calibration. Signed does
  not mean safe; the displayed fingerprint proves key continuity only. Offline
  revocation comes from app releases, user disable/uninstall, or imported signed
  bundles—never an automatic network request or remote kill switch.
- `src/domain/pluginManifest.ts` is deliberately data-only. It strictly validates
  an already-parsed version-1 value, bounds ids/version ranges/relative Wasm path/
  64 MiB-plus-one-page requested memory/permissions/contributions/host-rendered
  parameters and descriptor-migration declarations,
  negotiates exact host versions without granting consent, and derives stable
  `plugin:<plugin-id>/<contribution-id>` descriptor types. It does no package I/O,
  byte-level JSON/ZIP/signature work, trust mutation, registration, import, or
  WebAssembly instantiation; all of that remains Issue #77 work after review.
- Portable projects keep only the existing bounded `EffectDescriptor` plus
  ordinary animation intent. A focused test proves a disabled plugin descriptor
  round-trips without a URL or Wasm path. Missing, incompatible, denied, revoked,
  crashed, and safe-mode plugins remain preserved, bypassed, reorderable,
  removable, saveable, recoverable, and inert. Project open never installs,
  prompts, migrates, enables, or executes a package.
- Validation passed 99 focused manifest/project/effect/architecture tests, all
  2,317 Vitest cases across 168 files, all 16 benchmark-runner checks, production
  build/typecheck, warning-free oxlint, clean diff checks, and the production
  high-severity audit with 0 vulnerabilities. The first focused command honestly
  could not start because this fresh worktree lacked `node_modules`; `npm ci`
  restored the lockfile environment. The first 98-test run then found one
  architecture-guard false positive because it read plugin `schemaVersion: 1` as
  a stale timeline fixture; using the named plugin schema constant resolved it,
  and the unchanged 98-test set passed.
- Real Chromium behavior is intentionally not claimed: the design-only prototype
  has no production import, registry, UI, worker, iframe, package parser, or
  execution path, and its identifying strings are absent from `dist`. Issue #77
  is gated on real-browser negative probes for network, storage, DOM, navigation,
  worker, cancellation, watchdog, crash, safe-mode, and preview/export behavior.
- Source identity started at clean
  `00daac79cd26b2e0a503477d629635f0d15da853` /
  `sha256:058d3e740f1c760a7349e78299f3e3cb6d97649f4e18a5192ec9ad0fe89d89ee`
  and reached the initial pre-evidence checkpoint
  `sha256:994caa4e793d1e57d2f45e97fbc86107866e3a1dba72a3311b3bf1dd112d4f4b`.
  Final review then added independently versioned contribution negotiation; the
  final commit id is the authoritative delivery identity.

## Part 10c issue #76 - PR #112 review hardening (2026-08-11)

**COMPLETE LOCALLY.**

- Manifest numeric ranges now reuse the durable +/-1,000,000,000 effect bound,
  and parameter keys reuse the portable/live reserved-record-key guard. Accepted
  host-rendered values can therefore seed and save ordinary effect descriptors.
- The imported-memory ceiling is 1,025 WebAssembly pages: the maximum legal
  64 MiB RGBA frame plus one non-overlapping 64 KiB canonical-parameter page.
  Smaller manifest requests remain legal but make a frame that does not fit
  explicitly unavailable. Migration declarations require at least two pages for
  their bounded non-overlapping input/output buffers.
- Every contribution now carries a bounded `migrations` array. Sorted forward
  `{ fromVersion, toVersion, entrypoint }` steps must all terminate at the current
  descriptor version; a version above one must declare at least one chain, and a
  migration export cannot collide with the differently typed render export.
- The normative ABI now specifies the migration call signature, exact buffer/
  return rules, canonical output validation, watchdog, memory clearing, and the
  host-owned identity/order/enabled/animation boundary. Version 1 rejects any
  instance targeted by an effect-animation track before migration code runs;
  failure keeps the original descriptor, complete animation, and history
  untouched.
- Validation passed 109 focused manifest/project/effect/architecture tests, all
  2,323 Vitest cases across 168 files, all 16 benchmark-runner checks, production
  build/typecheck, warning-free oxlint, clean diff checks, and the production
  high-severity audit with 0 vulnerabilities. Browser verification remains not
  applicable because no production runtime or observable surface was added.

## Part 10c issue #76 - PR #112 aggregate table-budget follow-up (2026-08-12)

**COMPLETE LOCALLY.**

- Replace the per-table-only WebAssembly rule with an exact module-wide gate:
  at most 16 defined tables, an explicit maximum no greater than 4,096 for each,
  at most 4,096 declared initial entries in aggregate, and at most 4,096 declared
  maximum entries in aggregate. Table imports remain forbidden by the existing
  one-memory-only import contract.
- Require the Issue #77 binary-policy parser to enforce the table count and both
  aggregate sums before compilation or instantiation, and require exact boundary
  fixtures across supported browsers. Mirror those budgets in the package table
  and denial-of-service threat controls so the normative and security contracts
  cannot drift.
- Validation passed 103 focused manifest/project/effect/architecture tests, all
  2,323 Vitest cases across 168 files, all 16 benchmark-runner checks, production
  build/typecheck, warning-free oxlint, clean diff checks, and the production
  high-severity audit with 0 vulnerabilities. The first full-suite launch used an
  accidentally short command timeout and was stopped after five seconds; it is
  not counted as evidence, and the immediate full rerun passed.
- Browser verification remains not applicable: this is still a design-only,
  non-executing contract with no production plugin parser, runtime, or observable
  browser surface. Issue #77 owns the real hostile-module boundary fixtures.

## Part 10c issue #76 - PR #112 contribution-dispatch follow-up (2026-08-12)

**COMPLETE LOCALLY.**

- Every accepted contribution now owns a package-unique render entrypoint, and
  the complete render-name set is disjoint from every differently typed migration
  export. Validation is order-independent and points at the colliding declaration.
- The selected render export is the WebAssembly-call contribution discriminator.
  The ten-integer render signature stays unchanged, and no contribution-id string
  or extra selector is copied into untrusted memory.
- The normative plugin contract, threat model, and architecture boundary now say
  the same thing, so Issue #77 can map one contribution to one typed export before
  compilation or instantiation without inventing a dispatch convention.
- Validation passed 111 focused manifest/project/effect/architecture tests, all
  2,325 Vitest cases across 168 files, all 16 benchmark-runner checks, production
  build/typecheck, warning-free oxlint, clean diff checks, and the production
  high-severity audit with 0 vulnerabilities.
- Browser verification remains not applicable because this follow-up changes
  only the pure non-executing validator and design contract. Issue #77 still owns
  real hostile-module dispatch fixtures.

## Part 10c issue #76 - PR #112 intermediate-migration follow-up (2026-08-12)

**COMPLETE LOCALLY.**

- Version-1 manifests do not invent schemas for intermediate descriptor versions.
  After each non-final step, the host instead requires strict UTF-8 canonical
  JSON for one primitive record before any following export may run.
- The intermediate record is capped at 65,536 encoded bytes and 64 entries.
  Keys and string values reuse the 1-to-64-character ASCII local-identifier
  grammar; keys also exclude `__proto__`, `prototype`, and `constructor`.
  Values are booleans, finite +/-1,000,000,000 numbers, or those bounded
  strings, with no null, array, or nested-object values.
- Only the final step must exactly match the current manifest parameter schema
  and pass durable descriptor and whole-document replacement budgets.
  Intermediate records never enter the document or history.
- The latest exact-head Codex P2 found that retaining effect animation across a
  plugin-controlled schema or unit change would silently reinterpret authored
  keyframes. Descriptor migration ABI version 1 is therefore static-instance-
  only: before any migration export runs, the host rejects the entire chain if
  any owning `ClipAnimation.effectTracks` entry targets that effect instance id.
  Key-range-only validation is explicitly insufficient; animated migration
  requires a future, separately versioned contract. Every rejection preserves
  the original descriptor and complete animation.
- This remains a non-executing contract clarification. Issue #77 still owns the
  parser, canonical byte checks, migration runtime, and hostile fixtures.
- Validation passed all 20 focused plugin-manifest tests, the test wrapper's 16
  benchmark-runner checks, and `git diff --check`.

## Part 10c issue #76 - PR #112 activation and declaration-budget follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review found two remaining pre-runtime availability gaps: a
  start function could run synchronously during instantiation before a call
  watchdog existed, and the 32 MiB module cap did not bound cheap, high-count
  declarations or segment payload expansion before compilation.
- The host-authored byte policy now rejects every start section before any
  WebAssembly engine call. The later worker-ordering correction below makes the
  parser itself candidate-owned. That fresh, disposable activation-candidate
  worker also owns validation, asynchronous compilation, and instantiation under
  one parent wall-clock deadline that never resets and expires after five
  seconds. Success promotes it to the sandbox's dedicated runtime worker;
  timeout or failure destroys it and the sandbox without blocking the UI.
- The first implementation now caps each module at 1,024 types; 8,192 imported
  plus defined functions; 16 tables with 4,096 aggregate entries; one imported
  memory with a 1,025-page maximum; 2,048 globals; 8,192 exports; 1,024 element
  segments/4,096 elements; 1,024 data segments/8 MiB payload; exactly one import;
  zero tags; and 16,384 aggregate declaration entries. Checked byte parsing
  enforces every count, sum, and payload limit before validation or compilation.
- This remains a design-only Issue #76 clarification. No package parser,
  WebAssembly activation path, sandbox, worker, or browser-visible behavior was
  added; Issue #77 owns implementation and hostile cross-browser fixtures.
- Validation passed 111 focused manifest/project/effect/architecture tests
  across five files, the test wrapper's 16 benchmark-runner checks, and
  `git diff --check`. Browser verification remains intentionally not applicable.

## Part 10c issue #76 - PR #112 RGBA color-encoding follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review found that `display-referred` did not fix the plugin
  frame transfer function or primaries, so a conforming module could interpret
  the same bytes as linear-light or Display-P3 and disagree with Myrelith's sRGB
  effect path.
- Capability version 1 now defines both input and successful output as four
  `R, G, B, A` bytes: nonlinear IEC sRGB OETF code values using sRGB/Rec.709
  primaries and D65, plus independent straight/unassociated 8-bit alpha. It is
  explicitly not linear-light, Display-P3, or premultiplied RGBA.
- The host converts the isolated compositor layer into that exact encoding
  before copy-in and interprets/converts output identically after copy-out.
  Preview and export share the boundary, and no ICC/profile or other gamut
  metadata reaches plugin memory.
- This is a design-only contract clarification. Issue #77 still owns the actual
  conversion/runtime and cross-browser byte fixtures.
- Validation passed 111 focused manifest/project/effect/architecture tests
  across five files, the test wrapper's 16 benchmark-runner checks, and
  `git diff --check`. Browser verification remains intentionally not applicable.

## Part 10c issue #76 - PR #112 export-instance and numeric-step follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review found that a promoted editor runtime could retain
  mutable preview/scrub state into export, and that a positive numeric parameter
  step could be smaller than IEEE-754 spacing at a declared endpoint.
- Every export attempt now owns a freshly instantiated worker, Wasm instance,
  imported memory, port, queue, and request generation. No mutable editor state
  is shared. Planned calls run in deterministic frame/plan order, every terminal
  outcome destroys the export runtime, and retry restarts from the first frame.
- The later exact-head cache correction supersedes the original immutable-code
  design: Myrelith retains no compiled/engine artifact across lifecycles. Its
  optional session cache holds only private verified raw-byte copies, capped at
  eight entries and 64 MiB actual retained bytes, with deterministic LRU and
  lifecycle/trust/revocation/update invalidation; every activation repeats all
  parser and engine gates from a fresh byte copy.
- Export preflight reserves every required package slot under the hard eight-
  sandbox ceiling or fails before acquiring a sink/encoder; it never evicts and
  reinstantiates stateful modules midway through an export.
- Number parameters must now satisfy both `min + step > min` and
  `max - step < max`, rejecting steps that cannot move a host control at either
  declared endpoint while retaining ordinary valid steps.
- This remains a design-only lifecycle clarification plus pure manifest
  validation; Issue #77 still owns the runtime and hostile stateful-module
  browser fixtures. Browser verification remains intentionally not applicable.

## Part 10c issue #76 - PR #112 memory-layout and expanded-declaration follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review found that the former 1,025-page arithmetic consumed
  every page with pixels and parameters, leaving no feasible module data,
  stack, heap, or allocator space. It also found that raw section-entry counts
  did not expand compressed code-local multiplicities.
- Version 1 keeps the 1,025-page resident ceiling but now accepts manifest
  requests only from 258 pages upward and fixes one non-overlapping layout:
  8 MiB passive-data reserve, 8 MiB module stack/heap workspace, one 64 KiB
  host parameter/migration-input page, then the pixel/migration-output region.
  Both imported limits and host memory limits equal the manifest request, so
  growth is impossible. At the maximum, 48 MiB holds 12,582,912 RGBA pixels;
  a `P`-page request holds `(P - 257) * 16,384` pixels.
- Active data segments are rejected before engine work. A consistent data-count
  section and passive segments may use bounded bulk-memory `memory.init`/
  `data.drop` lazily during a watchdog-protected call, with conforming module
  data confined to pages 0-127 and allocator state to pages 128-255. This is a
  module-private ABI convention, not isolation from its own imported memory;
  the host refreshes inputs and validates/copies only exact owned outputs.
- The host-authored byte-policy parser now has explicit compressed-declaration
  gates (and, per the later worker-ordering correction below, runs inside the
  disposable activation candidate rather than synchronously in the parent):
  128 parameters/16 results per function type, 16,384 expanded signature fields,
  2,048 expanded locals per defined function and 16,384 per module, 2,048
  parameters-plus-locals per defined function and 16,384 after charging reused
  parameter vectors across defined functions, and a 32,768 checked combined
  raw-entry/signature/runtime-slot ceiling. Canonical body bounds, positive
  local groups, code/function count parity, supported value types, and every
  overflow are checked before validation, compilation, or instantiation.
- Larger ordinary render surfaces remain valid projects. A plugin that cannot
  hold one is visibly unavailable in preview and blocks export under the
  existing explicit reviewed-bypass policy. Issue #77 still owns the byte
  parser, runtime, and hostile cross-browser fixtures; this follow-up adds no
  production plugin execution.
- Validation passed 119 focused manifest/project/effect/architecture tests
  across five files, all 2,351 Vitest cases across 170 files, all 16 benchmark-
  runner checks, production build/typecheck, warning-free oxlint, clean diff
  checks, and the production high-severity audit with 0 vulnerabilities.
  Browser verification remains intentionally not applicable because the change
  adds no production plugin runtime or observable browser surface.

## Part 10c issue #76 - PR #112 migration-lifecycle and executable-budget follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review found that descriptor migration had no owner lifecycle,
  so an implementation could reuse mutable editor state, and that the 32 MiB
  module/declaration ceilings still permitted compressed executable-code and
  initializer-expression bombs before compilation.
- Every descriptor chain now freshly owns its migration worker, Wasm instance,
  fixed imported memory, private port, queue, request sequence, and generation
  after current trust/revocation/static-target preflight. Its port accepts only
  canonical migration traffic; sequential steps may share that chain owner, but
  pixels, editor/export messages, and state from another descriptor cannot.
- A multi-descriptor action reserves one sandbox slot, runs fresh chain owners
  serially in immutable document order, destroys each before the next, and stages
  bounded candidates. It commits once only after every chain and final document
  budget succeeds against unchanged starting values/generation. Every other
  terminal outcome destroys outstanding work without plugin cooperation,
  discards all staging, and preserves every original descriptor plus animation;
  retry is fresh. The later exact-head cache correction allows only a parent-
  owned verified raw-byte entry to remain, never compiled/engine code, and retry
  repeats all activation gates from a fresh copy.
- Host-authored binary policy now independently caps defined-function payloads
  at 256 KiB each/16 MiB per module, decoded instructions at 65,536 each/
  1,048,576 per module, explicit structured-control depth at 256, and `br_table`
  vector labels at 1,024 per instruction/16,384 per body/65,536 per module.
  Constant/initializer expressions are capped at 64 opcodes each/16,384 per
  module. These are independent of the existing checked declaration charges.
- The future Issue #77 parser must use one closed versioned opcode/immediate
  grammar, contain every immediate vector before allocation, validate control
  and branch depth, and require an exact final `end` with no trailing byte.
  Exact/+1 body, instruction, nesting, branch-table, and initializer fixtures,
  plus malformed/truncated/noncanonical/unsupported encodings and migration-
  lifecycle/atomicity fixtures, remain execution gates.
- Validation passed 119 focused manifest/project/effect/architecture tests
  across five files, all 2,351 Vitest cases across 170 files, all 16 benchmark-
  runner checks, production build/typecheck, warning-free oxlint, clean diff and
  source-marker checks, and the production high-severity audit with 0
  vulnerabilities. The first full-suite attempt hit the known five-second
  Inspector timing flake after 2,350 passing tests; that exact test passed 1/1
  in isolation, and the immediate authoritative solo rerun passed completely.
  The build retained only the existing >500 kB chunk advisory.
- Browser verification remains intentionally not applicable: this is still a
  design-only contract with no production binary parser, migration runtime, or
  observable browser surface. Issue #77 owns hostile-module browser fixtures.

## Part 10c issue #76 - PR #112 candidate-worker parser follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4922271431` found that placing the bounded Wasm byte-
  policy parser synchronously in the trusted parent still let a hostile near-
  limit module block the app/UI before the disposable-worker watchdog could
  terminate it.
- The trusted parent now owns only bounded package/manifest work, exact Wasm
  entry framing and byte length, integrity/signature/trust/raw-byte-cache
  preflight, the
  one activation deadline, and termination. It treats the framed module bytes
  as opaque and never iterates attacker-driven Wasm sections, bodies,
  instructions, immediates, or initializer expressions synchronously.
- That non-resetting five-second wall-clock deadline starts before candidate
  creation. The complete host-authored byte-policy parser runs inside the fresh
  disposable candidate worker under the existing static ceilings. Only after
  parse success may the same worker validate, compile, and instantiate; parse
  rejection invokes no engine API. Ready promotion retains worker identity, and
  any parse/engine failure or timeout lets the parent terminate the candidate.
- Issue #77 is now gated on parent responsiveness during near-limit parsing,
  deadline coverage across create/parse/validate/compile/instantiate, parse-
  failure proof that no engine API ran, and same-worker parse-to-promotion
  identity. This remains a design-only clarification with no production plugin
  parser/runtime or observable browser surface, so browser QA is not applicable.
- Final validation passed 119 focused manifest/project/effect/architecture tests
  across five files plus all 16 benchmark-runner checks, production build/
  typecheck, warning-free oxlint, and `git diff --check`. The ordinary bundle
  contains none of the plugin capability id, manifest authority, candidate-
  worker, Wasm-instance/validation, or `wasm-unsafe-eval` canaries. Four generic
  `WebAssembly.instantiate` references remain solely in the existing Mediabunny
  AC-3/ProRes codec chunks, not a plugin runtime. Build output retained only the
  existing >500 kB chunk advisory.

## Part 10c issue #76 - PR #112 render-parameter ABI follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4922439329` found that the ten-argument render ABI
  called its parameter buffer only “UTF-8 canonical,” leaving object shape,
  canonicalization, defaults, and animated-value timing ambiguous between host
  and plugin implementations.
- Version 1 now passes exactly one top-level parameter object with every and only
  the selected contribution's declared keys. A present value must match its
  declared number/boolean/enum kind and bounds or the stage fails/bypasses
  without a call; an absent declared value is completed ephemerally from the
  manifest default without changing durable data. Undeclared durable keys remain
  preserved but keep the descriptor unsupported and never cross the ABI.
- The host resolves only manifest-declared animatable numbers through the shared
  pure effect-track authority at the exact requested global integer timeline
  frame before serialization. Its static fallback is the materialized base
  number (valid authored value, otherwise manifest default), `step` never
  quantizes rendering, and the same immutable snapshot/frame yields
  byte-identical preview, scrub, playback, and export parameter bytes.
- The wire format is now explicitly RFC 8785 JCS followed by UTF-8 without BOM,
  whitespace, NUL termination, or trailing bytes. The JCS UTF-16 name sort is
  ordinary bytewise ASCII order for version-1 local-identifier keys. The exact
  half-open slice begins at `0x01000000`, is 2 through 65,536 bytes, and the host
  clears the complete parameter page before copy and after settlement.
- Migration retains its separate static canonical-record ABI and receives no
  frame-resolved values or render-time default completion. Issue #77 is gated on
  exact object/JCS/buffer/default/invalid-input, animation-frame, preview/export
  parity, maximum-valid 8,577-byte records, synthetic 64 KiB buffer boundaries,
  and render-versus-migration hostile fixtures. This remains design-only
  with no production plugin runtime or browser-observable change; browser QA is
  not applicable.
- Final validation passed 119 focused manifest/project/effect/architecture tests
  across five files plus all 16 benchmark-runner checks, production build/
  typecheck, warning-free oxlint, the production audit with 0 vulnerabilities,
  and clean diff/contradiction checks. The normal bundle has zero plugin
  capability/manifest/candidate/instance/validate/compile/CSP canaries. Its six
  generic `WebAssembly.instantiate` references are confined to four existing
  Mediabunny AC-3/ProRes codec chunks (one in each AC-3 chunk and two in each
  ProRes chunk), not a plugin runtime. Build output retained only the existing
  >500 kB chunk advisory.

## Part 10c issue #76 - PR #112 signature-envelope and raw-byte-cache follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4922582697` found two version-1 specification gaps:
  `signature.json` did not define one interoperable signed byte grammar/package-
  digest formula, and the compiled-module cache charged only raw Wasm length
  while retaining engine-native allocations of unknown size.
- `SignatureEnvelopeV1` now has closed exact keys and literals, canonical RFC
  8785 JCS bytes, strict unpadded-base64url Ed25519 key/signature encodings,
  lowercase-hex SHA-256 fields, exactly two normalized/path-sorted expanded-
  entry records, and explicit byte-length bounds. The Ed25519 message is the JCS
  envelope without `signature`; the package digest is a domain-separated,
  big-endian-`u32`-length-framed SHA-256 over that message and the decoded
  signature, represented as `sha256:` plus lowercase hex.
- The normative complete-package golden fixture pins a 496-byte canonical
  manifest, a valid 91-byte Wasm module, a 469-byte signed payload, a verified
  64-byte Ed25519 signature, a 570-byte canonical envelope, and package digest
  `sha256:cb47299284c74ad83fce88a8c2d50af97e9de6f6d56513f9e07ac7dac2851d97`.
- Version 1 retains no `WebAssembly.Module`, compiled/JIT/native/engine artifact,
  or engine reference across lifecycles. The optional trusted-parent session
  cache stores at most eight private write-once verified raw `Uint8Array` copies
  totaling at most 64 MiB actual retained `byteLength`; each activation gets a
  fresh copy. Deterministic access/key LRU needs no in-use lease, and pressure may
  bypass insertion. Cold and hit paths both reparse, validate, asynchronously
  compile, and freshly instantiate under the same non-resetting deadline.
- Issue #77 is gated on exact/+1 hostile signature forms, independent golden-
  vector crypto/hash verification, raw-byte ownership/mutation/transfer tests,
  exact key/count/byte/LRU/invalidation checks, engine-artifact non-retention,
  and spies proving no activation gate is skipped. This remains design-only, so
  browser QA is not applicable.
- Independent Node classic/Web Crypto and Python `cryptography` checks reproduced
  the exact public key/signature; Python separately reproduced every documented
  artifact length/hash, canonical JSON byte comparison, 575-byte framed input,
  and package digest. Node also validated/instantiated the fixture Wasm with its
  fixed 258-page import and confirmed the declared ten-`i32` export returns zero.
- Final frozen validation passed 119 focused manifest/project/effect/architecture
  tests across five files plus all 16 benchmark-runner checks, production build/
  typecheck, warning-free oxlint, the production audit with 0 vulnerabilities,
  clean diff and contradiction checks, and exact HEAD/upstream alignment. The
  normal bundle has zero plugin capability/signature/manifest/candidate/validate/
  compile/module/CSP canaries. Its six generic `WebAssembly.instantiate`
  references remain confined to four existing Mediabunny AC-3/ProRes codec
  chunks (one in each AC-3 chunk and two in each ProRes chunk), not a plugin
  runtime. The build retained only the existing >500 kB chunk advisory. A new
  full suite was intentionally not repeated for this docs-only correction; the
  exact-head suite was already green before these non-executing contract edits.

## Part 10c issue #76 - PR #112 deterministic migration-profile follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4922748950` found that version 1 admitted scalar
  floating-point and fixed-width SIMD throughout a module that could also export
  descriptor migrations. A migration could therefore reinterpret or branch on
  an implementation-selected NaN payload and commit different durable records
  on different engines.
- The candidate-worker parser now selects one closed binary-policy profile from
  validated signed manifest facts before scanning or engine work. All-empty
  contribution migration arrays select `myrelith-wasm-render-general-v1`; any
  nonempty migration array selects `myrelith-wasm-migration-integer-v1` for the
  complete signed module and every editor/export/migration activation.
- Migration-integer rejects `f32`, `f64`, and `v128` in every signature, block
  type, typed select, local, global, initializer, and body. It also rejects every
  scalar-float constant/load/store/arithmetic/comparison/conversion/
  reinterpretation form, float-related prefixed conversion, the complete `0xfd`
  SIMD family, and resource-dependent `table.grow`. The closed remainder is the
  deterministic `i32`/`i64`, control, variable, parametric, fixed-memory, bulk-
  memory, and bounded `funcref` table subset with no callable or nondeterministic
  host import.
- Enforcement is intentionally whole-module: unreachable functions, element
  targets, `ref.func`, mutable table dispatch, and `call_indirect` cannot escape
  the profile. Consequently, render exports packaged beside a migration are
  integer-only too. Render-only packages keep common scalar-float/fixed-SIMD
  compatibility and performance, but version 1 does not promise bit-identical
  third-party pixels across engines/hardware; exact host bytes, interpretation,
  ordering, and lifecycle boundaries remain pinned.
- The exact profile id and canonical opcode/immediate-table `sha256:` digest are
  part of raw-module-cache identity. A prior general-profile acceptance or cache
  hit cannot authorize migration-integer activation, and each candidate still
  parses before validation, compilation, and fresh instantiation.
- Migration input/output remains strict canonical JCS plus schema validation and
  one all-or-nothing action commit. Given identical canonical input and declared
  step order, every successful accepted migration must produce identical JCS
  bytes across supported engines; traps, timeouts, malformed output, and budget
  failure remain transactional failures rather than alternate output.
- Issue #77 now requires exact hostile fixtures for every forbidden type position
  and opcode category, `table.grow`, future features, unreachable/direct/indirect/
  mutable-table dispatch, NaN-payload branch bombs, empty-versus-one-migration
  profile selection, cache id/table-digest separation, and cross-engine canonical
  output goldens. This is still a design-only correction with no runtime/parser or
  browser-observable surface, so browser QA remains not applicable.
- Final frozen validation passed 119 focused manifest/project/effect/architecture
  tests across five files plus all 16 benchmark-runner checks, production build/
  typecheck, warning-free oxlint, the production audit with 0 vulnerabilities,
  and clean diff/contradiction/alignment checks. The ordinary bundle has zero
  occurrences of the plugin capability id, either binary-profile id, signature
  envelope/path, candidate-worker, plugin-manifest, validate, compile, module, or
  CSP canaries. Its six generic `WebAssembly.instantiate` references remain
  confined to four existing Mediabunny AC-3/ProRes codec chunks, not a plugin
  runtime. The build retained only the existing >500 kB chunk advisory. A new
  full suite was intentionally not repeated for this docs-only correction after
  the exact-head test suite had already passed; browser QA remains not applicable.
## Milestone 5 Part 10a / issue #44 - motion-analysis research

**RESEARCH COMPLETE LOCALLY (2026-08-11).**

- The bounded proof keeps analysis outside React, Zustand, portable documents,
  and production entry graphs. A disposable dedicated worker owns each run;
  the app controller admits one job, reserves one decoder slot, probes the exact
  browser primitives, and proves cancellation drains all worker/scheduler
  counters. The proposed derived-cache schema rejects stale provenance and is
  capped at 1,024 entries, 256 MiB per entry, and a 512 MiB target budget.
- Deterministic 320x180 synthetic fixtures support follow-up implementation of
  similarity-transform stabilization and bounded point/similarity-box tracking.
  Scene cuts and occlusion reject explicitly. Tracking output is defined as
  ordinary Position X/Y and optional Scale X/Y keyframes; analysis never edits
  the document until a later explicit Apply operation.
- The normalized Brown-Conrady manual lens parameter model and fixed-grid
  invertibility guard are viable, but production lens correction remains a
  deliberate no-go until #111 proves a bounded remap backend and exact
  preview/export parity. Shipping or downloading camera/lens profile catalogs
  is out of scope.
- Delivery is split into bounded children: #108 analysis jobs/cache, #109
  stabilization, #110 point/box tracking, and #111 lens-renderer feasibility.
  The complete decisions, provenance key, algorithms, tolerances, and browser
  measurements live in `docs/MOTION_ANALYSIS_RESEARCH.md`.
- The focused gate passed 18 tests. Real Playwright Chromium on strict
  port 41844 proved module workers, OffscreenCanvas, VideoFrame RGBA copy/close,
  OPFS create/read/remove, crypto digest, cancellation, a successful run, exact
  resource parity, zero active counters, and zero console problems. Final full
  validation passed all 2,322 Vitest cases across 172 files, all 16 benchmark-
  runner checks, production build/typecheck, oxlint, clean diff checks, and the
  production audit with 0 vulnerabilities. The build retained only the
  established large-chunk advisory.

## Milestone 5 Part 10a / issue #44 - review hardening (2026-08-11)

**REVIEW FEEDBACK RESOLVED LOCALLY.**

- The hard-cut gate now keeps two independently seeded textured scenes and
  requires at least 50% forward/backward-consistent feature coverage before
  similarity fitting. Fixture and algorithm versions advanced to v2; the
  regression rejects coincidental cross-scene RANSAC agreement rather than
  passing through an insufficient-texture shortcut.
- Controller-scoped admission is acquired before support probing or scheduler
  construction. A concurrent caller receives the typed `resource-unavailable`
  result and cannot create a second worker or reserve a second decoder slot.
- Tracking samples now carry their exact resolved source geometry. Full
  source-space scale/rotation/flip/anchor projection supplies project motion;
  target Position X/Y compensates Scale X/Y around the cropped visible center
  under target rotation, flips, and an off-center anchor. Per-sample source
  transform changes and ordinary preview/export animation evaluation remain
  covered without introducing another evaluator.
- The occlusion fixture now passes only when the box tracker fails on the exact
  first fully occluded frame (18), after accepting frame 17. A later false-
  positive recovery or an earlier unrelated loss fails the research gate.
- Point and box feasibility are calculated independently. Point error cannot
  veto an otherwise passing box result, and box geometry/scale/occlusion cannot
  veto an otherwise passing point result; the combined flag is summary only.
- The gate passed 24 focused research tests, all 2,328 Vitest cases across 172
  files, all 16 benchmark-runner checks, production build/typecheck, oxlint,
  clean diff checks, and the production audit with 0 vulnerabilities.
- Real Chromium reran only on strict port 41844 against exact clean
  implementation commit `9f45e44a514d7540637ab466d48516593b59a404` and
  fingerprint
  `sha256:14cde3fa5a470a15cdc1f5b18835eb2b0ac6284990b16e2baceeb8adc4addc5c`.
  It rejected the textured hard cut and overlapping run, completed analysis in
  217.7 ms, cancelled in 47.8 ms, drained workers 2/2, closed support frames 1/1,
  removed OPFS probes 1/1, reported zero console problems, and released the
  port. The ignored screenshot SHA-256 is
  `AF04F0EDD9044183700263D102740C19C0D1368F8570A6AAA35BEDB358D13AF6`.
- The five-group completion reran artifact schema 3 /
  `issue-44-motion-analysis-v3` on strict port 41844 against exact clean commit
  `3e632ab6dd0b24cc26ff61e38cf812ef4764f470`, fingerprint
  `sha256:0d12c3d9a76f3a4c6c5b922d57b2e5612a76fb8c217d3e6abb45667ba14a6af1`.
  Point and box independently reported go, occlusion failed on frame 18 after
  accepted frame 17, analysis completed in 237.2 ms, and cancellation settled
  in 52.8 ms. Workers drained 2/2, support frames closed 1/1, OPFS probes removed
  1/1, console problems stayed zero, and the port was released. The ignored
  screenshot SHA-256 is
  `2018D6738F26D35FD4E0DB23B8649AD49C96EE9412D4452A6CEED56BBDAEFDEF`.

## Milestone 5 Part 10a / issue #44 - follow-up review hardening (2026-08-12)

**FOLLOW-UP REVIEW FEEDBACK RESOLVED LOCALLY.**

- OPFS support probing now contains `removeEntry()` failure as a named cleanup
  outcome. The support result reports OPFS unsupported, the admitted research
  run rejects through typed `resource-unavailable` before scheduler/worker
  allocation, and diagnostics do not falsely count a failed removal as cleaned.
- Tracking-to-animation projection now validates every generated Position X/Y
  and Scale X/Y track with the canonical animation validator before returning.
  Mapped frames beyond the keyframe ceiling, derived project positions beyond
  the finite bound, and box growth beyond the clip-scale bound fail closed.
- The gate passed 28 focused research tests, all 2,332 Vitest cases across 172
  files, all 16 benchmark-runner checks, production build/typecheck, oxlint,
  clean diff checks, and the production audit with 0 vulnerabilities. The build
  retained only the established large-chunk advisory.
- Real Chromium reran artifact schema 3 / `issue-44-motion-analysis-v3` on
  strict port 41844 against exact clean implementation commit
  `3632e47c4cd3bf136b6c35d698ffa6ebcc009e76`, fingerprint
  `sha256:33df94dc420d8dc97422108473f7b89298557fe9ae72453bc9b6f092315fad67`.
  Point and box independently reported go, occlusion failed on frame 18 after
  accepted frame 17, analysis completed in 226.9 ms, and cancellation settled
  in 51.9 ms. Workers drained 2/2, support frames closed 1/1, OPFS probes
  removed 1/1, console problems stayed zero, and the port was released. The
  ignored screenshot SHA-256 is
  `7B35B9668FE5096F570C868FAAB3CF3BDDBC200B078E2909462107F5A57B03D5`.

## Milestone 5 Part 10a / issue #44 - worker-readiness review hardening (2026-08-12)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- Dedicated module-worker support now requires an explicit matching
  `probe`/`ready` handshake after the worker graph loads. Async load or message
  failure, synchronous post failure, and a bounded five-second non-response all
  report the worker unsupported and terminate the disposable probe.
- The admitted run threads its abort signal through readiness probing. Abort
  terminates the pending worker immediately, clears the timeout/listeners, and
  releases controller-wide admission. Every terminal race settles once; the
  worker also ignores malformed structured-clone messages at its boundary.
- The gate passed 32 focused research tests, all 2,336 Vitest cases across 172
  files, all 16 benchmark-runner checks, production build/typecheck, oxlint,
  clean diff checks, and the production audit with 0 vulnerabilities. The build
  retained only the established large-chunk advisory.
- Real Chromium reran artifact schema 3 / `issue-44-motion-analysis-v3` on
  strict port 41844 against exact clean implementation commit
  `ac555ca6a085f4093b9490107cddfaa79b961c71`, fingerprint
  `sha256:c8ca431438e60d0bae33cdd3df7dc23a2dfd10865284410953c07f60b7455e52`.
  The module-worker readiness handshake passed; analysis completed in 207.5 ms
  and cancellation settled in 46.3 ms. Point, box, and stabilization reported
  go, occlusion failed on frame 18 after frame 17, workers drained 2/2, support
  frames closed 1/1, OPFS probes removed 1/1, console problems stayed zero, and
  the port was released. The ignored screenshot SHA-256 is
  `202AD63A8E7F035D87C826874D6FB2CCAA4D73F73BB1F1E4932A4BBB9115F07F`.

## Milestone 5 Part 10a / issue #44 - concurrent OPFS-probe hardening (2026-08-12)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- Every support invocation now owns a distinct origin-wide OPFS filename with a
  128-bit Web Crypto nonce. Overlapping calls or tabs cannot remove, overwrite,
  or invalidate another probe, and each invocation removes only its owned name.
- A deterministic overlapping-probe regression runs two support calls together,
  proves distinct filenames, successful capability results, exact owned cleanup,
  and matching created/removed diagnostics.
- The full gate passed all 2,337 Vitest cases across 172 files plus all 16
  benchmark-runner checks, production build/typecheck, oxlint, clean diff checks,
  and the production audit with 0 vulnerabilities. The normal production bundle
  retained no motion-research controller, worker, cache, or probe identifiers.
- Real headed Chromium reran on strict port 41844. The support matrix was fully
  available; stabilization, point tracking, and box tracking reported `go`;
  occlusion failed on frame 18 after frame 17; cancellation and overlapping-run
  rejection stayed typed; workers drained 2/2, frames closed 1/1, OPFS probes
  removed 1/1, console problems stayed zero, and the port was released. The
  dirty exact-tree fingerprint was
  `sha256:58114f711222b3f9575717388d14adcdd654431855e0aa0e1c47d222378b3934`.

## Milestone 5 Part 10a / issue #44 - integer-pixel tracking hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of exact head
  `8979fa1015360f53b6a7fcc859b3f6907025114b` found that a fractional point seed
  could reach direct grayscale typed-array lookup. `trackPointSequence()` now
  rejects either non-safe-integer coordinate before bounds checking with a
  dedicated `RangeError`; this bounded matcher intentionally remains an integer
  patch search rather than adding an unreviewed subpixel interpolation contract.
- Integer search offsets preserve integral point matches, and regenerated box
  seeds remain explicitly rounded. A deterministic three-frame textured fixture
  rejects a fractional seed, distinguishes the existing bounds failure, and
  follows the valid integer seed exactly from `(32, 24)` through `(34, 25)` to
  `(36, 26)` without a false `lost-point`.
- The focused tracking file passed 10/10 tests. The domain matcher, tracking,
  and controller trio passed 29/29 tests, plus all 16 benchmark-runner checks;
  oxlint and `git diff --check` also passed.

## Milestone 5 Part 10a / issue #44 - OPFS cancellation hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of exact head
  `bf79f187d6fbe0fd95c6fd23248dc264d1944b8c` found that abort could remain
  blocked behind any pending OPFS capability promise, leaving controller-wide
  research admission occupied indefinitely.
- The OPFS probe now races its complete owned operation against the admitted
  run's signal. Abort returns `AbortError` and releases admission immediately;
  the observed late continuation stops between capability steps, closes a late
  writer, and removes only its invocation's 128-bit name when browser work
  settles. Abandoned work cannot publish successful diagnostics after caller
  settlement, while ordinary removal uncertainty remains a cleanup-specific
  unsupported result.
- Seven deterministic deferred regressions cover stalls in `getDirectory`,
  `getFileHandle`, `createWritable`, `write`, `close`, `getFile`, and
  `removeEntry`. Each proves prompt abort, admission of a second run, exact
  overlapping-name cleanup after late settlement, balanced resources, and no
  diagnostic drift or cross-removal.
- The controller passed 18/18 tests. The controller, matcher, and tracking group
  passed 36/36 tests plus all 16 benchmark-runner checks; the TypeScript build
  gate, oxlint, and `git diff --check` also passed.

## Milestone 5 Part 10a / issue #44 - readback and retained-memory hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of exact rebased head
  `bc17e540405b952ec5574278a83628855e6ee38d` found that a stalled support
  `VideoFrame.copyTo()` could ignore cancellation, retain its frame and shared
  research admission indefinitely, and that a small grayscale view could pin a
  backing allocation larger than the advertised 32 MiB retained-memory gate.
- Support readback now races the admitted run's signal and a finite five-second
  deadline. One idempotent owner closes the frame before abort or timeout settles
  and releases admission; the original readback promise remains observed, so a
  late resolve or rejection cannot re-close the frame, drift diagnostics, or
  become an unhandled rejection.
- Every grayscale `Uint8Array` must start at offset zero and cover its complete
  backing buffer. Both zero-offset and nonzero-offset views into oversized
  allocations reject before retained-byte summation, while tightly sized frames
  remain valid and are counted by their full backing allocation.
- Deterministic deferred readback regressions cover prompt abort, close-before-
  settlement, second-run admission, bounded timeout, late resolve and rejection,
  single-close diagnostics, and no post-settlement drift. The controller,
  matcher, and tracking group passed 42/42 tests plus all 16 benchmark-runner
  checks; the standalone TypeScript gate also passed.

## Milestone 5 Part 10a / issue #44 - worker-send cleanup hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of exact head
  `74c6ac6b2cb517b9bf4249754ec7fb6eabc8d670` found that a synchronous failure
  from the initial research-worker `postMessage()` rejected its Promise without
  reaching the worker cleanup owner.
- The initial send now catches that failure and rejects through the same
  idempotent terminal path as worker results, errors, and cancellation. That
  path removes signal/worker listeners, terminates exactly once, balances
  created/terminated/active diagnostics before caller settlement, and preserves
  the original send exception for the caller.
- A deterministic throwing-worker regression proves the first run drains before
  rejection, leaves no registered worker listeners, releases shared admission,
  and allows a second successful run with exact cumulative resource parity.

## Milestone 5 Part 10a / issue #44 - OPFS deadline hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of exact head
  `7075cc4fc8d48b26f7cd428973b6c41861c777e2` found that the default no-signal
  support and research calls could wait forever for a stalled OPFS capability
  promise, retaining controller-wide research admission indefinitely.
- Every OPFS probe now owns one non-resetting five-second deadline across its
  complete seven-step chain, even without an external signal. Deadline expiry
  reports a distinct unsupported reason through the typed `resource-unavailable`
  research path and promptly releases admission. If external abort wins first,
  the public terminal result remains `AbortError`; whichever terminal event wins
  cannot be reclassified by the later one.
- The original browser operation remains observed after caller settlement. Late
  progress stops between steps, a writer that arrives late is closed exactly
  once, and cleanup removes only that invocation's 128-bit nonce filename.
  Abandoned work cannot publish successful OPFS diagnostics. Normal completion
  clears the deadline and optional abort listener.
- Seven deterministic no-signal deadline regressions cover `getDirectory`,
  `getFileHandle`, `createWritable`, `write`, `close`, `getFile`, and
  `removeEntry`; two first-winner regressions cover deadline-versus-abort order.
  The controller passes 33/33 tests, and the focused controller/domain/tracking
  set passes 54/54 plus all 16 runner checks. The complete gate passes 174/174
  files and 2,382/2,382 Vitest tests plus those 16 runner checks; TypeScript/Vite
  build, oxlint, production audit at high severity, and `git diff --check` pass.

## Milestone 5 Part 10a / issue #44 - tracking scale-axis hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of exact head
  `05dc3bf8417a875187ea3286a16daa20e58e9b7f` found that anisotropic source-box
  growth still mapped source width directly to target Scale X and source height
  directly to Scale Y, even when the source and target axes were rotated apart.
- Each accepted sample now projects its transformed box support extents into the
  target's rotation-local axes. Absolute sine/cosine terms at the source-minus-
  target relative angle swap quarter-turn axes, mix arbitrary angles, and keep
  source/target mirror signs size-invariant; first-sample ratios preserve the
  authored target base scale exactly. Exact quadrants use semantic zero/one
  coefficients, and later samples divide before multiplying base scale so valid
  extreme extents do not overflow an intermediate. Non-positive or non-finite
  extents and derived ratios reject explicitly. A fixed target Rotation plus
  Scale X/Y represents arbitrary relative angles as a deterministic enclosing
  envelope rather than claiming exact independently rotating or sheared geometry.
- Deterministic projection cases cover relative 0, +90, -90, arbitrary 60-degree
  rotation, nonzero target rotation, per-sample rotation and anisotropic scale,
  source and target mirrors, unchanged cropped-center attachment, exact maximum-
  scale quadrant behavior, extent and ratio overflow/underflow, and rotated
  canonical scale overflow.
- The tracking file passes 20/20 tests. The controller/domain/tracking group
  passes 64/64 plus all 16 runner checks; the complete gate passes 174/174 files
  and 2,392/2,392 Vitest tests plus those 16 checks. TypeScript/Vite build, oxlint,
  production audit at high severity with 0 vulnerabilities, and `git diff
  --check` pass. The build retains only the established large-chunk advisory.

## Milestone 5 Part 10a / issue #44 - worker-response cleanup hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of exact head
  `b3517c980d8f20e9752f7ec61e559179be275eaf` found that the admitted research
  worker did not settle when the browser dispatched `messageerror` for a reply
  it could not deserialize, retaining the worker, scheduler slot, and shared
  research admission indefinitely.
- The run worker now registers `messageerror` before its initial post and routes
  it through the same idempotent terminal owner as results, runtime errors,
  cancellation, and synchronous post failure. It returns a typed `unexpected`
  failure only after removing every signal/worker listener, terminating once,
  and balancing worker diagnostics; late competing events cannot settle or
  mutate diagnostics again.
- A deterministic regression dispatches `messageerror` after progress, proves
  exact 1/1 created/terminated parity and zero active workers/listeners before
  rejection, injects late result/error/messageerror events without drift, and
  admits a successful retry. The support-probe worker lifecycle already handled
  and removed `messageerror`, so it required no duplicate change.
- The controller passes 34/34 tests. The focused controller/domain/tracking set
  passes 65/65 plus all 16 runner checks; the complete gate passes 174/174 files
  and 2,393/2,393 Vitest tests plus those 16 checks. TypeScript/Vite build,
  oxlint, production audit at high severity with 0 vulnerabilities, and `git
  diff --check` pass. The build retains only the established large-chunk
  advisory. The headed research runner cannot synthesize a worker
  response-deserialization failure, so direct browser coverage is the focused
  lifecycle regression; a source-bound broad research rerun follows the clean
  commit.

## Milestone 5 Part 10a / issue #44 - crop-feasibility hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of exact head
  `87e6d8cbb5157ce53a7e4aa62995b98472bf92f8` found that the conservative crop
  estimate clamped any required inset above 49% to a supposedly safe 50× zoom,
  even though no finite centered zoom can cover an inset at or above half the
  shorter frame dimension.
- Stabilization plans now retain all camera-path, correction, jitter, and
  maximum-displacement diagnostics while exposing crop feasibility as an
  explicit result union. The exact `[0, 0.5)` interval remains available; at or
  above one half returns `finite-centered-zoom-unavailable` with the measured
  ratio and no fabricated zoom. There is deliberately no epsilon dead zone.
- The quality gate requires available crop results at both reviewed strengths,
  so unavailable geometry produces stabilization `no-go` and cannot reach a
  future Apply path. The headed evidence renderer presents the stable failure
  reason without dereferencing a missing numeric zoom.
- Because the nested crop union and `cropFailure` field are incompatible with
  the preceding artifact shape, the current runner advances to schema 4 /
  `issue-44-motion-analysis-v4`. The schema 3 / v3 entries above remain exact
  historical evidence; a new clean-commit browser run must publish v4.
- Deterministic cases cover the representable values immediately below and
  above one half, the exact boundary, a sustained pan at the maximum smoothing
  radius, non-finite accumulated geometry, ordinary finite plans, JSON-safe
  evidence, non-finite derived path metrics, and downstream gate refusal.
- The first boundary-test attempt passed 15/17 cases but used decimal-sized
  geometry that rounded adjacent representable ratios back to the boundary. A
  power-of-two fixture then passed 16/17 and exposed cancellation in the old
  transformed-corner subtraction. The final direct similarity-delta measurement
  preserves the immediately-below value and passes all boundary cases.
- The controller/domain/tracking group passes 72/72 tests plus all 16 runner
  checks; the complete gate passes 174/174 files and 2,400/2,400 Vitest tests
  plus those 16 checks. TypeScript/Vite build, oxlint, high-severity production
  audit with 0 vulnerabilities, normal-bundle canary scan, and `git diff
  --check` pass. The build retains only the established large-chunk advisory.
- After the schema-only v4 correction, the 72/72 focused cases and all 16 Node
  runner checks passed again, as did TypeScript/Vite build, oxlint, runner
  syntax, the normal-bundle canary scan, and `git diff --check`. No production
  TypeScript, test, or dependency semantics changed, so the 2,400-case full
  suite and zero-vulnerability dependency audit above were not repeated. The
  clean-commit v4 Chromium artifact remains the next source-bound gate.

## Milestone 5 Part 10a / issue #44 - refined-similarity envelope hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of exact head
  `ffbd92b3b5df976cae931f0b487bef2cabf5d853` found that deterministic pair
  hypotheses enforced the bounded similarity model, but the least-squares
  inlier refinement could escape it before final-inlier acceptance.
- One shared motion-envelope guard now requires every transform field to be
  finite, scale to remain in the inclusive `[0.85, 1.15]` interval, and
  absolute rotation to remain at or below `pi / 12`. Both pair hypotheses and
  the refined transform use it; nothing is clamped back into range.
- The reviewer geometry with two stationary matches and six inward-shifted
  matches keeps all eight within the identity inlier threshold but refines to
  scale `92 / 122`, approximately `0.754098`; it now rejects before final-inlier
  filtering. Exact and interior scale/rotation boundaries remain accepted,
  just-outside values reject, and non-finite geometry fails closed.
- Stabilization and similarity-box tracking both consume the guarded estimator.
  Stabilization treats a rejected pair as confidence failure, and box tracking
  reports loss before transforming the box; neither consumer needed a parallel
  envelope or a separate refactor.
- The regression-first motion-analysis run failed exactly the five newly added
  out-of-envelope cases (24/29 passed), including the review fixture returning
  scale `0.7540983606557377`. After the guard, the file passes 29/29 plus all 16
  Node runner checks. The controller/domain/tracking set passes 83/83 tests;
  the complete suite passes 174/174 files and 2,411/2,411 tests plus those 16
  checks. TypeScript/Vite build, oxlint, Issue #44 runner syntax, production
  high-severity audit with 0 vulnerabilities, and `git diff --check` pass. The
  build retains only the established large-chunk advisory.
- The normal 32-file, 5,871,592-byte production artifact contains zero motion-
  research/cache/version canaries, zero `navigator.gpu` or `requestAdapter`
  references, and zero WebGPU experiment chunks. The CPU scope worker retains
  its established disabled-experiment error literal; an initially overbroad
  text canary caught that expected fallback and was narrowed to the actual API
  and chunk boundary.

## Milestone 5 Part 10a / issue #44 - pair-schedule and seed-budget hardening (2026-08-13)

**LATEST REVIEW FEEDBACK RESOLVED LOCALLY.**

- The Codex review of rebased exact head
  `86f17e6ac4b8e46b55617366dd5cbb79ddc2edd8` found two bounded-algorithm gaps:
  the 256-hypothesis loop consumed only a lexicographic pair prefix, and box
  tracking always generated sixteen seeds even under a valid smaller feature
  budget.
- `similarity-block-ransac-v3` now maps the exact hypothesis cap to unique,
  evenly spaced ranks over the complete unordered-pair space. Full schedules
  enumerate every pair, capped schedules with at least two hypotheses include
  both endpoints, a one-hypothesis schedule selects the middle rank, and each
  rank is un-ranked without materializing all pairs. Cancellation remains once
  per evaluated hypothesis and the established first-winner tie order remains
  deterministic. The v3 identity makes cached v2 results explicitly stale;
  browser artifact schema 4 remains unchanged because its JSON shape did not
  change. A separately testable runner contract pins fixture
  `issue-44-synthetic-v2` and algorithm v3 before screenshot or artifact writes,
  so stale or miswired worker evidence cannot publish a passing report.
- The ordered review regression contains 29 translated foreground matches then
  35 stationary background matches. Under 64 matches and the 256 cap, v3
  samples 46 foreground-only, 134 cross-group, and 76 background-only pairs,
  selects the 35-inlier majority, and retains that result after a deterministic
  permutation.
- Box tracking now rejects only its own unsupported budget below eight, selects
  exactly `min(maxFeatures, 16)` spatially spread seeds for valid budgets 8-15,
  and preserves the original sixteen-seed order at the default. Point tracking
  still succeeds at `maxFeatures: 1`; the shared budget validator was not
  narrowed.
- The regression-first focused attempt failed all ten new behavior cases as
  intended: the old prefix selected 29 inliers, budgets 8-15 exceeded the
  feature cap, and budget 7 reached the old downstream error (50/60 passed).
  After the fixes, the initial three-file corrected run passes 65/65 plus the
  then-current 16 Node runner checks. The provenance guard raises that runner
  set to 17/17. The final controller/motion/tracking/cache focused set passes
  100/100 tests; the authoritative suite passes 175/175 files and 2,454/2,454
  tests plus all 17 runner checks. TypeScript/Vite build, oxlint, both runner
  syntax checks, the high-severity production audit with 0 vulnerabilities,
  and `git diff --check` pass. The build retains only the established large-
  chunk advisory.
- The normal 32-file, 5,871,618-byte production artifact contains zero motion-
  research/fixture/algorithm/cache/controller/worker canaries, zero WebGPU API
  references or experiment chunks, and zero plugin-runtime/profile canaries.
  The six generic `WebAssembly.instantiate` occurrences remain confined to four
  existing Mediabunny AC-3/ProRes codec chunks. The source-bound headed browser
  rerun must wait for the exact tree to be committed and must prove schema 4,
  fixture v2, and algorithm v3.

## Milestone 5 Part 10a.1 / issue #108 - motion-analysis job/cache foundation (2026-08-13)

**IMPLEMENTATION COMPLETE LOCALLY.**

- Production motion analysis now has a StrictMode-safe editor lifecycle and an
  app-owned controller over a dedicated `MediaJobScheduler` budget of one job,
  one decoder, and one worker. Generation-specific scheduler ids prevent a new
  request from cancelling a completed generation during the scheduler's final
  bookkeeping turn. UI-facing snapshots contain only bounded serializable
  progress, status, cache-hit, and typed failure facts; no analysis path edits
  the timeline document.
- The dedicated production worker opens the real source through the reviewed
  Mediabunny worker owner, decodes sequentially, downsamples to at most 320x180
  grayscale, closes every `VideoFrame` immediately, and streams acknowledged
  windows. The transport retains at most 300 frames / 32 MiB including the
  two-frame overlap. The app bridge independently validates progress, window
  order/offsets, tight buffers, sample totals, and terminal peak facts before a
  result can become cache provenance, then detaches every transferred plane as
  soon as its consumer settles so retained references cannot pin old windows.
  The exact browser preflight also proves transferable-buffer ownership before
  enabling the foundation.
- The strict schema-1 OPFS sidecar lives under
  `myrelith-derived/analysis-cache-v1`. Exact keys bind local project, source
  fingerprint and stream/range/rate/sampling, clip mapping/projection, and
  algorithm/version/parameters. Result bytes stage before the bounded manifest;
  a post-commit currentness check either publishes or rolls back. Missing or
  malformed bytes/manifests, unavailable OPFS, quota pressure, stale provenance,
  cancellation, replacement, removal, and disposal remain recoverable and
  cannot become portable project truth.
- The shared sampled SHA-256 implementation is factored from the existing proxy
  path without changing proxy fingerprints. The exact analysis cache joins the
  derived-storage clear/estimate registry; project files, recovery, handles,
  and undo history remain outside that registry.
- Focused controller/storage/bridge/decode/provenance/architecture coverage
  passes 44/44 tests plus all 17 Node runner checks. The authoritative full
  suite passes 179/179 files and 2,485/2,485 tests plus those 17 checks.
  TypeScript/Vite build, oxlint, the production high-severity dependency audit
  with 0 vulnerabilities, runner syntax, and `git diff --check` pass. The build
  retains only the established large-chunk advisory.
- In-app Chromium decoded a generated 160x90 H.264 MP4 with 12 frames through
  the production worker, retained 12 frames / 172,800 bytes at peak, committed
  a 269-byte result, read the identical bytes from cache on the second request,
  and drained with scheduler jobs 2/2 complete, 0 cancelled/failed, one worker
  created/terminated, and no console or page problems. The reproducible
  `qa:issue108:foundation` clean-commit artifact is the publication gate.

## Milestone 5 Part 10a.1 / issue #108 - first exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4925391802` on `b5b6fb79c6` found four current
  threads: cancellation could settle while an acknowledged window remained
  attached, source rotation metadata was not applied before grayscale
  extraction, the Issue #108 dev gate allowance existed only in the guard, and
  source-open resource failures were flattened into decode-readback.
- Cancellation now terminates the worker promptly but retains the admitted job
  promise until the in-flight consumer settles and the window buffers detach.
  A deterministic deferred-consumer regression proves cancellation stays
  pending with the buffer attached, then rejects only after exact release.
- The decode path threads 0/90/180/270-degree metadata into a tested
  display-space orientation plan before downsampling. Worker protocol mapping
  now preserves unsupported-codec, resource-limit, and resource-unavailable;
  only genuine decode failure maps to decode-readback.
- The canonical dependency rules now name the exact
  `dev/issue108/motionAnalysisFoundation.ts` app/domain/pipeline exception and
  its sole checked-in HTML importer, matching the narrow architecture guard.
- The refreshed focused gate passes 44/44 tests plus 17/17 runner checks; the
  authoritative full suite passes 179/179 files and 2,485/2,485 tests plus the
  runner checks. Build/lint/audit/diff and clean-commit Chromium evidence are
  refreshed before the follow-up commit is published.

## Milestone 5 Part 10a.1 / issue #108 - second exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4925551773` on `567df2dcb6` found two remaining
  ownership/provenance gaps: a transferred window rejected during app-side
  validation retained its identifiable grayscale buffers, and a valid
  zero-sample worker completion could reach result finalization and then fail
  indirectly at the positive-sample cache-manifest boundary.
- The bridge now gathers only actual `ArrayBuffer`-backed views from a rejected
  window, deduplicates shared backing buffers, and detaches them before terminal
  rejection. If that ownership release itself fails, the run reports a typed
  resource-unavailable failure while still terminating the worker and balancing
  scheduler diagnostics. The regression retains the rejected plane and proves
  its byte length is zero at promise rejection.
- The controller now classifies a zero-sample completion directly as
  decode-readback before invoking the result processor or staging cache bytes.
  The deterministic regression proves no window consumer, result finalizer,
  result staging, or manifest commit runs, while the worker and scheduler still
  settle into the typed error state.
- The refreshed focused gate passes 61/61 tests plus 17/17 runner checks; the
  authoritative suite passes 179/179 files and 2,486/2,486 tests plus those
  runner checks. TypeScript/Vite build, oxlint, the high-severity production
  audit with 0 vulnerabilities, runner syntax, and `git diff --check` pass.
  Clean-commit Chromium, CI, and fresh exact-head Codex review evidence follows
  on the final committed tree.

## Milestone 5 Part 10a.1 / issue #108 - third exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4925687652` on `6a20378735` found two additional
  ownership/identity gaps: cancelled or timed-out cache reads and processor
  finalizers did not release result buffers that arrived after settlement, and
  the cache identity accepted a non-primary video stream index while production
  decode always selected the primary track.
- Cache reads and processor results now register synchronous late-value cleanup
  with the owned-operation race. Late buffers detach as soon as they resolve;
  accepted result bytes also detach on stale-source, staging, commit, or final
  validation failure, while successful callers retain the sole live result.
  Deterministic deferred cache-read and processor-finalizer regressions prove
  both late buffers reach zero length after cancellation and never reach cache
  staging.
- The production contract explicitly supports only primary video stream index
  `0`. The controller rejects every other index before fingerprint/cache/worker
  work; accepted index `0` is carried in the worker message and independently
  validated before the worker opens the primary track. Cache provenance can no
  longer claim bytes from an unrequested stream.
- The refreshed focused gate passes 63/63 tests plus 17/17 runner checks; the
  authoritative suite passes 179/179 files and 2,488/2,488 tests plus those
  checks. TypeScript/Vite build, oxlint, the high-severity production audit with
  0 vulnerabilities, runner syntax, and `git diff --check` pass. Clean-commit
  Chromium, CI, and fresh exact-head Codex evidence follows on the committed
  tree.

## Milestone 5 Part 10a.1 / issue #108 - fourth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4925839848` on `c9fca850ce` found one remaining
  malformed-protocol ownership gap: a worker window carrying a different
  request ID was ignored without releasing its transferred planes or
  terminating the dedicated worker.
- Every mismatched reply now terminates the admitted run as an unexpected
  protocol failure. A mismatched window first detaches every safely
  identifiable `ArrayBuffer`; release failure preserves the typed
  resource-unavailable classification. If a correct window is already being
  consumed, scheduler settlement remains held until that separately owned
  window is released.
- The deterministic regression retains a mismatched plane and proves it is
  detached before rejection, the consumer is never called, listeners are
  removed, the worker is terminated exactly once, and decoder/worker
  diagnostics return to zero. The refreshed focused gate passes 64/64 tests
  plus 17/17 runner checks; the authoritative full suite passes 179/179 files
  and 2,489/2,489 tests plus those checks. TypeScript/Vite build, oxlint, runner
  syntax, and `git diff --check` pass; the high-severity production audit finds
  0 vulnerabilities. Clean-commit Chromium, CI, and fresh exact-head Codex
  evidence follow on the committed tree.

## Milestone 5 Part 10a.1 / issue #108 - fifth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4925934732` on `8520255ea9` found two final
  boundary gaps: the architecture guard's two motion-worker-to-pipeline imports
  were not named in canonical architecture, and a structured-cloneable
  non-object or unknown-discriminator reply could throw outside common worker
  cleanup.
- Canonical architecture now sanctions only
  `workers/motion-analysis.worker.ts` importing the bounded decode core and its
  serializable protocol. No broader worker-to-pipeline exception is implied.
- Both the support probe and admitted run validate that every reply is a
  non-array object with a known discriminator and a non-negative safe-integer
  request ID before reading it. An admitted malformed value is rejected through
  common cleanup; any identifiable embedded buffers are released first, and
  release failure remains a typed resource-unavailable result.
- Deterministic regressions cover `null`, `undefined`, a primitive number, and
  an unknown discriminator, proving exact termination, listener removal, and
  balanced decoder/worker diagnostics. An additional hostile-value regression
  proves identifiable buffers nested in a malformed discriminator detach
  before rejection. The refreshed focused gate passes 69/69
  tests plus 17/17 runner checks; the authoritative full suite passes 179/179
  files and 2,494/2,494 tests plus those checks. TypeScript/Vite build, oxlint,
  runner syntax, and `git diff --check` pass; the high-severity production audit
  finds 0 vulnerabilities. Clean-commit Chromium, CI, and fresh exact-head
  Codex evidence follow on the committed tree.

## Milestone 5 Part 10a.1 / issue #108 - sixth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4926084336` on `0a5335a0f2` found three remaining
  decode-lifecycle gaps: periodic progress was skipped whenever the eighth
  decoded frame was not sampled, signed exact primary-stream starts were
  rejected by both the worker message gate and playback lane, and cursor/source
  close rejections were discarded after an otherwise successful decode.
- Decoded-frame progress now runs every eight decoded frames before the
  unsampled-frame branch, with the sampled count reflecting every sample
  retained so far. Exact primary-stream start/end values remain signed safe
  integers through worker validation and the Mediabunny playback lane; seek
  targets remain non-negative.
- Decoder teardown now invokes both cursor and source close paths even when one
  throws or rejects. Any cleanup failure prevents successful completion; if
  decode and cleanup both fail, one `AggregateError` retains the primary cause
  plus every owner-close failure.
- Deterministic regressions prove progress at decoded frames 8 and 16 with a
  two-frame sampling interval, negative playback bounds reaching the sink
  unchanged, successful decode rejected by dual close failures, and primary
  decode failure retained alongside synchronous/asynchronous cleanup failures.
  The refreshed focused gate passes 67/67 tests plus 17/17 runner checks; the
  authoritative full suite passes 180/180 files and 2,500/2,500 tests plus the
  runner checks. TypeScript/Vite build, warning-free oxlint, the high-severity
  production audit with 0 vulnerabilities, runner syntax, and `git diff
  --check` pass. Clean-commit browser evidence follows on the committed tree.

## Milestone 5 Part 10a.1 / issue #108 - seventh exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4926250834` on `deada8562d` found two remaining
  cache-ownership gaps: cancellation or the ten-second deadline released the
  admitted job before a pending manifest commit and its rollback settled, and
  an individually impossible allocation evicted usable LRU entries before the
  cache reported that it still could not fit.
- A pending manifest commit now records the first abort/deadline cause while
  continuing to own the staged result and scheduler slot until the underlying
  write settles. Cancellation still rejects the public request immediately;
  deadline expiry also publishes its typed failure immediately. A successful
  late commit is then rolled back before admission releases, and cleanup
  failure is no longer discarded.
- Capacity admission now rejects `requiredBytes > computed ceiling` before any
  manifest mutation or file removal. Deterministic regressions prove abort and
  deadline both keep the next job queued until rollback, preserve exact one-job
  concurrency, and leave an existing manifest entry plus result file untouched
  after an impossible request.
- The refreshed focused gate passes 72/72 tests across nine files plus all
  17/17 runner checks. The authoritative full suite passes 180/180 files and
  2,503/2,503 tests plus those runner checks. TypeScript/Vite build, warning-free
  oxlint, runner syntax, `git diff --check`, and the high-severity production
  audit with 0 vulnerabilities pass. Clean-commit Chromium, CI, and another
  fresh exact-head Codex review follow on the committed tree.

## Milestone 5 Part 10a.1 / issue #108 - eighth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4926378868` on `f00a88b37f` found that the public
  motion-analysis status preserved worker failure remediation, but the
  scheduler history received the wrapper `MotionAnalysisError` and therefore
  mislabeled every failure as `unexpected`.
- The controller now converts its final public failure into the scheduler's
  canonical taxonomy before rethrowing to scheduler diagnostics. Unsupported
  codec and resource limit remain exact; decode/readback becomes decode failed;
  unsupported runtime, quota, and cache corruption become resource unavailable;
  only failures without a scheduler class remain unexpected. Aborted jobs still
  use scheduler cancellation rather than failure history.
- A five-case deterministic matrix proves each worker failure produces both the
  intended motion-specific public status and the matching scheduler history,
  with exact worker teardown. The refreshed focused gate passes 77/77 tests
  across nine files plus 17/17 runner checks; the authoritative full suite
  passes 180/180 files and 2,508/2,508 tests plus those checks. Build, lint,
  production audit, static checks, clean-commit Chromium, CI, and one more exact-
  head Codex review follow on the committed tree.

## Milestone 5 Part 10a.2 / issue #109 - bounded video stabilization (2026-08-13)

**IMPLEMENTATION COMPLETE LOCALLY.**

- The Animation Inspector now exposes an accessible local Analyze, progress,
  Cancel/Retry, strength, integer smoothing radius, exact required-crop/safe-
  zoom evidence, playhead Preview, explicit replacement confirmation, Apply,
  and Reset workflow. Preview is transport-only; only Apply or Reset creates a
  single history entry.
- `app/videoStabilizationController.ts` is the production adapter over Issue
  #108. It uses the exact connected source, SourceTimeMap, project/clip
  projection, algorithm, and parameter digests; consumes overlapping worker
  windows once; preserves typed scene-cut, inlier/residual, source, cache, and
  cancellation failures; detaches result bytes after strict parsing; and
  rechecks the source/project snapshot before preview or Apply.
- `domain/videoStabilization.ts` owns the O(n) full-product similarity smoother,
  canonical source-time inversion, project-space correction for crop, anchor,
  flips, rotation, and uniform scale, and exact safe-coverage planning. Analysis
  aspect rounding must project back to a similarity within 0.25 project px.
  Key simplification reserves the 0.5 px final-corner, 0.05 degree, and 0.05%
  scale tolerances before the maximum 1.35x zoom, then safe coverage is solved
  against the simplified path at every integer clip frame. Displayed required
  crop is the total span `1 - 1 / safeZoom`.
- Product bounds are 1,000,000 clip frames, 65,534 retained analysis samples,
  120 smoothing frames, 4,000,000 simplification comparisons, 1,024 keys per
  transform track, and 100,000 document keys. The immutable operation rechecks
  the document-wide budget, replaces
  only ordinary Position X/Y, Rotation, and equal Scale X/Y tracks after
  explicit consent, and preserves opacity/effect animation. Shared ordinary
  animation evaluation remains the only preview/export path.
- Deterministic focused coverage passes 136/136 domain, operation, controller,
  store, Inspector, UI, and architecture tests. The authoritative suite passes
  184/184 files and 2,528/2,528 Vitest tests plus 17/17 evidence-runner checks.
  TypeScript/Vite production build, warning-free oxlint, runner syntax, diff and
  conflict checks, and the high-severity production audit with 0 vulnerabilities
  pass.
  A dirty-tree real Chromium source gate processed 32 generated H.264 samples,
  produced 31 keys per track, solved 1.0224x safe zoom / 2.20% total crop,
  proved an exact cache miss-to-hit, left worker and scheduler resources
  balanced, removed the cache entry, and reported zero console/page problems.
  Headed Chromium then reproduced the same result from clean exact commit
  `cabd4202fc`, with source fingerprint `ad177dad…`, one clean cache round-trip,
  JSON/PNG artifacts, zero browser problems, and exclusive port 41866 fully
  released. Exact-head CI and Codex review remain publication gates.

## Milestone 5 Part 10a.2 / issue #109 - first exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4926987766` on `e0492442ad` found two P1 gaps: a
  completed analysis could repopulate the Inspector after selection moved to
  another clip, and the architecture guard's new Issue #109 dev exception was
  not named in canonical architecture.
- The Inspector now owns an analysis-generation token. Starting a request
  captures its token and clip ID; clip change, cancel, and unmount synchronously
  invalidate the token and cancel the original clip's admitted job. Late success
  or failure cannot install a session, preview the new selection, or apply to
  the old clip. A deterministic deferred-result regression proves the new clip
  remains idle, Apply stays disabled, no plan is built, and the old request is
  cancelled.
- Canonical architecture now grants only
  `dev/issue109/videoStabilizationGate.ts` the exact `app`/`domain`/`state`
  composition used by `scripts/issue109/stabilization-gate.html`; ordinary app
  entries and every other dev module remain forbidden. The architecture guard
  and documentation are aligned again.
- The review-focused UI/architecture gate passes 8/8 tests; the authoritative
  suite passes 184/184 files and 2,528/2,528 tests plus 17/17 runner checks.
  Build/typecheck, warning-free lint, and `git diff --check` pass. Clean-commit
  Chromium, CI, and a fresh exact-head Codex verdict follow on the fixed head.

## Milestone 5 Part 10a.2 / issue #109 - second exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4927072774` on `0901322c43` found that a legitimate
  million-sample result could exhaust memory or exceed the shared cache-entry
  envelope only after the complete expensive run, and that Reset misleadingly
  described ordinary transform tracks as stabilization-owned even though it
  also removes manual or other-tool animation.
- Stabilization now reserves a 32 MiB working-result ceiling derived from the
  shared 256 MiB cache-entry limit, 1 KiB for the enclosing record, and at most
  512 serialized bytes per retained sample. The resulting 65,534-sample cap is
  checked before another pair is analyzed or retained; cached bytes are
  rejected before UTF-8 decoding when they exceed the same product envelope.
- Reset now discloses before action that it removes every ordinary Position,
  Rotation, and Scale animation track, including keyframes created manually or
  by another tool. The button's accessible description includes that warning,
  and source comments no longer imply unavailable ownership provenance.
- The review-focused refresh passes 18/18 tests across the adapter, UI,
  operation, and architecture suites. The authoritative suite passes 184/184
  files and 2,530/2,530 tests plus all 17 evidence-runner checks;
  build/typecheck, warning-free lint, the high-severity production audit with
  0 vulnerabilities, and diff checks pass. Clean-commit Chromium, CI, and a
  fresh exact-head Codex verdict follow on the frozen fix.

## Milestone 5 Part 10a.2 / issue #109 - third exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4927205703` on `07cc955d97` found that source-time
  inversion correctly selects the latest frame of a 0x plateau, but ordinary
  linear stabilization keys could then interpolate correction motion through
  the earlier frozen frames.
- Planning now detects every exact equal-source-time run over the bounded clip
  duration, materializes matching first/last plateau corrections, gives the
  first key ordinary `hold` easing, and protects both keys from simplification.
  Moving spans remain linear; preview and export still use only the shared
  ordinary animation evaluator. The existing 1,024-key ceiling rejects a plan
  if the protected boundaries and simplified path cannot coexist.
- A deterministic speed-curve regression moves before a three-frame freeze and
  proves all five Position/Rotation/equal-Scale tracks stay byte-value constant
  at every frozen timeline frame while the pre-freeze value differs. Focused,
  full, build, lint, audit, and diff gates pass: 5/5 focused files with 28/28
  tests, 184/184 full-suite files with 2,531/2,531 tests, 17/17 evidence-runner
  checks, TypeScript/Vite production build, warning-free lint, and 0 production
  vulnerabilities. Headed Chromium on clean exact code commit `b9695cd6c2`
  reproduces 32 analyzed samples, 31 keys per track, 1.0224× safe zoom, an
  exact cache hit, balanced 1-created/1-terminated/0-active worker ownership,
  zero console/page problems, and complete port 41870 release. That broad
  source-bound flow uses ordinary 1× timing; the deterministic domain test is
  the direct 0× freeze coverage. CI and fresh exact-head review follow.

## Milestone 5 Part 10a.2 / issue #109 - fourth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4927432158` on `bbea2ed8c1` found that nonzero rates
  below 1× also repeat a decoded source frame even though their exact source
  ticks advance, so the zero-rate-only fast path could still author visible
  correction drift over valid slow-motion footage.
- Planning now uses the canonical decoded-source-frame selector. Any timeline
  run that resolves to one source frame receives matching first/last correction
  keys and `hold` easing at the first edge, whether repetition comes from 0× or
  fractional speed. For every map that can repeat, analyzed corrections are
  indexed by decoded source frame and rematerialized at the timeline frame that
  actually displays that image, including singleton runs between repeats. An
  exact correction therefore wins even when floor-style SourceTimeMap inversion
  placed its sample on the preceding 0.75× image or the other 0× plateau edge.
  Maps whose rates cannot repeat a decoded frame retain the zero-work fast path.
- Structural repeated-frame edges are counted before retention and reject once
  they exceed the existing 1,024-key envelope. Deterministic 0.25× coverage
  proves three successive four-frame runs hold all five authored properties,
  change only at the next decoded frame, and reject an over-budget 2,052-frame
  case. A separate 0.75×/1× parity matrix proves all six analyzed source-frame
  corrections land on the timeline frame that displays the same source image.
  The final frozen refresh passes 5/5 focused files with 31/31 tests, 184/184
  full-suite files with 2,534/2,534 tests, all 17 evidence-runner checks,
  TypeScript/Vite build, warning-free lint, the production audit with 0
  vulnerabilities, and clean diff checks. Clean browser, CI, and exact-head
  review follow after commit.

## Milestone 5 Part 10a.2 / issue #109 - fifth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4927600566` on `2b30caa41c` found that analysis
  request bounds and result timestamps converted conformed SourceTimeMap ticks
  with the connected asset's native frame rate. With 60 fps media in a 30 fps
  project, that could analyze only half of a one-second clip and then spread
  the returned corrections across the wrong timeline frames.
- Both boundaries now use the document frame rate: conformed source ticks map
  to WebCodecs microseconds with floor/ceil request-bound rounding, and sampled
  timestamps return through the canonical nearest-project-frame adapter. The
  native source rate remains authoritative only for the decoder sampling
  interval, so a 60 fps source in a 30 fps project samples every two native
  frames without changing the clip's conformed source-time scale.
- A deterministic mismatched-rate regression pins both conversion directions,
  the nonzero first source timestamp, and floor/ceil subframe boundaries. The
  final focused gate passes 5/5 files and 32/32 tests plus 17/17 runner checks;
  the authoritative suite passes 184/184 files and 2,535/2,535 tests plus the
  same runner. Build/typecheck, warning-free lint, the high-severity production
  audit with 0 vulnerabilities, and diff checks pass. Clean Chromium, CI, and
  fresh exact-head review follow on the committed fix.

## Milestone 5 Part 10a.2 / issue #109 - sixth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4927745797` on `0c60753c6a` found three P1 gaps:
  fractional conformed trim bounds could omit the containing first image or
  include the image after the last displayed one; 24 fps media in a 30 fps
  project could repeat a native image even at 1x; and a fixed fast-retime
  stride could analyze native frames 0/4/8 while rendering requested 0/3/6.
- Product analysis now walks every bounded clip timeline frame through the
  canonical render selector: floor the exact SourceTimeMap tick to its
  containing project-rate frame, then use the shared nearest project-to-native
  frame rescaling. It retains only the first timeline tick for each distinct
  native image and opens one sparse, ordered `samplesAtTimestamps` decoder lane
  for those exact native-frame timestamps. The half-open decode range starts at
  the first selected native image and ends after the last; fractional tick
  boundaries are no longer passed directly to the sequential decoder.
- Result schema 2 stores each sample's exact first displayed SourceTimeMap tick,
  and product algorithm `similarity-product-v2` invalidates older cache entries.
  Planning detects repeat runs by the logical native-frame identity and the
  nondecreasing timestamp of the sample actually returned by the decoder, so
  two adjacent render requests that resolve to one containing media sample also
  receive protected first/last keys and ordinary `hold` easing. The controller
  separately verifies every stored SourceTimeMap tick against the current exact
  schedule before accepting fresh or cached analysis. The sparse schedule is
  validated and copied at both controller and worker boundaries, accepts signed
  exact stream timestamps, and rejects before retaining sample 65,535 under the
  existing product envelope.
- Deterministic regressions pin fractional 0.5-frame starts, the exact 24-to-30
  fps native sequence, 4x retiming, 1x conformed repeats, sparse decode/protocol
  propagation, one ordered signed Mediabunny cursor, and early schedule-budget
  rejection, including the duplicate decoded-timestamp case discovered by the
  first clean headed-Chromium integration run on local commit `450da854fc`.
  After correcting that real Mediabunny behavior, the dirty-tree rerun passed
  the complete product flow with 32 analyzed samples, an exact cache hit, one
  history entry, balanced worker/cache cleanup, and zero console problems. The
  frozen focused gate passes 8/8 files with 78/78 tests plus
  17/17 evidence-runner checks. The authoritative suite passes 184/184 files
  with 2,542/2,542 tests plus the same runner; TypeScript/Vite builds 4,810
  modules, warning-free lint passes, the production audit reports 0
  vulnerabilities, and diff checks pass. A clean-tree Chromium rerun, CI, and
  fresh exact-head review follow on the amended commit.

## Milestone 5 Part 10a.2 / issue #109 - seventh exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4928170019` on `088ecb325b` found that coverage
  validation eagerly retained one seven-field transform object for every clip
  frame. A valid run at the documented 1,000,000-frame ceiling could therefore
  create substantial browser memory pressure while the Inspector called the
  planner synchronously.
- The per-frame interpolator is now a lazy single-pass iterable. One coverage
  traversal accumulates the exact reciprocal crop constraints and maximum
  pre-zoom scale together, then discards each interpolated transform before the
  next frame. The retained simplification/keyframe path remains bounded to
  1,024 entries; no duration-sized transform array exists.
- A deterministic single-use iterable regression fails if exact coverage is
  traversed twice. The frozen focused gate passes 9/9 files with 83/83 tests
  plus 17/17 runner checks; the authoritative suite passes 184/184 files with
  2,543/2,543 tests plus the same runner. TypeScript, build, warning-free lint,
  the high-severity production audit with 0 vulnerabilities, and diff checks
  pass. Clean headed Chromium, CI, and exact-head Codex evidence follow on the
  committed fix.

## Milestone 5 Part 10a.2 / issue #109 - eighth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4928304427` on `9c7a292312` found that sparse
  stabilization requests added the container's exact first presentation
  timestamp, while preview and export request the same rendered source frames
  on a zero-relative timeline. Imported video with a positive or negative first
  PTS could therefore analyze a different image than the one displayed.
- Source-tick, native-frame, sparse-decode bounds, and inverse timestamp helpers
  now share the preview/export zero-relative convention. Exact container bounds
  are checked and normalized to their duration, the connected source must match
  their first-PTS fact, and no first-PTS offset enters a decoder request.
  Product provenance advances to `similarity-product-v3` so older cache entries
  cannot satisfy the new mapping contract.
- Deterministic positive- and negative-origin fixtures pin identical rendered
  timestamps, source ticks, and half-open decode bounds. The frozen focused
  gate passes 9/9 files with 85/85 tests plus 17/17 runner checks; the
  authoritative suite passes 184/184 files with 2,545/2,545 tests plus the same
  runner. TypeScript, build, warning-free lint, the high-severity production
  audit with 0 vulnerabilities, and diff checks pass. Clean headed Chromium,
  CI, and exact-head Codex evidence follow on the committed fix.

## Milestone 5 Part 10a.2 / issue #109 - ninth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4928487561` on `81789285cc` found that the
  stabilization adapter scheduled one zero-delay timer for every analyzed
  frame pair. Nested-timer clamping could add roughly four minutes of waiting
  to a valid 65,534-sample run before accounting for decode or estimation work.
- Pair estimation still checks cancellation before every pair, but cooperative
  event-loop release is now batched after at most 16 pairs or eight
  milliseconds of synchronous work. Chromium uses `scheduler.yield()`; the
  fallback uses a non-clamped, single-use `MessageChannel` task with both ports
  closed on delivery. Only environments lacking both primitives use the timer
  fallback, and that timer is batch/deadline-driven rather than unconditional
  per retained sample.
- Deterministic regressions prove 34 pair estimates schedule only two yields and
  that a deadline-triggered yield observes cancellation before more work. The
  frozen focused gate passes 9/9 files with 87/87 tests plus 17/17 runner
  checks; the authoritative suite passes 184/184 files with 2,547/2,547 tests
  plus the same runner. TypeScript/Vite builds 4,810 modules, warning-free lint
  passes, the production audit reports 0 vulnerabilities, and diff checks
  pass. Clean Chromium, CI, and fresh exact-head review are refreshed on the
  final committed tree.

## Milestone 5 Part 10a.2 / issue #109 - tenth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY.**

- Exact-head Codex review `4928636794` on `104ee8ed4c` found that preview and
  analysis rounded a conformed project-rate source frame to the nearest native
  frame before decode, while export submitted the direct project-rate time.
  For source frame 2 in a 30 fps project with 24 fps media, preview/analysis
  requested 83,333 µs but export requested 66,667 µs and selected the earlier
  containing sample.
- Streaming preview, legacy preview, export, and stabilization now share the
  same rule: `sourceFrame` remains a conformed document-rate time at the decode
  boundary, and the decoder selects the containing native media sample. The
  native frame rate owns tolerance and deterministic containing-sample
  deduplication only; it never changes the requested source time. Stabilization
  timestamps store the first direct project-rate request displaying each
  distinct native sample. Product provenance advances to
  `similarity-product-v4` so nearest-frame cache entries cannot be reused.
- Direct parity regressions pin 66,667 µs across both preview protocols,
  export, and analysis, including fractional trims, 24-to-30 fps repeats, and
  4x retiming. The expanded frozen focused gate passes 11/11 files with
  152/152 tests plus 17/17 runner checks; the authoritative suite passes
  184/184 files with 2,548/2,548 tests plus the same runner. TypeScript/Vite
  builds 4,810 modules, warning-free lint passes, the production audit reports
  0 vulnerabilities, and diff checks pass. Clean Chromium, CI, and fresh
  exact-head review are refreshed on the final committed tree.

## Milestone 5 Part 10a.2 / issue #109 - eleventh exact-head review follow-up (2026-08-13)

**IMPLEMENTED; VALIDATION PENDING.**

- Exact-head Codex review `4928810404` on `ff68812e2c` found that the planner
  still deduplicated sparse requests with the asset's average frame rate. On
  variable-frame-rate media, project targets at 0 and 33 ms can select distinct
  samples at 0 and 25 ms even though the average-rate calculation calls both
  native frame zero, dropping real displayed motion.
- The bounded plan now submits every distinct conformed document-rate request
  and treats the sparse decoder's returned sample timestamp as the only media
  identity. Equal returned timestamps append an explicit null-motion hold;
  later distinct timestamps retain their measured motion. Repeated-run
  protection keys every conformed request to that returned identity, with no
  native-rate prediction. Result schema advances to 3 and product provenance
  to `similarity-product-v5` so prior cache entries cannot satisfy this rule.
- Deterministic VFR coverage pins requests at 0 and 33 ms resolving to samples
  at 0 and 25 ms, alongside true repeated selections, cache parsing, and
  protected hold boundaries. The final focused selector matrix passes 11/11
  files with 154/154 tests plus 17/17 evidence-runner checks; the authoritative
  suite passes 184/184 files with 2,550/2,550 tests plus the same runner.
  TypeScript/Vite builds 4,810 modules, warning-free lint passes, the production
  audit reports 0 vulnerabilities, and diff checks pass. Clean headed Chromium
  on code commit `c6005ca437` and strict port 41883 passes with 32 samples/keys,
  an exact second-run cache hit, 1.0232x safe zoom, one history entry, worker
  1/1/0, cache removal, zero console/page problems, and complete port release.
  The JSON is 2,832 bytes with SHA-256 `455712DC7B2F917FE50019E693B1DA9B52D228A8F43EE992988C1C752D5C41E9`;
  the visually inspected PNG is 381,065 bytes with SHA-256
  `5179DB3975EA83FB49D91EA134C8DBEEEE19B4CDC39EEF4BBCF14A5DF13B1957`.
  Exact-head CI and fresh Codex evidence follow after the final docs-only amend.

## Milestone 5 Part 10a.3 / issue #110 - bounded point and box tracking (2026-08-13)

**COMPLETE LOCALLY; CI/REVIEW PENDING.**

- Added an accessible Program Monitor point/box picker and Inspector workflow
  for exact-frame selection, forward/backward local analysis, cancel/retry,
  confidence/loss status, target choice, optional box scale, non-mutating
  preview, explicit replacement, one-step Apply, and disclosed Position/Scale
  reset. The ephemeral selection is pinned to its pointer-up project frame and
  rotated source boxes render as their real project-space polygon.
- The app facade builds an exact SourceTimeMap schedule, reuses #108's bounded
  cache/job/worker path, streams one previous tightly owned gray frame through
  the proven point/similarity-box estimators, and records the first loss
  without guessing through it. Sparse decode now accepts strict ascending or
  descending timestamp lanes and reports direction-aware progress.
- Cache parsing and preview/Apply revalidate the exact project/source/selection
  snapshot, directional frame/tick schedule, geometry bounds, target
  overlap/lock/dimensions, replacement, and animation budgets. Accepted motion
  maps through per-frame source crop/flip/anchor/transform to ordinary target
  Position X/Y and optional Scale X/Y tracks. Every accepted sample is retained,
  which gives zero simplification error within the 1,024-key ceiling.
- The clean-commit source-bound Chromium gate on exact code commit
  `f278aa23594cd694213385469e02782d615408b7` and strict port 41886 passed a
  160x90 encoded fixture: point mean/max error 0.333/1.000 px, box mean center
  error 0.333 px, mean/max scale error 0%, explicit point and box loss on
  occlusion frame 18 after 18 accepted samples, exact cache reuse, one history
  entry, and zero console/page problems. A real reverse sparse lane also
  accepted frames 17 through 0 at 0.333 px mean / 1.000 px max error. Worker
  lifecycle finished 3/3/0, the cache attachment was removed, console/page
  problems stayed at zero, and the port was released. The clean source
  fingerprint was
  `sha256:799c29664da65cf40b75bc543e35ecd5f8a319d9201ba0d071bbe5a4f27e9010`.
  The JSON was 3,056 bytes with SHA-256
  `E9A4242F8AD80CB5F2FD72EA3D1F53F855838841A0B94F2D1DC5C77142EAD516`;
  the visually inspected PNG was 362,294 bytes with SHA-256
  `364F32294130A88BDBB1440CD77946B72E2184AA950F9BFF6CA15A59469CF02A`.
- The frozen focused matrix passes 12/12 files with 120/120 tests. The
  authoritative suite passes 190/190 files with 2,575/2,575 tests plus all
  17 evidence-runner checks. TypeScript/Vite builds 4,816 modules, lint is
  warning-free, the production audit reports 0 vulnerabilities, and diff/
  architecture checks pass. The normal 39-file / 7,710,072-byte build contains
  the production tracking product but zero Issue #110 gate/fixture or WebGPU
  experiment canaries. Exact-head CI and fresh Codex review are the remaining
  publication gates.

## Milestone 5 Part 10a.3 / issue #110 - first exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY; CLEAN-COMMIT BROWSER/CI/REVIEW REFRESH PENDING.**

- Codex review `4929530527` on exact head `4dbc2ced440084ab2a5e56f8de9ec9559e04e87b`
  found three P2 gaps: the inactive tracking editor could clear stabilization's
  shared visual preview; an older point/box status could mask current progress;
  and preserved target Rotation was resolved only at the selection frame.
- `clipVisualPreview` now carries a named stabilization or motion-tracking owner,
  and each mounted editor clears only its own preview. Tracking progress filters
  by the requested kind and chooses the newest queued/running job before any
  retained terminal status.
- Every accepted product sample now carries the target transform resolved at
  that exact frame. Preserved Rotation drives target-local box extents and
  cropped/anchor compensation; preserved Scale also drives compensation when
  tracking does not author Scale. A deterministic 0-to-90-degree target
  regression proves both off-center Position correction and cross-axis box
  scaling.
- The refreshed focused matrix passes 14/14 files with 135/135 tests. The
  authoritative suite passes 190/190 files with 2,578/2,578 tests plus all
  17 evidence-runner checks. TypeScript/Vite builds 4,816 modules, lint is
  warning-free, the production audit reports 0 vulnerabilities, and diff
  checks pass. Refresh clean Chromium, CI, and Codex review on the committed
  follow-up head before merging.

## Milestone 5 Part 10a.3 / issue #110 - second exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY; CLEAN-COMMIT BROWSER/CI/REVIEW PENDING.**

- Exact-head Codex review `4929629665` on
  `85bdb090fa840a5784ee815e1c46508465639dee` found two P2 workflow gaps:
  tracking Cancel used whole-clip cancellation and could abort simultaneous
  stabilization; the target picker also offered the tracked source itself,
  which would apply its motion back onto the same clip as a doubled transform.
- The shared controller now exposes kind-scoped clip cancellation. Tracking
  cancels point and box kinds separately, stabilization cancels only its own
  kind, and attachment removal retains whole-clip cancellation. A one-slot
  scheduler regression keeps stabilization alive while cancelling queued point
  tracking on the same clip, then proves the survivor completes and drains.
- The Inspector excludes the source from target choices and selects a separate
  overlapping visual clip. The domain planner independently rejects equal
  source/target IDs before mapping, so non-UI callers cannot bypass the rule.
- The directly affected six-file matrix passes 53/53 tests. The authoritative
  suite passes 190/190 files with 2,581/2,581 tests plus all 17 evidence-runner
  checks. TypeScript/Vite builds 4,816 modules, lint is warning-free, the
  production audit reports 0 vulnerabilities, and diff checks pass. The first
  focused attempt exposed only a test accessibility-name mismatch, and the
  first build exposed only a readonly test-fixture assignment; both were fixed
  before the final green runs. Refresh clean Chromium, CI, and exact-head Codex
  review on the committed tree before merging.

## Milestone 5 Part 10a.3 / issue #110 - third exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY; PUBLICATION REFRESH PENDING.**

- Exact-head Codex review `4929757156` on
  `36994b0ad4008ef2daebb7c93354b1d12d36771d` found that cached tracking
  width/height could be internally valid but unrelated to the connected source,
  causing product mapping to normalize through the wrong dimensions.
- Tracking session admission now derives the expected bounded grayscale size
  with the shared decode sizing authority and requires an exact result match.
  Cache mismatch fails `storage-corrupt`; a fresh decode mismatch fails
  `decode-readback`, both before returning a session or planning keyframes.
- A direct regression pins exact 1920x1080-to-320x180 bounding, single-axis
  mismatches, and an unscaled 160x90 source. The focused controller/domain
  matrix passes 35/35 tests; the authoritative suite passes 190/190 files with
  2,582/2,582 tests plus all 17 runner checks. The 4,817-module build/typecheck,
  warning-free lint, production audit at 0 vulnerabilities, and diff checks
  pass. Clean Chromium, CI, and exact-head review remain before merge.

## Milestone 5 Part 10a.3 / issue #110 - fourth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY; PUBLICATION REFRESH PENDING.**

- Exact-head Codex review `4929832141` on
  `9e853ca448a4c8b6d1237338196598735b4f11f0` found that preview checked the
  target clip span but not the accepted tracking range. Ordinary endpoint hold
  could therefore display draft motion before analysis began or after loss.
- Preview now clears unless the playhead is inside both the target clip and the
  inclusive first-to-last tracking-key range. A UI regression proves no preview
  before the first key, preview on both accepted boundaries, and cleanup after
  the final key. Its focused file passes 6/6 tests; the authoritative suite
  passes 190/190 files with 2,583/2,583 tests plus all 17 runner checks. The
  4,817-module build/typecheck, warning-free lint, production audit at 0
  vulnerabilities, and diff checks pass. Publication refresh follows.

## Milestone 5 Part 10a.3 / issue #110 - fifth exact-head review follow-up (2026-08-13)

**COMPLETE LOCALLY; PUBLICATION REFRESH PENDING.**

- Exact-head Codex review `4929918750` on
  `9fb68ca448a4c8b6d1237338196598735b4f11f0` found that releasing the visible
  tracking preview left a still-enabled stabilization preview hidden because
  the sibling effect had no dependency change that would republish it.
- The transport store now arbitrates named stabilization, motion-tracking, and
  direct-manipulation candidates. The newest activation is visible; updating a
  hidden owner preserves its priority, and releasing the visible owner restores
  the newest remaining candidate immediately. Project reset clears the entire
  registry. Editor playhead updates no longer withdraw and reactivate their
  candidate between renders.
- Store and UI regressions prove hidden updates do not steal priority, tracking
  disable restores stabilization, direct manipulation restores the editor it
  covered, final release clears the slot, and transport reset cannot resurrect
  a candidate. The focused transport/stabilization/tracking/overlay matrix
  passes 43/43 tests. The authoritative suite passes 190/190 files with
  2,586/2,586 tests plus all 17 evidence-runner checks. TypeScript/Vite builds
  4,817 modules, lint is warning-free, the production audit reports 0
  vulnerabilities, and diff checks pass. Refresh clean Chromium, CI, and
  exact-head review before merge.

## Milestone 5 Part 10a.4 / issue #111 - manual lens-remap backend proof

**IMPLEMENTED LOCALLY; CLEAN-COMMIT EVIDENCE/CI/REVIEW PENDING (2026-08-13).**

- `domain/lensCorrection.ts` remains browser-free and owns the version-1
  normalized Brown-Conrady model plus fixed 33x33/Jacobian safety gate. A
  validated immutable mapper now lets a bounded frame loop pay that model gate
  once without weakening per-point bounds.
- `dev/issue111/` owns the complete build-unreferenced experiment: deterministic
  RGBA fixtures and CPU oracle, one RGBA8 WebGL2/manual-bilinear candidate,
  transform-feedback geometry audit, serializable evidence, disposable worker,
  cancellation owner, and main-thread timeout/error/messageerror cleanup.
- The frozen source order is decoded oriented source -> manual lens remap ->
  authored crop -> clip transform -> mask/chroma -> ordered effects ->
  opacity/blend -> transition. Both candidate preview and export use the same
  program; export adds only the request-scoped RGBA8 readback.
- The headed dirty-tree shakedown on the AMD Radeon RX 6600 returned `go` with
  seven fixtures, maximum pixel delta 1 byte/channel, maximum geometry delta
  0.000035 source pixels, and 1080p preview/export p95 10.4/13.6 ms. At 4K,
  preview/export p95 was 33.4/55.7 ms and the full seven-surface envelope was
  232,243,200 bytes. Exact clean-head artifact identity replaces this
  preliminary provenance before publication.
- Context loss fails the current owner; a fresh worker/context re-probes and
  succeeds. CPU work cancels with `AbortError`; three workers terminate with
  zero active. Unsupported
  WebGL2/RGBA8/readback/texture/memory facts are explicit unavailability and
  never silently substitute the CPU oracle.
- No production entry imports the gate. There is no editor control, document
  field, schema migration, profile catalog, profile download, auto-calibration,
  cloud service, or AI path. A separate implementation issue may be opened only
  after exact-head #111 acceptance.
- Frozen focused validation passes 4 files / 20 tests plus all 17 runner
  checks. The authoritative suite passes 192/192 files with 2,598/2,598 tests
  plus 17/17 runner checks. TypeScript/Vite builds 4,817 modules with only the
  established large-chunk advisory; lint is clean, the production audit reports
  0 vulnerabilities, diff checks pass, and normal production output contains
  zero Issue #111 canary files. Clean committed headed evidence, CI, and
  exact-head Codex review remain.

## Milestone 5 Part 10a.4 / issue #111 - first exact-head review follow-up

**VALIDATED LOCALLY; CLEAN-HEAD PUBLICATION PENDING (2026-08-13).**

- Exact-head Codex review `4930390362` on `072836a4b360f4333ae40b13788965822b4c182e`
  found that context-loss retry used a fresh context in the same worker instead
  of a fresh worker, and that row flipping temporarily retained a second full
  readback frame outside the published memory budget.
- The full proof worker now terminates after context loss. A separately owned
  recovery worker starts from scratch, re-probes context-loss observation and
  texture limits, renders one exact neutral RGBA8 frame, disposes, and terminates
  before the cancellation worker starts. Lifecycle evidence is 3/3/0.
- Readback now swaps top/bottom pixels in its original tightly owned buffer via
  a same-buffer 32-bit view. There is no second frame-sized allocation, so the
  seven-surface 4K peak remains exactly 232,243,200 bytes.
- Focused 4-file validation remains 20/20 plus 17/17 runner checks. The
  authoritative full suite passes 192/192 files and 2,598/2,598 tests plus the
  same 17/17 runner checks; the 4,817-module build/typecheck, lint, production
  audit (zero vulnerabilities), diff checks, and production-isolation canaries
  are green. Clean committed headed evidence, CI, and exact-head review remain.

## Milestone 5 Part 10a.5 / issue #119 - bounded manual lens correction

**IMPLEMENTED AND VALIDATED LOCALLY; PUBLICATION GATES PENDING (2026-08-15).**

- Timeline schema 14 adds nullable, versioned `Clip.lensCorrection`. Schema-13
  migration installs `null`; current version-1 values are bounded and
  foldover-validated, while bounded future intent round-trips opaquely and is
  refused instead of being substituted. Audio and procedural text cannot own
  correction intent.
- The Crop Inspector exposes principal point X/Y, focal X/Y, `k1`/`k2`/`k3`,
  `p1`/`p2`, strength, and explicit output scale. Enable, reset, keyboard-ready
  number inputs, undo/redo, locked-track behavior, validation feedback, runtime
  capability, and transparent-edge/coverage facts all use ordinary document
  history with one entry per committed gesture.
- `webgl2-rgba8-manual-bilinear-v1` is now the one production source-space
  backend shared by preview and export through `compositeFrame`. Ordering is
  decoded/orientation-normalized source -> lens -> crop -> transform ->
  masks/chroma -> effects -> opacity/blend -> transitions. There is no CPU
  product fallback.
- Preview owns one backend per render worker; context loss is terminal for that
  owner and a fresh worker re-probes. Export owns a separate finite backend and
  readback. WebGL2/context/texture/readback/budget failures are explicit, and
  success/cancel/failure release GPU objects plus retained canvases
  idempotently.
- The browser-free budget proves four compositor surfaces + two reusable lens
  surfaces + one export readback at 4K = 232,243,200 bytes, below 256 MiB.
  Source and output dimensions are admitted independently.
- Motion tracking fails closed for any source clip that owns manual or
  preserved-future lens intent. The picker/marker overlay is suppressed and
  analysis rejects until an accepted inverse lens projection can map corrected
  Program Monitor geometry back into the decoded source.
- Final local automation passes 193/193 files with 2,613/2,613 tests plus all
  17 evidence-runner checks. TypeScript/Vite builds 4,821 modules with only the
  established chunk advisory; lint is warning-free.
- In-app Browser QA on strict port 41889 used a generated 320x180 AVC fixture
  in a 1920x1080 project. The live worker reported the accepted backend and a
  16,384px texture limit; `k1=0.1` disclosed 10.00% overscan, output scale 1.20
  reported full coverage, undo/redo/reset were exact, and a corrected
  Compatibility MP4 reached Export ready. Page identity/DOM/overlay checks and
  console health were clean with zero warnings/errors.
- Push, CI, current-head Codex review, PR delivery, merge, and issue closeout
  remain outside this local implementation turn.

## Part 10c issue #77 / PR #123 - merge-readiness remediation

**REMEDIATION COMPLETE AND VALIDATED LOCALLY; EXACT-HEAD PUBLICATION PENDING
(2026-08-16).**

- Production preview now binds the app-owned plugin bridge for the lifetime of
  `EditorShell`; export keeps a separate prepared owner and fails closed on a
  bypass or unavailable ordered-pixel surface. Export admission rejects an
  excessive frame schedule before Blob retention, media planning, decoder/sink
  acquisition, or per-frame plugin-plan allocation.
- Runtime authorization checks the current IndexedDB catalog generation both
  before and after every render, zeros stale output, and invalidates the owner.
  Malformed and late bridge/broker messages settle only an exact valid routing
  identity and zero any transferred pixel or migration buffers. Audio clips can
  no longer accept video-plugin parameter edits.
- Teardown retains observable ownership until the host-authored iframe broker
  acknowledges `worker.terminate()`; a 250 ms parent fallback remains bounded.
  Project replacement and cancellation drain late broker and activation
  settlements before publishing all-zero terminal evidence. The actual private
  channel accounting is four endpoints per live broker.
- The app startup path now loads the plugin recovery root before exposing the
  project launcher. A production activation sentinel wraps actual sandbox
  activation. Descriptor migration is wired to the real document CAS boundary,
  rechecks project and catalog state after resource closure, commits once, and
  has a visible pending/error recovery action in the Inspector.
- Plugin Manager focus now lands on a visible actionable control after async
  refresh; missing descriptors remain visible with bounded fallback identity;
  Export uses an inline block body instead of nesting dialogs and acquires a
  fresh project-scoped export owner. Plugin UI text is at least 12 px, and the
  safe-mode ellipsis corruption is removed.
- Independently built duplicate/path/case-fold/symlink/checksum/trailing-byte
  archives now cross the production package verifier. The repository sample is
  mandatory rather than conditionally skipped, and production parser rejection
  can no longer be treated as success. Its unchanged release verifies as archive
  SHA-256 `a809c6f086213064a90b63f1ca1e42c5e5215aa3cd874c706e15fe5edcded42e`,
  package digest `sha256:ca3eaaba5a8a87ea88e313fd9f26dd1ebb9aefc217ea76ef219a35ca931f8b15`,
  and signer fingerprint `sha256:c955bcdaff60dc0593be20942f5f153ee4427765694b5e69a1e9a6caa5764139`.
- The authoritative local gate passes 225/225 files with 3,055/3,055 Vitest
  tests plus all 17 evidence-runner checks. TypeScript/Vite builds 4,872 modules
  with the established large-chunk advisory; lint is clean and the production
  audit reports zero vulnerabilities. Real Chromium installs/uninstalls through
  production UI, produces exact preview pixels `245,235,225,255` and separate
  export pixels `254,253,252,255`, blocks interrupted-startup launcher access,
  recovers through safe mode, and returns every runtime/broker counter to zero.
  The same browser gate proves opaque origin plus blocked network, storage, DOM,
  opener, dynamic-script, nested-worker, beacon, and WebRTC capabilities. It
  also changes the authoritative IndexedDB generation behind a warmed controller
  and proves the next pixel call is rejected before sandbox execution.
- Commit/push, exact clean-head Chromium evidence, CI, and current-head review
  remain publication gates. Merge and issue closeout are not authorized here.

## Milestone 6 Part 12 / issue #78 - editor-structure research gate

**COMPLETE LOCALLY (2026-08-17); CHILD ISSUE PUBLICATION NOT AUTHORIZED.**

- `docs/EDITOR_STRUCTURE_RESEARCH.md` is the decision record for adjustment
  layers, a project-level same-settings sequence graph, bounded live nested
  sequences, and manual-sync multicam. The recommended order is 12a adjustment
  layers, 12b sequence foundation, 12c compound/nested sequences, then 12d
  manual multicam.
- `src/domain/editorStructureResearch.ts` is a pure, build-unreferenced
  feasibility contract only. It proves post-composite adjustment order,
  complete-project cycle/reference/depth validation, exact 1:1 nested frame
  mapping, independent multicam video/audio selection, logarithmic range/cut
  lookup, and full-frame surface accounting. No production entry may import it.
- The first product slices explicitly exclude mixed-rate/dimension nesting,
  automatic waveform/timecode sync, and simultaneous live angle playback. A
  child must own each schema/UI/runtime change and replace the relevant
  research prototype with production contracts.
- The focused gate passes 19 tests. The source-bound fixture covers 128 tracks
  x 1,024 items, 256 sequences/255 references, and eight angles/24,000
  switches/250,000 lookups. Seven and eight 4K RGBA8 surfaces fit the 256 MiB
  limit at 232,243,200 and 265,420,800 bytes; nine fail at 298,598,400 bytes.
  Adjustment integration therefore gets at most one additional simultaneous
  surface and must prove lens/transition/plugin/export coexistence.
- The authoritative tree passes 226/226 Vitest files and 3,074/3,074 tests plus
  all 17 runner checks, the 4,872-module build/typecheck, source lint with the
  user-owned untracked `.worktrees/` directory excluded, a zero-vulnerability
  production audit, clean diff checks, and a normal-dist isolation search.
- No product schema, project format, UI, browser runtime, or remote GitHub item
  changes in #78 itself. Chromium is not applicable to this build-unreferenced
  pure gate; every observable child requires source-bound browser evidence.

## Post-MVP issue #179 - marquee selection and grouped movement

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-24); PUBLICATION NOT AUTHORIZED.**

- With the Select tool active, a primary left-button drag that starts on empty
  timeline lane space draws a translucent blue marquee. Intersecting clips on
  visible, unlocked lanes highlight live; release commits their ordered
  transport-only selection. Pointer capture plus a window release fallback
  keeps cross-lane and sticky-gutter gestures from getting stranded.
- Dragging any selected member snapshots the complete selected/link-expanded
  closure. Every participant previews the same signed horizontal delta and
  commits through one immutable `moveClips` domain/store operation. Bounds,
  locked lanes, collisions, stale ids, and transitions validate as a unit; any
  rejection preserves the original document reference and history.
- Multi-clip moves deliberately stay on their existing lanes. The established
  single-clip drag path remains the only cross-track move contract. Ctrl/Cmd +
  Arrow applies the same grouped one-frame move, and one Undo/Redo restores the
  entire group.
- Desktop Chromium at 1280x720 selected two text clips across V2/V1 with a
  reverse cross-gutter drag, moved both by +40 frames, and restored/reapplied
  both positions with one Undo/Redo; no console warnings or errors appeared.
- The authoritative automated gate passes all 236 Vitest files / 3,364 tests
  plus all 17 repository runner checks, production build/typecheck, lint,
  production dependency audit, and diff hygiene.

## Post-MVP issue #180 - Compatibility and HEVC export flush error

**ROOT CAUSE FIXED LOCALLY; NATIVE CHROME REGRESSION LOCKED (2026-08-24).**

- #178 fixed one real AAC failure: 96 kHz document audio now remains on the
  document grid for mixing and crosses the native encoder boundary at 48 kHz.
  The reporter's normal-Chrome retest proved that fix was necessary but not
  sufficient. Their source timecodes also exposed the load-bearing difference:
  the failing project is 59.94/60 fps, while the earlier passing reproduction
  was 30 fps.
- Installed Chrome 151 deterministically passed the exact fresh MP4/AAC probe
  at 30 fps and failed at both 59.94 and 60 fps with `Flushing error`, at both
  64x48 and 1920x1080. The smallest failure is one 60 fps frame; source media,
  canvas size, project sample rate, extensions, and the user's Chrome profile
  are not required.
- The mixer intentionally advances in document-frame order. At 48 kHz this
  produced 800/801-sample chunks at 59.94/60 fps. Direct native WebCodecs
  probing showed Chrome's AAC adapter accepts its startup only after 2,048
  contiguous samples, then accepts 1,024-sample blocks and a trailing partial;
  otherwise `AudioEncoder.flush()` fails after support/configuration succeeded.
- `pipeline/export-aac-input.ts` now owns one bounded two-channel maximum
  2,048-sample startup assembler shared by the fresh preflight and the real
  export sink. It preserves every scheduled sample and timestamp, coalesces
  later input into 1,024-sample blocks, and zero-pads only a stream too short to
  start the native encoder. Existing AAC packet-duration trimming preserves the
  exact presentation end. No container, video codec, audio codec, profile, or
  local fallback is substituted.
- The checked-in browser regression generates a WAV entirely in memory and
  exercises fresh preflight plus the real WAV decode → 60 fps mix → AAC encode
  → MP4 mux path. It passes in repository Chromium and installed Chrome 151.
  Focused adapter/ownership tests cover 60 fps coalescing, short-stream padding,
  backpressure, cancellation, exact sample totals, and 96→48 kHz conversion.
- The current tree passes all 237 Vitest files / 3,370 tests, all 17 repository
  runner checks, all 12 repository Chromium tests, production build/typecheck,
  and clean lint.

## Post-MVP issue #186 - Source Monitor slice 6

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-25); PUBLICATION AND ISSUE CLOSEOUT NOT AUTHORIZED.**

- Slice 6 is the last Source Monitor review slice. Home/End jump the source
  playhead without stealing Media Pool first/last-row navigation. Offline,
  Limited, Unsupported, and runtime-failure copy is the same Media Pool text
  (`mediaCompatibilityStatusText` / `mediaCompatibilityRemediationLines`).
  A compatibility-only unsupported file rejects as incompatible, not offline.
  Rejection copy stays on the attempted file when another source is already
  open. Three-point insert/overwrite now live on Issue #187 rather than a
  later-work note.
- Asset switch, failed open, close, and project replace halt the source clock
  and release the previous visual loan. Program playhead and `TimelineDoc` stay
  put.
- Exclusive Chromium on `http://127.0.0.1:42186/` opened an in-page 60-frame
  AVC `slice6.mp4` and painted live frames; Start/End, marks, JKL, WAV
  audition, PNG still, Close, and Program at `00:00:00:00` all held. Home on
  the focused Media Pool list selected the first row and left the source
  playhead at the last frame. `broken.mp4` showed `Compatibility: Unsupported`
  plus `"broken.mp4" is not a supported media container.` Removing the open
  MP4 showed `Offline · relink needed` and cleared the canvas. Layout kept
  Program and Source side by side. Limited/partial was covered by tests only.
- The authoritative automated gate passes 244 Vitest files / 3,432 tests plus
  the 17 runner checks, production build/typecheck, lint, and diff hygiene.
  Do not tick GitHub #186 unless asked after a user pass.

## Post-MVP issue #187 - three-point sequence edits slice 2

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-26); PUBLICATION AND ISSUE CLOSEOUT NOT AUTHORIZED.**

- Slice 1's planner/apply/commands remain. Slice 2 adds real
  `SourceBoundsCatalog` handles for roll, keeps existing seam crossfades
  preview/export-valid, and regroups leftover linked A/V after lift/extract
  instead of failing the whole edit. Timeline In/Out draw on the ruler.
  Lift, Extract, and Replace sit on the transport bar; Replace also sits on
  the Source Monitor; clip/ruler context menus expose replace, roll, lift,
  and extract with the same disabled reasons as the commands.
- Roll of timed media without exact catalog bounds, unknown bounds, or
  remaining handle is `insufficient-source-handle`. A roll that would drop
  or starve a valid crossfade is `roll-transition-invalid`. Stills and text
  may still grow. Four-point duration mismatches still never retime.
- Focused Vitest, oxlint, and `tsc -b` plus production Vite build passed.
  In-app Chromium on `http://localhost:42187/` imported a 2.000s 320×180
  AVC/AAC file, opened Source Monitor, inserted a linked A/V pair, marked
  Program In/Out, lifted and extracted, split and rolled the seam, overwrote
  and replaced, played back, and undid/redid with an empty console.
- Do not tick GitHub #187 unless asked after a user pass.

## Post-MVP issue #190 - bounded adjustment layers

**MERGED (2026-08-30) THROUGH PR #214 AS `024ea9b`; ISSUE #190 CLOSED.**

- Timeline schema 15 adds video-track `AdjustmentItem` records with stable
  identity, name, range, enabled state, opacity, ordered effects, and bounded
  opacity/effect animation. They have no media/source/audio/proxy/cache/relink
  identity. The 14→15 migration installs empty arrays; portable save, recovery,
  validation, duration, selection reconciliation, and hostile-budget checks all
  include the new item type.
- `domain/adjustmentItems.ts` owns insert, move, trim, split, duplicate, delete,
  enable, rename, opacity, animation, and effect edits. Every accepted store
  call is one ordinary history entry; pointer move/trim previews remain
  ephemeral until release. Timeline keyboard and Inspector controls expose the
  same contracts with lock, range, overlap, and accessibility guards.
- The shared planner emits completed lower tracks, then the adjustment at its
  video-track position, then upper tracks; captions remain topmost. The shared
  preview/export compositor borrows the existing transition leg, applies the
  post-composite color stack, and blends the resolved opacity once. Pixel
  regressions cover lower/adjustment/upper ordering, opacity, unknown bypass,
  transition groups, and zero source requests.
- Only effects explicitly registered for the post-composite surface may be
  authored. Masks, chroma keys, lens/source geometry, and current plugin
  contributions are rejected. Bounded unknown/future descriptors round-trip
  unchanged and appear as bypassed/unavailable in the Inspector rather than
  disappearing.
- Adjustment evaluation adds zero compositor surfaces. The ordinary four-
  surface 4K compositor remains 132,710,400 bytes and the lens/export seven-
  surface peak remains 232,243,200 bytes, below the shared 256 MiB ceiling.
- In Chromium on strict port 42190, a no-media project created `Browser grade`
  on V2, added a ready color adjustment at exposure 1.25, set 65% opacity,
  created opacity/effect keys at frames 0 and 1, and proved one-step Undo/Redo.
  The complete Inspector/timeline remained operable at 1024×768 and 720×800;
  the console reported zero warnings and errors.
- The authoritative gate passes all 250 Vitest files / 3,584 tests plus all 17
  repository runner checks, production build/typecheck (4,930 modules), clean
  lint, and diff hygiene.
- Exact-head CI/review passed before merge; the user authorized skipping the
  final user pass and closing GitHub #190.

## Post-MVP issue #191 - multiple sequences per project

**IMPLEMENTATION COMPLETE LOCALLY (2026-09-03); PUBLICATION AND MERGE AUTHORIZED.**

- Project format 6 replaces the single outer `document` with one bounded,
  deterministic collection of stable `TimelineDoc` sequence definitions plus
  one portable root id. Format-5 files migrate by preserving their existing
  document byte-behaviorally as the sole root. All sequences must share exact
  rational FPS, dimensions, and audio sample rate; nesting and multicam remain
  out of scope.
- `documentStore` owns the complete project, session-only active sequence, and
  one project-wide bounded undo/redo history. New, duplicate, rename, delete,
  root selection, and navigation are exposed in the editor. The root is
  protected; deleting the active non-root returns to the root; navigation is
  neither persistent nor dirty.
- Validation examines every active or dormant sequence, globally unique ids,
  the root, and aggregate bounds before replacing stores or browser resources.
  Media descriptors, collections, connected sources, recovery, save/live-save,
  relink, and dirty tracking remain project-wide rather than duplicated per
  sequence. Selection and transport reconcile on navigation.
- Export deliberately targets the active sequence and identifies that target
  in the dialog, including whether it is the project root. Opening or recovering
  a project begins at the root.
- The user authorized publication and merge on 2026-09-03, contingent on a
  rebased exact-head validation pass and completed Bugbot review.

## Post-MVP issue #192 - bounded live compound and nested sequences

**IMPLEMENTATION AND LOCAL ACCEPTANCE COMPLETE (2026-09-03); PUBLICATION NOT AUTHORIZED.**

- Timeline schema 19 adds resource-free sequence instances to video/audio
  tracks. One complete-project validator checks active and dormant definitions,
  exact settings, references, source/timeline ranges, global ids and link
  groups, cycles, depth 8, aggregate counts, and a conservative 4,096-leaf
  visual/audio expansion ceiling before stores or resources change.
- Creating a compound moves selected clips into one central child definition
  and replaces them with linked parent instances as one project-history edit.
  Open/back preserves exact parent and child frames. Move, trim, split,
  duplicate, and delete reuse one atomic domain seam; Make independent clones
  the selected reachable subgraph and remints every sequence, track, item,
  effect, transition, marker, caption, and link identity.
- Preview, playback, captions, adjustments, transitions, effects, plugins,
  proxies, and export resolve the same exact child frames through immutable
  leaf plans. Repeated instances receive distinct request keys. Uncovered child
  video is explicit black and uncovered audio contributes no leaf. Browser
  loans remain owned by the established render/decode/audio/export owners;
  graph and plan data contain no browser objects.
- Persistence, recovery, relink, plugin generation, media reachability, lens
  provider lookup, dirty tracking, and export targeting operate across the
  reachable sequence graph. Navigating to a child cancels the prior playback
  owner so dormant sequence audio cannot continue.
- Headed Chromium on strict port 41892 created and duplicated a live text
  compound, proved a shared edit, reminted only the selected copy, and rendered
  `UPDATED SHARED CHILD` at frame 0 versus `INDEPENDENT CHILD` at frame 200.
  Browser-side probes proved frozen distinct instance paths, explicit black and
  silent gaps, atomic depth-9 rejection with unchanged state, deterministic
  three-sequence serialization, and crash-style IndexedDB recovery. A separate
  real PNG import -> compound -> offline -> one-time relink restored the same
  asset identity and painted the nested frame. Both sessions had zero console
  warnings or errors.
- The authoritative gate passes 268 Vitest files / 3,758 tests plus all 17
  repository runner checks, production build/typecheck (4,955 modules), clean
  oxlint, production dependency audit, diff hygiene, and all 15 repository
  Chromium tests. Vite retains only the established non-fatal large-chunk
  notice.

## Post-MVP issue #193 - bounded manual-sync multicam

**MERGED (2026-09-04) VIA PR #220; ISSUE CLOSED AS COMPLETED.**

- Project format 7 and timeline schema 20 add project-owned multicam
  definitions plus resource-free linked video/audio timeline instances. Strict
  admission bounds definitions, two-to-eight unique video angles, coverage,
  ordered switches, fixed/follow-video audio, aggregate counts, references,
  global ids, and linked geometry. Format 6 / schema 19 migrate with empty
  collections without changing existing output.
- Manual clap/event sync stores integer input frames and derives exact local
  coverage. One binary-search planner selects the active video and audio angle;
  uncovered video is black and uncovered audio is silence. Nested preview,
  playback, and export consume the same immutable project video/audio plans.
- Creation, cut, roll, rename/offset, audio policy, move, trim, split, and
  duplicate are exposed as atomic project-history operations with track-lock,
  collision, stale-reference, and replacement guards. The Inspector exposes
  connected/offline angle cards, paused Source Monitor previews, Alt+1..8 cuts,
  and accessible linked timeline items without covering the Program Monitor.
- Headed Chromium on strict port 42193 imported eight 2-second synthetic
  WebM/Opus angles, aligned frames 0..7, rendered the intentional opening black
  gap, then matched red/green/purple mouse and keyboard switches in Program.
  It exercised fixed and follow-video audio, normal playback, paused angle
  preview, cancellation with no file, crash-style recovery, eight explicit
  offline sources, one-folder 8/8 relink, portable save validation/reopen, and
  a real MP4 export. The export contained exactly 67 H.264 frames plus 48 kHz
  stereo AAC; sampled frames 3/8/12/25 matched black/red/green/purple preview.
  A final clean reopen also exercised the roll shortcut and linked-lane lock
  guard with eight offline sources; Chromium reported zero console warnings or
  errors and all temporary owners were closed.
- The authoritative gate passes all 274 Vitest files / 3,799 tests plus all 17
  repository runner checks, production build/typecheck (4,961 modules), clean
  oxlint, a zero-vulnerability production audit, and diff hygiene. Vite retains
  only the established non-fatal large-chunk notice.
- Cursor Bugbot's first pass on `a3a8911` found one valid optional-property
  cleanup and one false-positive duplicate-collision suggestion. Autofix
  `4d7c3b1` landed only the valid change; `1a8d766` added the counterexample
  regression and both threads were resolved. Fresh CI and Bugbot passed that
  exact head before normal merge `9e7ea59`; its tree matches the reviewed head,
  Issue #193 closed as completed, and master CI run `33917746503` passed.
