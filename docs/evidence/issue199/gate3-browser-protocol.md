# Issue 199 — requested observable protocol

Status: proposed for the supervisor's review after the containing source commit.
No browser/heavy/performance slot is currently granted. Do not run this protocol
until the supervisor approves its scope and exclusive slot. Browser plugin not
available in this session; use regular Playwright with muted headless Chromium
under the existing task rule, issue port5199, private worktree dependencies and
no external windows or audible output. This is a protocol, not passing evidence.

Target flow: open the lazy Animation dock from Timeline/Inspector, author and
navigate scalar/title/held-path keys across owners, perform one undoable edit or
cancel, and return to the same timeline without losing project or viewport truth.

## Observable UI pass

- Pin clean source SHA, fixture hashes, Node/Chromium/macOS versions and browser
  renderer/features. Record1440×900 and720×900 viewports. Load the production
  build and capture network requests before/after first opening Animation;
  verify workspace/index/curve code is absent until first use. Preserve console
  errors and warnings, including unsuccessful attempts.
- Use silent project fixtures containing ordinary video/clip audio gain/balance,
  an adjustment scalar effect, expanded-title element keys, supported held paths,
  and unknown/versioned/orphan lanes. Verify the current title-effect guard as
  unavailable; change that expectation only after #200's helper is accepted and
  integrated. Do not claim title-effect parity on this source.
- Check full sequence and selected/animated/kind/text filters; navigate first,
  last, previous/next, Shift ranges and Ctrl/Cmd toggles. Inspect exact active
  descendant and accessible names after scrolling focus out of the virtual row
  window. Reach a negative local key and a key beyond clip duration numerically.
- Create at playhead; edit scalar value and outgoing Hold/Linear/Bézier; test
  numeric invalid frame/value/easing reset without focus loss. Switch sheet/curve,
  fit/reset/pan/zoom both axes, and inspect hold discontinuities. At both viewports
  ensure controls, mapping, status and scrollbars remain reachable without
  document-level horizontal overflow.
- Use native mouse/pointer APIs for captured key and Bézier drags. Assert no
  history before release, exactly one on release; cancel with Escape, lost
  capture, close, selection/document change, viewport change and playback. Check
  sibling named previews restore and selected ghosts remain within glyph budget.
- Copy/cut/paste relative and original time across clip/title/adjustment owners;
  map every source lane explicitly, preserving global spacing and local ticks.
  Refuse incomplete/incompatible mapping, overwrite collisions, future numeric
  editing and locked edits without project/history/clipboard replacement.
- Exercise native text selection, Ctrl/Cmd+A/C/V/Z in an input, IME composition,
  and Enter/Space on buttons while global editor shortcuts are mounted. Commands
  must never accidentally delete/split selected clips. Keyboard key operations
  must remain within Animation.
- Save/reopen through actual portable project APIs, verifying authored key
  addresses/values/easing/source ticks and unknown payloads survive. Undo/redo
  after mixed edits, close/reopen the dock, switch sequence and replace project.
  Capture screenshots and actual DOM/console results after settled frames.

## Large-document and timing pass (exclusive slot)

Use deterministic100,000-key fixtures, a1,024-key lane,1,280 effect lanes in one
clip, many nonanimated owners, dormant keys and far global origins. Assert at
most40 mounted rows,512 glyphs including preview ghosts and256 scalar samples
through scrolling/zoom/selection/drag. Confirm exact last-key access and no key
index rebuild across playhead ticks. Count indexed reads independently where
possible; retain raw cold first-open/index and warm filter/scroll/preview/commit
measurements with fixture/browser/source provenance. Hard structural bounds are
acceptance requirements; timing numbers are observations until reviewed against
the approved issue performance budget. Do not derive browser performance from
Vitest durations or call retained payload accounting measured heap usage.

## Later mixed-feature gate

After required #198/#200 integrations, Gate4 separately covers rendering parity,
retime/split/source intent, muted playback, actual export/reopen pixel and PCM
oracles and saved project behavior. Exact codec/tolerances must be declared
before comparison. Gate5 retains full canonical tests, build/lint, production
audit and final exact-head checks. The supervisor decides whether to combine
slots or request additional bounded browser flows after source review.
