# Optional WebGPU video-scope experiment

Issue #75 evaluates one bounded Part 8a workload: the completed-frame
histogram, waveform, and vectorscope analysis introduced by Issue #71. The
decision is **no-go for production selection**. CPU analysis remains the only
default and the Canvas2D/WebGL2 compositor paths remain supported unchanged.

## Why this workload

The scope analyzer performs three independent density accumulations for every
sampled pixel, so atomic GPU compute is technically credible. It is also a safe
experiment boundary: the renderer already downsamples the completed presented
frame to a fixed 160 x 90 RGBA sample, runs at no more than four Hz with one
pending job, and treats analysis as disposable diagnostics. Preview/export
composition, authored effects, timeline state, and project persistence do not
depend on the result.

The same boundary also exposes the practical problem. The current workload is
only 14,400 pixels. WebGPU must expand and upload the CPU-visible RGBA sample,
dispatch compute, copy the atomic counters into a map-readable buffer, and wait
for readback. It cannot remove the existing Canvas2D downsample/readback in
this experiment, so its fixed submission and transfer costs dominate.

## Selection and fallback

The ordinary `video-scopes.worker` calls the CPU analyzer directly. A local
build may set `VITE_MYRELITH_WEBGPU_SCOPES_EXPERIMENT=1`; only then does that
worker dynamically import the optional adapter and ask it to prefer WebGPU.
Do not set this flag in a public deployment.

The adapter follows this contract:

| Stage | Contract |
|---|---|
| Probe | Require `navigator.gpu`, then a non-null default adapter. No power or optional-feature requirement is made. |
| Initialize | Request one device, compile one compute pipeline, then run a deterministic 160 x 90 parity self-test against the CPU oracle. |
| Execute | Allow only the production 160 x 90 shape. Allocate four request-owned buffers, submit once, map/copy the result, then unmap and destroy every buffer in `finally`. |
| Unsupported/init failure | Return the CPU result and retain a typed reason; do not retry that adapter instance. |
| Runtime failure/device loss | Resolve the current or next analysis through CPU, release the failed session, and never mutate project or render state. `GPUDevice.lost` is observed explicitly. |
| Disable/close | The render worker sends its analysis child an explicit release message. The child destroys the device and acknowledges release; the parent has a bounded termination fallback. |

The default production build contains no WebGPU shader/adapter chunk or
`navigator.gpu` reference. An enabled build emits the adapter as a separate
10.14 kB uncompressed chunk. Disabling the flag therefore preserves both
runtime selection and the ordinary production module graph.

## Exact output contract

CPU and WGSL share one non-negative integer/fixed-point definition:

- alpha zero is ignored; displayed RGB channels are rounded after
  display-over-black multiplication;
- luma and chroma retain source-channel precision while applying alpha, exactly
  reproducing the previous float64 path through integer Rec.709 weights
  2126/7152/722 over 10,000;
- waveform and Cb/Cr bins use explicit round-half-up integer division; and
- every counter remains below 65,535 within the fixed 14,400-sample ceiling.

The WebGPU adapter refuses itself if its startup self-test differs anywhere in
the four histograms, waveform density, vectorscope density, dimensions, or
sample count. CPU remains the authoritative fallback.

## Resource budget and ownership

One WebGPU analysis requests at most 353,304 explicit buffer bytes:

- 230,400 bytes for four `u32` channels per input pixel;
- 61,444 bytes for atomic output;
- 61,444 bytes for map-readable output; and
- 16 bytes for parameters.

The existing CPU result owns 30,720 bytes of typed-array output. WebGPU driver,
pipeline, command, and allocator overhead is not observable through the API and
is reported as unavailable rather than estimated. The persistent adapter owns
only its device and pipeline. Request buffers are never cached, never enter
React/Zustand/project data, and are all destroyed after completion or failure.

The lifecycle follows the WebGPU specification's explicit buffer-destruction
and asynchronous map rules. Chrome also documents that `navigator.gpu` may be
absent, adapter selection may return null, and support depends on secure
context, browser/platform, acceleration settings, drivers, and blocklists:

- [WebGPU buffer destruction and mapping](https://www.w3.org/TR/2022/WD-webgpu-20220614/#buffer-destruction)
- [Chrome WebGPU troubleshooting and support conditions](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips)

## Repeatable evidence

Run the source-addressable browser benchmark from the repository root:

```powershell
npm run benchmark:webgpu-scopes -- --warmup 10 --iterations 60
```

It uses headed system Chrome by default, starts Vite on strict loopback port
41875 with the internal flag scoped to that child process, fingerprints the
fixture and relevant source files, records CDP GPU facts, exercises real device
loss, checks cleanup, writes ignored JSON/Markdown under
`.tmp/issue-75-webgpu/`, closes Chrome/Vite, and verifies the port was released.
`--headless` is available for a quick harness smoke.

The complete headed run on 2026-08-11 used Chrome 151 on Windows 11, an AMD
Radeon RX 6600 (driver 32.0.21045.1000), and the hardware WebGPU adapter
reported as AMD RDNA 2. Source fingerprint was
`sha256:ea5ba6df0e9417a9ea3d1817782d88093a1ad88bc3a5c7ebb1b961d0dfcc1394`;
fixture fingerprint was
`sha256:7e2db3d907652d78064f11634d686aebac10a30b91f36a887f5aeac2336a5134`.

| Current 160 x 90 workload | CPU | WebGPU |
|---|---:|---:|
| Median, 60 measured iterations | 0.500 ms | 3.500 ms |
| p95 | 0.800 ms | 4.600 ms |
| Explicit per-analysis output/transient buffers | 30,720 B | 353,304 B |
| Startup (adapter + device + pipeline + parity self-test) | none | 200.400 ms |
| First opt-in call wall time | n/a | 201.900 ms |

WebGPU produced exact output in all 71 comparisons, released every request
buffer before the next sample, recovered from an intentional device destroy
through exact CPU output, ended with zero active buffer bytes, emitted zero
browser warnings/errors, and released the strict port. Its median was only
0.143 times CPU throughput: equivalently, it took 7.0 times as long.

A separate flagged-app pass created a normal text clip, enabled Program Monitor
scopes, loaded both the analysis worker and opt-in WebGPU module, and reported
14,400 visible samples at frame 0. Keyboard scope-tab movement and disabling
the panel preserved clean diagnostics; the explicit release handshake completed
and strict port 41875 was released. Ignored screenshot
`output/playwright/issue-75-webgpu-scopes.png` has SHA-256
`7C5A6F5FF9AFDC57BFAD8900DE8DE042721B6AB1459CD8FEC91584AE6505FE7E`.

## Support findings and decision

| Environment | Finding |
|---|---|
| Chrome 151 / Windows 11 / RX 6600 | Available and hardware enabled; exact, but materially slower for the current workload. |
| Same Chrome with intentional device destruction | Current session became lost; the adapter returned exact CPU output and released its resources. |
| Missing `navigator.gpu`, null adapter, initialization/dispatch error | Deterministic CPU fallback covered by focused tests; no project state is touched. |
| Other browsers, operating systems, integrated GPUs, mobile, or software adapters | Not measured in this issue; treated as unsupported until proven and therefore CPU-backed. |

There is no measured latency or memory benefit, startup cost is material, and
the support matrix contains only one hardware/browser family. Production must
not select WebGPU for scopes. Reconsider only if a future design removes the
CPU readback/upload round trip or increases the useful compute workload, then
repeat exact parity, device-loss, memory, startup, and multi-device/browser
measurements before changing any default.

Final validation passed 75 narrow scope/adapter/render-worker tests, the earlier
169-test integration focus, all 2,313 Vitest cases across 168 files, all 16
Node benchmark-runner checks, production TypeScript/build, oxlint, and
`npm audit --omit=dev --audit-level=high` with zero vulnerabilities. The normal
build emitted only its established large-chunk advisory and retained the
WebGPU-free worker graph described above.
