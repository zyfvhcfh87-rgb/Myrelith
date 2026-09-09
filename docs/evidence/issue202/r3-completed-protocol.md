# Narrow correction: completed preview readback

Preparation authorized after the parent and worker independently identified the
run 1 finish/flush limitation. **No corrected browser run is authorized yet.**
Run 1, its shader/owner/controller/runner and all frozen references remain
unchanged. Its raw evidence/audit is committed at `dbd7b70`; six candidate
preview completion claims remain unqualified. This protocol supplements the
frozen R3 protocol only where described below.

## Exact completion correction

`r3-gpu-completed.mjs` subclasses the original owner. It reuses every shader,
equation, matrix, fixture, texture, scene dimension and integer frame weight.
After the original preview draw returns, it reads **one RGBA8 pixel** from the
final output into a separately reserved four-byte buffer, then checks GL errors.
The original finish/flush remains in the inherited submission path but is never
the final completion authority. A failed readback rejects the frame.

The [exact Chromium 151.0.7922.34 source](https://chromium.googlesource.com/chromium/src/+/782af9cb30a53f54487e5d2e44738645a8ec457c/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc#3539)
and [source audit](r3-completion-source-audit.json) pin the defect. The
[WebGL2 typed-array readPixels contract](https://registry.khronos.org/webgl/specs/latest/2.0/)
supplies the blocking framebuffer-readback boundary. This is comparable to the
existing baseline's one-pixel Canvas2D readback; neither is monitor presentation.

Setup now includes one initial frame-zero composition returned through readback
after both input uploads. Preview uses the four-byte probe; export/cancellation
setup reuses the already admitted full byte readback; tiny qualification setup
uses its existing Float32 readbacks. This initial setup draw is outside the
unchanged 30 warm-up / 120 measured frames. Original submission setup duration
and total completed setup duration are both reported in `support.completion`.
No extra full-size image or duration-sized buffer is introduced.

Every successful preview draw, including start/draw/stop and the draw preceding
context loss, now returns through the probe. A lost context rejects before
further submission, as before. `dispose()` releases the charged probe with the
other owned resources and clears its reference. Delete/context-loss calls and
worker termination remain API ownership evidence; no fence or immediate native
memory reclamation is claimed during disposal. If setup/draw fails, the existing
outer `finally` still releases or reports the partially initialized owner.

The original ledger already reserved a four-byte preview allowance. At 4K,
the setup tile still determines the preview peak of **233,226,276 bytes**;
the probe is allocated after tile release. Export/cancellation uses its existing
readback allocation. The 256 MiB ceiling, original direct-swap rejection, native
memory/RSS exclusions and all numeric/timing/cancellation limits are unchanged.

## Narrow execution request after review

`run-r3-completed.mjs` requires a separate `ISSUE202_R3_COMPLETION_SLOT=granted`
assertion, a clean committed branch, fresh output and both original/corrected
manifests. Before creating any experiment worker, it captures CDP
`Browser.getVersion` and requires version 151.0.7922.34 and revision
`782af9cb30a53f54487e5d2e44738645a8ec457c`. A mismatch stops and tears down.
It records actual backend and the unchanged requested additional `--mute-audio`
flag. Runtime revision was not recorded by run 1; installed CfT metadata and
the public version tag are its documented source mapping.

The corrected worker differs from the original only in its owner import.
The controller differs only in its worker URL and omission of export timing
pairs. At most **20 serial jobs** are requested:

1. Tiny prerequisite: the same 40 frozen working/view cases, unchanged limits.
2. Twelve preview timing runs: 1080p/4K × three alternating baseline/candidate
   pairs; 30 warm-up and 120 measured frames each, with the original early no-go
   certificates and synthetic deadline accounting.
3. Ten 1080p start/draw/stop cycles in one lifecycle job, five 1080p cancellation
   jobs, and context-loss rejection with a fresh tiny correctness retry. These
   exercise the corrected setup/completion dependency. Cancellation setup adds
   one returned initial full readback before its cancellation-target frame;
   it is not another 120-frame export benchmark.

Run 1's six full export pairs are not rerun to rewrite their summaries. No new
codec, media, source conversion, native GPU, display, scene, threshold, golden,
plugin/effect or product work is introduced. Any failed prerequisite/drain or
forced termination stops subsequent jobs under the original rules. Watchdogs
remain 180 seconds per job, 600 seconds per controller, 650 seconds for page
evaluation; launch and awaited teardown are additional. Port 5202 stays exclusive.

If a timing row returns an absolute `no-go-certificate`, R4 must retain that
failure even when the paired ratio is `unqualified-incomplete-pair`. Numeric,
timing, completed-frame, API-owner and physical/native qualifications remain
distinct. A passing narrow stage cannot qualify the existing failed scope/P3,
unavailable WebGPU or incomplete metadata/HDR/native-platform prerequisites.

## Preparation checks

`r3-completed-preparation-1.json` records **14/14 pure Node tests**, the same
40 independently reproduced reference cases, a static controller/worker bundle
and rejection of the ungranted runner before launch. Four new mocked-boundary
tests show the original flush-only negative control leaves work pending, the
probe completes it, readback failure propagates with probe cleanup, completed
setup awaits its returned frame, and export setup reuses its existing buffer.
Mocks do not qualify native GPU synchronization or lifecycle behavior.

All 72 compiled production source hashes are unchanged and confined to existing
domain/pipeline modules. Scoped lint, syntax, raw-run audit, original manifests
and diff checks pass. No corrected browser/shader/timing/lifecycle run, broad
test suite or product build was performed during preparation.

The command below is review material, not authorization. It requires a fresh
explicit parent slot grant for the final committed source identity:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools ISSUE202_R3_COMPLETION_SLOT=granted \
  node docs/evidence/issue202/run-r3-completed.mjs \
  /Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue202/docs/evidence/issue202/r3-completed-run-1.json
```

R4's six-criterion report remains pending this bounded correction's review and
evidence. No product-ready interpretation is made from incomplete preparation.
