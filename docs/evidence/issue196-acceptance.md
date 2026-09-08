# Issue #196 final local acceptance — 2026-09-08

The approved local SDR grading implementation is complete on `codex/issue196`,
based on `368bd438411b4b261c032945523b81cf6a8c30f0`. Local LUTs, RGB curves,
lift/gamma/gain wheels and portable correction presets pass their acceptance
checks. RGB parade is deferred under its approved optional gate. The wider
browser suite still has eight failures reproduced on the unchanged base.

The [contract](../COLOR_GRADING.md) holds the supported subset, formulas, limits
and evidence for each gate. The [acceptance manifest](issue196-acceptance.json)
pins the final 83 changed source/test files, retained runtime proof sources,
unchanged production scope files and raw validation logs. Its parent commit
identifies the state before the final Gate 6 commit; file hashes identify the
source committed with this report. Retained logs omit terminal color escapes
and trailing whitespace; their test output and results are otherwise preserved.

## Final checks

| Check | Result | Evidence |
| --- | --- | --- |
| Full Vitest | 4,200 passed in 304 files | [unit log](issue196-gate6/unit.txt) |
| Repository runner checks | 17 passed | [same unit log](issue196-gate6/unit.txt) |
| Production build and TypeScript | Passed; existing chunk-size warning retained | [build log](issue196-gate6/build.txt) |
| oxlint | Passed | [lint log](issue196-gate6/lint.txt) |
| Production dependency audit | Zero vulnerabilities | [audit JSON](issue196-gate6/audit.json) |
| Issue #196 functional Chromium | All nine passed within the broad run | [browser log](issue196-gate6/browser-broad.txt) |
| Final preset regression rerun | Four passed after the final migration change | [preset log](issue196-gate6/browser-presets-final.txt) |
| Broader Chromium | 41 passed / eight failed / three opt-in skips | [browser log](issue196-gate6/browser-broad.txt) |
| Unchanged-base reproduction | The same eight cases fail with the same assertions | [baseline log](issue196-gate6/browser-baseline.txt) |

Full unit/build/lint checks include the final valid-only v1 preset migration
change. The broad browser run preceded that last change; the final four-case
preset rerun includes it. Node prints an existing `NO_COLOR`/`FORCE_COLOR` host
warning when Playwright starts. This is distinct from browser page warnings;
the nine issue-specific functional cases assert no unexpected page errors or
console warnings/errors.

The nine issue cases cover:

- Local 1D and native-33 import, invalid input rejection, reuse, portable save
  and IndexedDB recovery without retaining the source LUT file.
- Curves, wheel pointer/keyboard/numeric equivalence, one-edit undo/redo,
  temporary preview cancellation, clip/adjustment keys and static text/buses.
- Preset save/reload, a fresh receiving project, exact graded pixels, independent
  deletion, first-party recipes, transactional quota failure and future data.
- Nested composition through transitions, captions, adjustments, masks, lens
  correction, track/master scopes and explicit child-compositor comparison.
- Real Program worker and original-media VP9 export, built-in and installed
  trusted-plugin paths, repeated cancellation and enabled unavailable LUTs.
- Offline project reopen followed by exact original-media relink. Embedded LUT
  data and canonical project content survive; relink creates no history edit.
  The resulting preview pixel is exactly `[191, 64, 96, 255]`.

Final review additionally found that a full animation lane could make an older
operation return without applying a key. Grading now preflights the whole patch
and rejects growth before temporary or durable edits. Both clip and adjustment
regressions preserve redo; updating an existing key at capacity still succeeds.
Migration now transforms only valid v1 presets within the old 128 KiB ceiling;
corrupt shapes and oversized old records retain their raw values.

## Broader failures and baseline comparison

The baseline was a clean detached worktree at `368bd43`, using the same installed
dependencies, Playwright configuration, Chromium binary and host. Its tracked
files remained unchanged. Each of the eight failures matched the current branch:

| Case | Shared failure on current and baseline |
| --- | --- |
| Command palette accessibility | Target “Import at least two video sources first” measures 90.125 × 23 pixels; the test expects no undersized targets. |
| Ramped speech/music audio | Duration is `1.0453333333333332`; expected `1.0010000000000001` with tolerance below `0.0005`. |
| OS media file drop | Fixture setup cannot start ffmpeg: `spawnSync ffmpeg ENOENT`. No product file-drop behavior was qualified by this case. |
| Project setup, 1440 × 900 | The shared helper expects `scrollTop > 0`, receives `0`. |
| Project setup, 1050 pixels wide | Same scroll assertion. |
| Project setup, 1051 pixels wide | Same scroll assertion. |
| Project setup, 1100 pixels wide | Same scroll assertion. |
| Project setup, 390 × 720 | Same scroll assertion. |

Three existing opt-in cases were skipped: recorded LibriSpeech alignment,
recorded-camera monitoring and native window visibility/freeze/GPU lifecycle.
These are qualification limits. None is counted as a pass. The isolated baseline
worktree is disposable; the retained logs and revision provide reproduction data.

## Timing, pixels and visual qualification

Gate 3's [45 CPU cells](issue196-grading-runtime.json) remain the grading timing
authority. Every recorded evaluator hash matches the final source. They were
not rerun during the broad browser pass. Worst single/eight-stage p95 is
19.5/152.3 ms at 720p, 39.1/335.7 ms at 1080p and 157.4/1261.0 ms at 4K, below
the original ceilings. Cancellation settles in 0.2 ms after delivery; final
owned lookup bytes, entries, ports and requests are zero.

The [compositor evidence](issue196-grading-compositor.json) separately records
parser, readback and full Program timing. Same-raster pre-encode parity is exact;
the declared VP9 flat-patch allowance is six RGB values with alpha 255, with at
most one observed RGB value of error. These measure headless Chromium
151.0.7922.34 on arm64 Apple M5 Max, Darwin 25.6.0 and Node 26.8.1. They do not
qualify other browsers/hardware, real-time 4K playback or opaque native GPU memory.
Context-loss claims use injected Canvas loss/readback failures, not an OS GPU reset.

The optional parade's final repeat increased presentation p95 by 4.0 ms against
2.0 ms allowed, despite passing sample/analysis/paint ceilings. Both the earlier
pass and [final failure](issue196-rgb-parade-failed.json) remain in the contract.
The prototype was removed; final hashes verify production scope sources equal
the base. The [prototype patch](issue196-rgb-parade-prototype.patch) is evidence
only and must pass a revised measured gate before promotion.

A separate Codex in-app visual check at 1280 × 720 used a text clip with blue
curve endpoint `0.6` and red gain `0.6`. The live white text visibly became green;
the numeric fields remained accessible and the diagnostic log contained no
warnings/errors. The in-app native file chooser timed out, so actual media
import, relink and export are qualified by the separate Chromium tests. The
in-app viewport was restored, its QA tab closed and temporary Vite server stopped.

## Reproduction

Run from the repository root using the installed Command Line Tools. No Xcode
license agreement was accepted or global developer setting changed.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
NODE_OPTIONS=--no-experimental-webstorage npm test
npm run build
npm run lint
npm audit --omit=dev --audit-level=high --json

DEVELOPER_DIR=/Library/Developer/CommandLineTools \
npx playwright test --grep-invert 'bounded CPU grading timing matrix'

DEVELOPER_DIR=/Library/Developer/CommandLineTools \
npx playwright test tests/browser/issue-196-grading-presets.spec.ts \
  tests/browser/issue-197-effects.spec.ts \
  --grep 'a LUT preset|real IndexedDB migration|local presets capture|preset corruption'

# Repeat these cases in an unchanged checkout of 368bd43 for the baseline.
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
npx playwright test tests/browser/command-palette-accessibility.spec.ts \
  tests/browser/issue-188-ramped-audio.spec.ts tests/browser/media-file-drop.spec.ts \
  tests/browser/project-setup-overflow.spec.ts
```

The checked-in Playwright configuration uses one headless, muted Chromium worker,
no retries and a local Vite server. Gate 3's timing test can be reproduced
separately with `npx playwright test tests/browser/issue-196-grading-proof.spec.ts`;
keep production source fixed throughout a timing run. This report completes local
implementation and acceptance. It does not claim publication or a ready PR.
