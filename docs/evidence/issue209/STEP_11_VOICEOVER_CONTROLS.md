# Issue #209 — Step 11 voiceover controls (plus review hardening)

Date: 2026-09-29. Branch/worktree: `codex/issue209`, `.worktrees/issue209`.
First session with Claude as the coding agent; the user lifted the
one-step-per-turn usage pacing, and the quality gates are unchanged.

## Review of Steps 5–10 before building on them

Two independent read-only reviews covered the lower layers (clock, WAV
draft, worker, worklet, bridges) and the app layer (capture owner, transport
join, Keep, recovery). No defects were found in the frame/sample math, the
WAV header, or the checkpoint journal. The reviewers brute-forced
`voiceoverTimelineFrameAtSample`/`voiceoverStopBoundary` against a linear
search at 30000/1001, 24000/1001, 60000/1001 (44.1 kHz), 25, 120, 48000/1
and 47999/1, and found zero mismatches.

| Finding | Resolution |
| --- | --- |
| At 60 minutes the 16 KiB batch that crosses the limit faulted the writer; the take ended as `failed` and only appeared as an orphan. The limit check also sat outside the writer's fault handler. | `voiceoverLimitStop` computes the last frame boundary within the limit; the worklet receives it as `limitStopFrame` and stops there. The owner treats that unrequested stop as a normal Stop and review, with a diagnostic. The writer's limit check now faults inside its `try`. |
| Seek, pause, device/media change, and timeline edits interrupted by aborting the graph, then reopened the last checkpoint, losing up to 256 KiB (~2.7 s). | `transport-changed`/`destination-changed` now end at the next frame boundary and finalize every accepted sample (review stays Pool-only). `hidden` and `source-ended` keep the checkpoint path. The transport Pause/Play toggle ends a take normally. |
| Cancel with a dead writer, or Discard after a failed/project-replaced take, could never delete the draft. After the worker died, retry failed forever and project exit was blocked. | Discard falls back to an idempotent delete by id from a fresh worker. The worker's `remove` tolerates a missing directory, and `discardStored` refuses the writer's own active draft. |
| Another tab could list a take in review as orphaned (handles are closed after Stop), then discard or recover it. | The owner holds the Web Lock `myrelith-voiceover-draft:<id>` from before writer creation until kept/cancelled/failed. The survey classifies held or pending lock ids as `live`. |
| Recovery shared one worker bridge across concurrent operations and closed it in `finally`. The recovered file's grant was fire-and-forget, so a quick Discard could delete an imported file. | Every recovery-facade operation is serialized. Recovery awaits an explicit grant (a failure is reported as a note). Discard refuses a draft whose file name is a current media descriptor. |
| The capture worklet processor returned `true` forever after its terminal message. | It returns `false` once terminal, including every fault path. |
| One uncloneable worker reply left the worker's promise chain rejected and silently dropped later requests. | The worker posts an error reply for that request id and keeps serializing. |
| Listing probes each file with a momentary sync handle and can collide with a create/recover in another worker. | The probe stays: it detects another tab's live writer. Opening now retries `NoModificationAllowedError` up to 8 × 25 ms. |

Not changed; recorded as limits:

- A kept recording whose only other reference is a *forgotten or deleted*
  project cannot be deleted from the panel. The "another project remembers
  this original" guard still applies.
- A project switch landing between Keep's import commit and its grant write
  can leave a grant under the old binding.

## Step 11 controls

- **Entry:** a toolbar button (icon-only below 820 px). While any capture phase
  holds the microphone, it becomes a red `REC m:ss.t` badge with a separate Stop
  button and a polite live-region announcement, whether or not the panel is
  open. After a crash or reload it badges the number of drafts to recover. That
  survey reads metadata only, never opens a device, and never imports.
- **Panel:** a non-modal dialog whose heading takes focus on open. Escape closes
  it only while no take is active, and focus returns to the toolbar entry. Fields:
  - Audio track: locked lanes are listed but disabled.
  - Microphone: `enumerateDevices`, which opens nothing. Labels appear after
    the first grant; the choice is passed as `deviceId: { exact }`.
  - Count-in: off to 4 s, converted to integer frames with integer rounding.
  - Latency offset: whole milliseconds within ±500, converted to exact samples.
  - Mute timeline audio: a checkbox.
  - Headphone advice: static text.
- **Record** reads the playhead inside the click. The panel never subscribes to
  the playhead (render-isolation invariant).
- **Recording:** elapsed time from exact sample counts, and a level meter fed by
  a per-batch PCM peak from the worklet. After 2 s of all-zero input it warns
  about a silent microphone (Step 1 found a built-in mic that delivered only
  zeros).
- **Review:** Keep on timeline (disabled with a reason after any interruption),
  Keep in Media Pool, Discard. Every failure and interruption has a
  plain-language explanation. The session diagnostic is shown in small text.
- **Recordings in browser storage:** unsaved drafts offer Recover and Delete
  (with a confirm). Kept recordings offer Delete file, subject to the existing
  clip/undo/other-project guards. Live drafts are never listed.
- **Latency offset semantics:** microphone signal for timeline sample `t`
  arrives at `t + C`. The worklet therefore captures `[anchor + C, stop + C)`.
  Take length and placement frame are unchanged, and nothing is trimmed or
  padded. A negative offset asks the transport for `-C` samples of extra lead
  (`preRollSamples`).
- **Mute:** the transport skips starting timeline audio and uses the silent
  shared-clock anchor. The count-in and video still run.
- **Narrow layouts:** at 720 px the toolbar's last actions (OTIO, Plugins,
  Export) were already clipped off-screen before this step. Below 1080 px the
  action row now scrolls horizontally, and focus scrolls a button into view.

## Verification

- New or extended focused tests:
  - clock limit and capture-window math
  - lane options and lock names
  - owner offset, pre-roll, mute, limit stop, boundary interruption,
    Pause-as-stop, lock hold/release, dead-writer and failed-take discard
  - recovery lock, awaited grant, descriptor guard, serialized operations
  - transport Pause routing, mute, and pre-roll lead
  - panel and indicator UI (11 cases)
- Real Chromium (`tests/browser/issue-209-voiceover-ui.spec.ts`, Chromium fake
  capture device, muted output):
  - Record → Stop → Keep on timeline places one clip at frame 0 whose length
    equals the imported asset; undo removes it in one step; the OPFS original
    remains.
  - Pause during a second take gives a placeable review, and Discard deletes
    its file.
  - Escape returns focus.
  - The console stays clean.
  - A reload during recording lands on the launcher. A new project's toolbar
    reads "Voiceover, 1 recording drafts to recover", and nothing is imported
    until Recover. Recover imports a checkpoint-truncated take (≥ 80 frames).
  - At 720 × 800 the panel fits the viewport and the page has no horizontal
    overflow.
- All earlier Issue 209 Chromium specs still pass against the changed worklet,
  worker, and bridges (13 total).
- Full Vitest: 5,535 tests passed across 418 files. The runner's 28 Node checks
  passed. `npm run build` passed (existing large-chunk notice only).
  `npm run lint` reported only the 5 existing unrelated warnings.
  `git diff --check` passed. All 13 Issue 209 Chromium specs passed.

```text
NODE_OPTIONS=--no-experimental-webstorage npm test
npm run build
npm run lint
git diff --check
npx playwright test tests/browser/issue-209-*.spec.ts
```

## Limits and next step

The fake capture device proves the product path, not physical latency or
real-device loss. Step 12 is the real-device matrix: microphone
capture/reopen, an acoustic loopback to choose a default offset policy,
unplug/revoke, and a long take. It needs the user's microphone and one
explicitly audible loopback pass.
