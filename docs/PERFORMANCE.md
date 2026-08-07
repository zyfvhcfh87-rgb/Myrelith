# Performance evidence harness

Issue #54 establishes a repeatable evidence format for later optimization
work. It records trends; it does not declare WebCut fast or enforce release
budgets from one machine or one run.

## Production route gate

The harness route is `/__webcut/performance`.

- Vite development builds allow that exact route.
- An ordinary production build does not contain the route, fixture, or harness
  UI.
- A production build includes the route only when
  `VITE_WEBCUT_PERFORMANCE_HARNESS=1` is present at build time.
- Every other path continues to render the product UI.

The benchmark command sets the flag only inside its Node process, creates an
enabled production build, serves that build on an isolated loopback port, and
restores the caller's environment afterward. Do not set the flag in a public
deployment.

## Stress fixture contract

Fixture `stress-100x8-30m-v1` is deterministic and accepted by the canonical
portable-project validator. It contains:

| Shape | Exact value |
|---|---:|
| Assets | 100: 45 video, 25 audio, 30 still image |
| Representative 3840x2160 assets | 25 |
| Tracks | 8: V1-V4 and A1-A4 |
| Timeline | 54,000 frames / 30 minutes at 30/1 fps |
| Clips | 320 |
| Crossfades | 39 |
| Procedural text clips | 20 |

Every catalog asset is referenced. Runtime connections remain bounded: one
generated 3840x2160 AVC/MP4 source with ordinary 30 fps samples across the
supported continuous window plus one final long-duration tail, six URLs over
one generated 3840x2160 PNG, and four URLs over one generated stereo WAV.
The remaining catalog entries stay intentionally offline. Selected scrub
frames always include a connected 4K still plus procedural text; playback from
frame zero also traverses the connected 4K video and four audio tracks.

The artifact's canonical fixture fingerprint is SHA-256 over the exact UTF-8
JSON for the fixture version/project, connected source and scrub plan, plus the
stable generated-media settings and sample plan. Browser encoder/container
bytes are deliberately excluded because identical logical generation can emit
different MP4 or PNG bytes across runs. Changing any portable fact, logical
media plan, or generation setting changes the fingerprint. The same identity
is recomputed after the canonical stores are restored immediately before
measurement.

The fixed media plan supports at most 2,000 ms per playback trial and 31
frames per export sample without entering its held tail. The CLI and in-page
runtime reject larger requests before measurement; they never label held-tail
decode as continuous evidence.

## Metrics

Each measured metric keeps its raw samples plus count, minimum, maximum, mean,
median, p75, p95, population variance, and standard deviation. Unsupported or
explicitly skipped measurements are recorded as `unavailable` with a reason;
they are never replaced with zero.

| Metric | Definition |
|---|---|
| `launcher-interactive-ms` | Navigation start through two animation frames after the real launcher primary action is visible and enabled. |
| `editor-first-usable-frame-ms` | Isolated editor mount through the browser presentation boundary after the first drawn fixture frame. |
| `scrub-input-to-present-ms` | Playhead input timestamp through the browser presentation boundary after the matching preview frame drew every expected connected fixture contributor. |
| `frame-render-ms` | Worker-reported decode and composition duration for that fully drawn fixture frame. |
| `dropped-frames` | Missing integer frames from the expected playback start through monotonically presented frames that drew every expected connected fixture contributor in one trial. Timing begins only after the playback clock starts; a startup timeout or empty/partial trial is unavailable, never zero. |
| `audio-underruns` | 25 ms observations where scheduled audio trails the `AudioContext` clock by more than 5 ms. |
| `import-readiness-ms` | Content inspection and bounded first-frame decode of the generated 4K PNG through Ready. |
| `memory-plateau-mib` | Aggregate host OS private bytes, or RSS where private bytes are unsupported, for every live Chromium process returned by CDP `SystemInfo.getProcessInfo` at each post-warmup batch boundary. |
| `memory-growth-kib-per-batch` | Signed change between consecutive complete process-scope plateau samples using one unchanged host metric and sampler. |
| `export-real-time-ratio` | Elapsed export time divided by the bounded 4K segment duration. |

## Reproduce

Install the locked dependencies once, then rehearse the complete route,
fixture, measurement, cleanup, and artifact flow:

```powershell
npm ci
npx playwright install chromium
npm run benchmark:smoke
```

On a minimal Linux or CI host, install Chromium and its system dependencies
with `npx playwright install --with-deps chromium` instead (the dependency step
may require elevated package-manager permissions).

The smoke run uses two scrub/import samples, one 350 ms playback trial, two
memory batches, and records export as explicitly skipped. At each batch
boundary the page awaits a CLI-injected Playwright binding; the runner obtains
the current Chromium PID/type table from browser-level CDP and samples those
exact PIDs through the host OS. `N` complete batches produce exactly `N`
plateau samples and `N - 1` consecutive growth deltas. If CDP is unavailable,
renderer or GPU coverage is absent, any reported PID cannot be sampled, or the
host metric changes between batches, both memory metrics are `unavailable`
with the reason. A partial process total is never published. Run the baseline
profile with:

```powershell
npm run benchmark
```

Useful explicit variants:

```powershell
node scripts/performance/run-benchmark.mjs --headed
node scripts/performance/run-benchmark.mjs --samples 10 --playback-runs 5 --output .tmp/benchmarks/review-run
node scripts/performance/run-benchmark.mjs --channel chrome
node scripts/performance/run-benchmark.mjs --help
```

Each successful run writes one directory under `.tmp/benchmarks/` unless
`--output` is supplied:

- `performance.json` - machine-readable artifact conforming to
  version 2 of `benchmarks/performance-artifact.schema.json`;
- `summary.md` - human-readable metric, provenance, gate, warning, and cleanup
  summary;
- `benchmark.png` - completed in-browser summary at 1440x900.

The CLI exits non-zero if the route, measurement, console-health, store
restoration, or generated-URL cleanup checks fail.

For a manual production-route check in PowerShell:

```powershell
$env:VITE_WEBCUT_PERFORMANCE_HARNESS = '1'
npm run build
node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 41854 --strictPort
```

Open `http://127.0.0.1:41854/__webcut/performance`. Remove the environment
flag before making an ordinary production build:

```powershell
Remove-Item Env:VITE_WEBCUT_PERFORMANCE_HARNESS
```

## Source and device identity

Every CLI artifact records the branch, exact commit, dirty state, and a dirty
SHA-256 fingerprint over the commit, porcelain status, binary tracked diff,
untracked paths, explicit file kinds, and content. Untracked regular files are
hashed incrementally with streams; symlinks hash their link target without
following it; directories, missing paths, and special-file kinds receive
deterministic type markers. It also records Node, OS/platform, architecture,
CPU model/count, host memory, Chromium channel/version, user agent, viewport,
device pixel ratio, browser-reported memory, WebCodecs, OffscreenCanvas, and
cross-origin-isolation facts.

Browser-level CDP `SystemInfo.getInfo` supplies the GPU renderer and vendor,
driver vendor/version, normalized device rows, raw feature status, and the
hardware/software/mixed acceleration identity derived from the renderer and
relevant feature states. Every identity field is independently marked
`unavailable` with a reason if the selected Chromium channel does not expose
it. `memoryEvidence` records the CDP + host provenance, primary metric, scope,
and every per-process raw batch row. The aggregate includes browser, renderer
(including DedicatedWorker/native allocations charged there), GPU, and utility
processes in the CDP table. Device VRAM and memory not charged to a Chromium
process remain explicitly out of scope; this is not a claim of total system or
GPU memory.

Launcher and editor cold samples each use a fresh BrowserContext so their HTTP
caches and browser storage are independent. The runner recomputes the complete
source identity after measurement and refuses to write artifacts if the
checkout drifted.

Compare trends only when the fixture fingerprint, browser channel, GPU and
device profile, memory primary metric, and host sampler match. Keep the raw
JSON artifacts. Prefer at least five independent runs before discussing
variance, and establish representative-device ranges before turning any
proposal into a required gate.

## Proposed gates (advisory only)

| Statistic | Proposal | Reason |
|---|---:|---|
| launcher p95 | <= 1,500 ms | Keep the project launcher responsive on a supported baseline device. |
| editor first-frame p95 | <= 3,000 ms | Bound the stress editor's time to the presentation boundary after its first drawn fixture frame. |
| scrub input-to-present p95 | <= 100 ms | Avoid visibly disruptive scrub latency. |
| frame render p95 | <= 33.34 ms | Target the 30 fps frame budget. |
| dropped frames median | <= 0 | Sustain short representative playback without presentation gaps. |
| audio underruns maximum | <= 0 | Keep scheduled audio ahead of the audio clock. |
| import readiness p95 | <= 2,000 ms | Bound 4K still inspection and first-frame readiness. |
| memory growth p95 | <= 1,024 KiB/batch | Flag sustained post-warmup complete Chromium process-memory growth for leak investigation. |
| export ratio p75 | <= 1 | Target real-time-or-faster bounded 4K export. |

These rows always use `disposition: "proposal"`. A failed proposal makes the
trend visible but does not fail the command. `memory-plateau-mib` is recorded
without a proposed absolute threshold because supported device capacity varies.
The manual in-page button cannot access browser-level CDP or host OS process
memory, so it records GPU/process-memory evidence as unavailable and directs
reviewable evidence collection to the CLI.

## Mutation and resource boundaries

The harness refuses to enter over an active project, non-empty media store, or
non-empty document history. It uses only the isolated route's in-memory stores;
it does not call project activation, save, recovery, recent-project, or file
handle persistence.

Cleanup is idempotent. It unsubscribes passive diagnostics, disposes preview,
transport/audio, and export owners, clears generated media (revoking every
owned object URL), and restores the exact document/history, media maps,
transport values/actions, and untouched project-session reference. The JSON
artifact records each restoration fact separately and the CLI fails if their
aggregate is false. Playback diagnostics retain only a bounded list of frame
numbers during an active trial and are cleared before process-memory batches. URL
cleanup evidence counts only owned revoke calls that actually complete, so a
failed ownership cleanup cannot report a tautological pass.
