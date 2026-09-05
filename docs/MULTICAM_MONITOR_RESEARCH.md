# Issue #195: simultaneous multicam monitoring research

Research completed locally on 2026-09-05. The user explicitly approved the
bounded proxy-first plan and authorized implementation on 2026-09-05.
The bounded implementation and its separate product acceptance record are in
[implementation validation](evidence/issue195/implementation-validation.md).
The measurements below describe the research commit, not new product runs.

## Decision submitted for review

**Recommend a conditional GO to a bounded, proxy-first implementation plan;
NO-GO to enabling an unrestricted live angle wall. User approved this direction on 2026-09-05.**
The research demonstrates a viable finite native-decoder owner on one machine.
It does not approve shipping this laboratory or bypassing the implementation
acceptance gates below. The resulting implementation is opt-in and preserves
manual multicam and on-demand previews whenever admission or runtime health fails.

The proposed first implementation supports a 320×180, 10 fps view of inactive
angles, preferentially from provenance-fresh 720p AVC proxies. Program represents
the active angle, so eight total angles means seven extra decoder lanes. This
is useful simultaneous monitoring, but does not establish eight full-rate,
full-resolution camera streams. Original-media export remains mandatory.

## Measured support envelope

The final foreground experiment ran on 2026-09-05, 17:39–17:46 UTC, using
Chromium 151.0.7922.34, Mediabunny 1.50.9 and Playwright 1.62.1 on arm64 macOS,
Darwin 25.5.0, an Apple M5 Max with 18 logical CPUs and 64 GiB RAM. The renderer
reported ANGLE Metal / Apple M5 Max / driver 26.5.1. The viewport was 1600×1000,
headed and cross-origin isolated. The browser reported charging at level 1;
this is an API observation, not a measurement of power or thermal conditions.
The workstation was not reserved against unrelated user activity.

Each entry below has two five-second measured repetitions after one second of
warm-up. The source clips are eight seconds long. `Pass` means both repetitions
passed the preregistered thresholds on this configuration; it is not a browser-
wide support declaration. Displayed frame rate comes from changing Program
canvas pixels sampled through a 16×9 requestAnimationFrame readback, with the
same overhead in baseline and wall runs. It is not a physical display/VSYNC
measurement. Completion latency is recorded separately.

| Source and representation | 2 total angles | 4 total angles | 8 total angles |
|---|---|---|---|
| AVC 1920×1080 original | Pass | Pass | Denied by reservation |
| AVC 1080 → fresh AVC 1280×720 proxy | Pass | Pass | Pass |
| VP9 1920×1080 original | No-go: unhealthy Program baseline | No-go: baseline and tile cadence | Denied; baseline also unhealthy |
| VP9 1080 → fresh AVC 1280×720 proxy | Pass, marginal baseline | Pass, marginal baseline | Pass, marginal baseline |
| AVC 3840×2160 original | Pass, little accounted headroom | Denied by reservation | Denied by reservation |
| AVC 2160 → fresh AVC 1280×720 proxy | Pass | Pass | Pass |
| HEVC, AV1, ProRes; other browsers/devices | Unproven | Unproven | Unproven |

The HEVC encoder configuration probe returned supported, but no HEVC concurrent-
decoder workload was measured. That probe confers no monitoring support.

Representative worst observations across the paired repetitions:

| Configuration | Program changing frames/s | Slowest tile frames/s | Tile p95 latency, ms |
|---|---:|---:|---:|
| 4-angle AVC 1080 originals | 29.99–30.00 | 9.80 | 70.04 |
| 8-angle AVC 1080 proxies | 29.99–30.00 | 10.00 | 79.47 |
| 8-angle VP9-derived proxies | 27.39–27.40 | 10.00 | 73.22 |
| 2-angle AVC 2160 originals | 29.99–30.00 | 10.00 | 89.75 |
| 8-angle AVC 2160 proxies | 28.59–30.00 | 9.60 | 75.61 |

There are 52 timed rows: 12 baselines, 36 normal wall attempts and four 5 fps
fallback attempts. Of the 36 normal attempts, 24 passed, eight were denied
before opening a worker/decoder, and four VP9-original attempts failed. Their
four fallback attempts also failed because the no-wall Program baseline was
only 19.80–20.00 fps. Lower tile cadence cannot repair that baseline. Proxy
baselines for the same VP9-origin fixtures improved to 27.19–27.59 fps, narrowly
above the chosen 27 fps floor; do not describe these as full 30 fps playback.

All 32 admitted normal/fallback attempts reached observed terminal zero for the
research worker's native decoders, frames, Inputs, lanes, scratch surfaces and
main-thread worker/bitmap/canvas owners; none needed forced termination. The
slowest normal measurement cleanup was 4.70 ms. Admitted measured intervals
recorded no long tasks, and the full foreground run had no page-console errors.
Audio evidence checks the existing master-clock progression, a nonzero output
RMS observation and scheduled buffer coverage; it does not establish acoustic
lip-sync or continuous sample-perfect output under every stress condition.

## Resource accounting and what it excludes

Admission reserves two source-resolution RGBA-equivalent frame references per
inactive angle, one output canvas and one possible in-flight bitmap per angle,
and one shared scratch canvas. It admits at most one worker, seven inactive
lanes and one request per lane, with no catch-up queue. Native decoder handles
are directly owned and closed, rather than inferred from wrapper disposal.

| Candidate | Reserved frame/surface bytes | Observed peak frame-reference bytes |
|---|---:|---:|
| 4-angle 1080 originals | 51,379,200 | 33,177,600 |
| 8-angle 720 proxies | 55,065,600 | 29,491,200 |
| 2-angle 2160 originals | 67,046,400 | 66,355,200 |
| 8-angle 1080 originals, rejected | 119,577,600 | No decoder opened |
| 4-angle 2160 originals, rejected | 200,678,400 | No decoder opened |

The 64 MiB ceiling is 67,108,864 bytes. The two-angle 4K original case has only
62,464 reserved bytes of headroom; prefer proxies in the initial product plan.
For eight proxies, the frame-reference peak plus output/in-flight/scratch
allowances was 32,947,200 bytes. Counts are conservative application-reference
accounting; they are not physical native or GPU memory measurements.

Encoded submissions also have a separate ceiling of 60 packets / 8 MiB per
request, potentially 56 MiB across seven lanes. Demux buffers, full source and
proxy Blobs, codec-internal references, compositor surfaces, browser caches and
JS bookkeeping are additional. A packet is obtained before its byte ceiling is
checked, so that ceiling bounds accepted decode work, not every transient demux
allocation. The prototype must not be marketed as a 64 MiB total-memory wall.
Per-process RSS snapshots cover the entire isolated browser, include shared
pages and cannot isolate incremental wall memory. JavaScript heap and coarse
`deviceMemory` readings do not resolve this limitation.

The existing 256 MiB compositor surface contract remains separate. Six 4K
preview/lens surfaces reserve 199,065,600 bytes; a further 64 MiB accounted wall
fits within that number only for those known surfaces. Export adds another
surface and must first drain the wall. The implementation must use the actual
aggregate reservation for each configuration, including Source Monitor and
other background owners, instead of treating separate subsystem caps as a
combined budget.

## Fault evidence and limits

The foreground run records 34 fault observations. Cancellation, a 50-seek
storm, authored cuts, injected Canvas2D context loss, explicit pressure-policy
retirement, actual proxy removal, source disconnection and project-store
replacement all retired the wall and reached native zero. The exact cut was
rendered through Program at frames 89 and 90 and the expected angle identity
was verified on both sides. This checks that authored switching remains exact;
the thumbnail wall retires on an edit rather than choosing or writing the cut.
An actual GPU-process crash in the disposable Chromium instance caused
context-loss retirement and zero cleanup (0.39 ms) in the 4K-original case.
Physical device removal and automatic recovery are not proven.

A real `Memory.simulatePressureNotification(critical)` did **not** automatically
retire the wall. There is no reliable page-level notification demonstrated by
this experiment. Explicit admission-owner pressure retirement passed. Do not
confuse that injection with automatic detection of OS/native/GPU pressure.

Normal Playwright forces page focus/visibility in its originating CDP session;
its minimized/frozen observations still said `visible` and are invalid lifecycle
proof. A separate isolated native Chromium, connected with `noDefaults:true`
and its default context, was used for the lifecycle correction. The evidence
records actual visibility and distinguishes automatic retirement from explicit
observation cleanup. The valid freeze strategy is to drain when hidden, before
frozen tasks can stop running; no promise is made to complete asynchronous
cleanup after a page has already frozen or been discarded.

The native probes also exposed an entry-policy gap in this deliberately small
candidate: it listens for a subsequent `visibilitychange`, but does not refuse
an admission that starts with the page already hidden. A minimized probe that
started hidden therefore did not automatically retire. Initial visibility
admission, suspension races and restart policy are explicit blocking product
gates, not erased by the successful visible-to-hidden observations.

Proxy invalidation uses the actual production proxy API and source/project
freshness checks. Project replacement exercises the actual store replacement
boundary, not the complete project-controller teardown/recovery transaction.
The normal editor context is eventually closed, but that is not evidence that
every product controller drained within the wall's deadline. The Program's own
paused source owner may remain until normal editor disposal; “zero” here always
names the research wall's ownership, never all browser media resources.

## Implementation plan, only after research approval

1. **Shared admission and suspension.** Add one app-owned admission authority
   used by Program, Source Monitor, media visuals, proxy generation, motion and
   audio analysis, export and the future wall. Reserve before allocating native
   resources; account by owner and lifetime. Program/audio take priority;
   export and foreground operations preempt the wall. An old lease cannot be
   reused until cooperative zero acknowledgement or worker termination. Reject
   initial hidden/frozen admission and recheck visibility/source/project after
   every asynchronous boundary. Prove preemption, startup cancellation, deadline
   expiry, replacement and late-frame closure with deterministic tests.
2. **Finite, source-bound worker.** Promote the owned-native approach through a
   reviewed worker/pipeline boundary, with serializable request identities and
   explicit terminal ownership. Reuse the existing proxy freshness authority.
   Bound demux access as well as submitted work, validate coded dimensions and
   reject unsupported semantics before allocation. Test long/reordered GOPs,
   VFR, nonzero origins, NTSC rates, rotation, unequal coverage, stale proxy
   replacement and source disconnection. Integer timeline mapping and existing
   audio policy remain authoritative. Keep native objects out of stores.
3. **Adaptive controller and fallback.** Start with fresh proxies and measured
   320×180 / 10 fps monitoring. On sustained tile-budget failure, try a bounded
   160×90 / 5 fps mode; if Program or audio misses its budget, drain promptly and
   retain paused previews. Track each angle independently. Use explicit retry
   or a bounded cooldown before upgrading to avoid oscillation. Runtime native
   errors/context loss retire the owner; do not depend on a universal memory-
   pressure event. Measure this policy against healthy paired baselines; the
   current fixed low-cadence fallback experiment is not an implemented governor.
4. **Product UI and acceptance.** Only after the ownership/decoder/controller
   gates pass, connect serializable observational state to an accessible
   Inspector/monitor UI with keyboard operation, per-angle fallback reasons,
   active-angle truth and stable focus. Angle switching uses existing commands
   at the integer playhead. Verify real recorded cameras, long sessions,
   constrained hardware, supported browser engines, concurrent background jobs,
   actual open/recovery/relink, GPU-loss recovery and original-media export.
   Repeat test → build/lint → real browser acceptance before enabling the UI.

A first release should prefer proxies for all larger groups and withhold VP9
originals and unmeasured configurations. The exact per-device admission policy
must come from runtime budgets and the broader acceptance matrix; this one
high-end machine cannot establish universal two/four/eight-angle limits.

## Reproduction and evidence integrity

Run from the repository root with the locked dependencies and an installed
Playwright Chromium. Fixtures and production proxies are generated locally in
an isolated browser profile; no media is uploaded and no GitHub item is edited.
The dedicated server binds only `127.0.0.1:42195` and refuses an occupied port.

```sh
npm run qa:issue195:check
npm run qa:issue195:research -- --smoke
npm run qa:issue195:research
npm run qa:issue195:research -- --lifecycle-only --profile=avc-1080
npm run qa:issue195:research -- --candidate=cursor
```

Run timing measurements without simultaneous build/test jobs. The complete
foreground run captures all three profiles and two repetitions; `--profile=`
selects one. `--candidate=cursor` deliberately reproduces the rejected v2 owner.
The eight-second moving patterns are deterministic; native encoded bytes may
differ across browser/hardware runs, so each source and proxy has its own hash.

The checked-in evidence preserves each run's base commit and aggregate source
hash, machine/browser facts, source/proxy provenance, measured rows, decisions,
terminal ledgers and fault observations. It is a compact projection of the
larger local `.tmp/issue195/` raw artifacts; raw artifact hashes bind that
projection. Local raw files additionally retain detailed Program telemetry and
per-second process RSS. The foreground source hash is
`a4f146ad0d7fa2dab4bc7c9e72c78e5600fe2e6d63ee1f25d930f8d875038afe`,
based on `3653c9a14cb6371321bbda909cd4a576e365657a` plus recorded uncommitted
research files. It was unchanged during measurement. The later lifecycle runner
has its own identity; the final documentation/commit is not falsely described
as the exact timed tree. New runs also record individual file digests, the
tracked patch and the research source text for stronger reproduction.

Honest calibration notes: the existing two-rAF presentation diagnostic emitted
no continuous-playback samples because newer render generations superseded it;
those early diagnostic rows are not evidence of zero delivered video. The
pixel probe replaced that observation before the accepted foreground run. The
first native lifecycle attempts were disrupted by Vite reconnect/reload after
freeze. Vite 8.1.1 also injected a WebSocket connection despite `ws:false`; the
final runner disables only that development client's HMR connection with a
version-sensitive assertion. Browser lifecycle and media APIs remain intact.
Intermediate failures are retained locally, and successful later probes do not
retroactively validate them.

## Preregistered experiment (2026-09-05)

Measure the actual editor Program Monitor and audio transport alongside an
isolated, unshipped angle-monitor candidate. Compare no-wall baseline with
2/4/8 total angles: Program owns the active angle, the wall owns N-1 inactive
angles. No duplicate active decoder is intentionally requested. Targets come
from the existing integer playhead; thumbnails neither advance time nor author
cuts. The first candidate uses one worker, 320×180 tiles at 10 fps, a single
in-flight request per angle, and no catch-up queue. The fallback candidate uses
160×90 at 5 fps. Every resource remains outside React, Zustand and project data.

Source matrix: distinct deterministic moving-camera AVC 1080p30, VP9 1080p30,
and AVC 2160p30 clips, plus their actual production-generated AVC 720p editing
proxies. Record encoder/decoder configurations, byte sizes, SHA-256, source
origins, project binding and complete proxy provenance. Probe HEVC separately;
unsupported probes are explicit unsupported cells. Synthetic sources establish
a reproducible workload, not universal camera-codec support.

Record machine/OS, full browser version and launch flags, GPU facts where
available, viewport, power/battery visibility, source-tree identity, measurement
duration, Program delivered cadence and completion latency, audio-clock frame
progress, per-angle presentation cadence/age, missed requests, long tasks,
native decoder handles, app-owned frames/bitmaps/surfaces/workers, and available
memory observations. Label byte estimates separately from measurements; browser
heap figures do not measure native decoder or GPU memory.

## Thresholds fixed before the first timed run

Each foreground cell must pass independently; an unsupported or missing fact
cannot count as a pass. These are conservative project acceptance choices, not
browser guarantees. Use at least two measured runs per normal cell; one warm-up
second is excluded, followed by at least five measured seconds per run.

| Check | Required evidence |
|---|---|
| Program cadence | At least 95% of its paired no-wall baseline; baseline itself at least 27 delivered distinct frames/s for a 30 fps project |
| Program latency | p95 request-to-completion ≤50 ms and ≤baseline p95 +8 ms |
| Program missing frames | ≤1% completed requests report missing media; zero fatal render/audio errors |
| Tile cadence | Every inactive angle ≥8 fps at 10 fps target, or ≥4 fps at 5 fps fallback |
| Tile age | p95 request-to-presentation ≤200 ms; no unbounded pending queue |
| Responsiveness | Long-task total ≤2% measured wall time; no task >100 ms |
| Ownership | N-1 or fewer wall decoder lanes, one worker, one outstanding bitmap per lane, one shared worker scratch and N-1 output canvases; zero terminal owners |
| Pressure | Accounted candidate frames + surfaces ≤64 MiB, with the existing Program surface budget considered separately; unsupported native/GPU memory remains an evidence limitation |
| Terminal deadline | Cooperative drain ≤1 second, otherwise worker termination; no new admission before old owner retires; late transferred frames closed |
| Faults | Seek storms, exact-frame cuts, cancellation, source removal, proxy invalidation, context loss, background/freeze and project replacement invalidate old work and return terminal ownership to zero |

If a baseline is unhealthy, its wall cells cannot establish support. If only
the proxy passes, original-media operation must explicitly fall back to paused
previews; export continues to require originals. Live wall enablement also
requires a single admission authority across Program, Source Monitor, proxy
generation and analysis, rather than independently summing subsystem limits.

## Architecture findings at the research baseline

- `src/app/mediaJobScheduler.ts` limits each scheduler instance. Media visuals
  use two slots; proxy generation, motion analysis and audio alignment own
  separate one-slot schedulers. There is no shared, preemptive Program-first
  decoder/surface admission authority.
- `src/workers/video-source.ts` owns Inputs and child cursors. A forward cursor
  decodes intervening source samples even when only some become thumbnails.
  Reducing display resolution does not reduce encoded source resolution.
- `src/app/previewController.ts` already exposes observational completion and
  resource telemetry. `src/app/transportController.ts` owns the AudioContext
  clock. The experiment reused these without changing product code.
- `src/app/proxyController.ts` and `src/domain/proxyCache.ts` are the existing
  freshness/representation authorities. An arbitrary low-resolution re-encode
  is not evidence of a production-fresh proxy.
- The existing 256 MiB render surface bound is not a browser-wide memory limit.
  Seven 4K RGBA surfaces cost 232,243,200 bytes before decoder internals.

## Primary references

- [WebCodecs resource reclamation](https://www.w3.org/TR/webcodecs/#resource-reclamation):
  codec resources may be reclaimed; support checks are not concurrency leases.
- [WebCodecs hardware acceleration](https://www.w3.org/TR/webcodecs/#hardware-acceleration):
  hardware preference is a hint, not proof of which decoder ran.
- [Mediabunny reading media](https://mediabunny.dev/guide/reading-media-files):
  prefer bounded sequential decoding and explicitly dispose Inputs. The
  installed 1.50.9 source is the experiment's exact implementation reference.
- [Chrome page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api):
  hidden, frozen and discarded pages have distinct lifecycle constraints.

## Candidate screening

The first real Chromium smoke run rejected the reused forward-cursor candidate:
one 1080p angle reached 40 native frame references (331,776,000 RGBA-equivalent
bytes); one 720p proxy reached the same count (147,456,000 equivalent bytes).
These are conservative reference-size estimates, not measured physical RAM.
Both tripped the 64 MiB guard and cooperatively reached zero native decoders,
frames, Inputs, cursors and scratch surfaces. Program remained around 30 fps.
The raw run is retained locally as `continuous-cursor-smoke.json`. It has an initial source hash but no end-of-run stability check, so it is historical screening evidence only and is excluded from the durable accepted matrix.

Candidate v2 replaces only the research worker's forward cursor with a finite
one-target seek cursor, closed after each thumbnail. This deliberately trades
GOP decoding work and decoder churn for lower retained-frame cost. The existing
product adapter is reused unchanged. Thresholds remain unchanged. A passing
low-cadence sparse monitor would not establish support for full-rate angle video.

The complete v2 matrix was retained as `finite-cursor-matrix.json`: 64 measured
rows and 34 fault observations. Native decoders sometimes remained configured
when cursor/Input closure returned. Mediabunny 1.50.9's
`mediaSamplesAtTimestamps().return()` marks its pump terminated without awaiting
that pump; `WorkerVideoSource.close()` awaits the iterator rather than the
native handle. The research worker was always terminated afterwards, but its
acknowledgement could not claim native-zero. These cells fail the gate.

Candidate v3 uses Mediabunny only for demux and directly owns every native
VideoDecoder and output VideoFrame. One request admits at most 60 encoded
packets and 8 MiB of encoded packet data. Its finally block closes both the
selected frame and decoder; terminal cancellation closes native decoders before
awaiting pending tasks, so an in-flight flush cannot hold admission. No browser
constructor is patched in this candidate. Its representative media has a
one-second GOP, 30 fps, zero origin and no rotation; broader input semantics
remain a product gate. The rejected v2 worker is retained for reproduction.

## Checked-in evidence and validation

- [Foreground matrix](evidence/issue195/research.json): 52 timed rows, including
  rejected attempts, plus 34 explicitly classified fault observations.
- [Final native lifecycle probe](evidence/issue195/lifecycle-avc-1080.json): 12
  observations, stable source identity, no console errors, pre-freeze zero and
  the documented initial-hidden admission failure. This fault-only probe ran
  alongside low-concurrency tests and is not timing-performance evidence.
- [Earlier interrupted native probe](evidence/issue195/native-ws-freeze-interruption.json):
  records a genuine visible-to-hidden automatic drain in 1.04 ms, followed by
  the development reload failure. Its later interruption remains in the file;
  it is not presented as a completed passing run.
- [Rejected finite-cursor matrix](evidence/issue195/finite-cursor-matrix.json):
  preserves the native-close acknowledgement failure that ruled out v2.
- [Validation record](evidence/issue195/validation.md): commands, results and the
  unchanged-baseline reproduction of the one remaining repository test failure.

The dedicated TypeScript gate and all four research decision tests pass. The
production build passes (4,971 modules), oxlint passes, the production audit
reports zero vulnerabilities, and all 17 repository runner checks pass.
Production output contains no laboratory markers and the new import-boundary
test passes. No production runtime or UI file was edited.

The full suite is **not green**: with four workers, 3,946 of 3,947 cases across
284 files pass. The single plugin-startup test fails with `safe-mode` both here
and in an isolated archive of unchanged starting commit `3653c9a`. Focused runs
are identically 23/24 on both trees. No plugin behavior is changed for this
research task. An earlier concurrent run had 12 failures; eleven disappear with
bounded concurrency. Build, lint and issue-specific evidence do not erase this
remaining baseline failure. The broader Chromium regression suite was not
rerun; the previous Issue #194 record already documents eight baseline failures
there. This research uses its dedicated real-editor browser matrix instead.

To regenerate the checked-in projection from local raw outputs:

```sh
node scripts/issue195/summarize.mjs .tmp/issue195/research.json .tmp/issue195/lifecycle-avc-1080.json
```

The summarizer rejects unstable or missing end-of-run identities and rechecks
stored cell decisions against their own paired baselines. Missing evidence and
rejected admission cannot become a pass through summarization.
