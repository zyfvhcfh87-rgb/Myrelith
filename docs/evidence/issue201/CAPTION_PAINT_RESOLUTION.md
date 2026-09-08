# Caption paint resolution source checkpoint

Track and cue overrides now feed the existing shared composition painter.
Supported cue fields override supported track fields; an unavailable descriptor
is ignored as a whole for preview and remains stored unchanged. Export checks
the same resolved pixel metrics over reachable caption intervals and refuses
unavailable appearance before playback drain, media or codec allocation.

The legacy `captionPaintFor` authority remains unchanged. Absent, empty and
effective no-op descriptors preserve its complete paint inputs across all three
presets, five landscape/portrait/odd-sized canvases and stacks of one to eight
cues. Equivalent opaque RGBA color spellings retain the legacy spelling.
Color, weight or shadow-enable changes alone do not move the boxes. Font changes
retain the preset's existing shadow color, blur and offsets.

## Explicit geometry contract

Positions anchor the **caption boxes**, not measured glyph bounds. Bottom keeps
the exact legacy placement equation; top and middle anchor the same full box
stack at the chosen edge or center. Index zero stays bottom-most. Text remains
top-aligned inside each box through the shared text painter. Horizontal margins
size the centered box; vertical margins inset the stack and can reduce its box
height. Mixed per-cue anchors can overlap; this is not collision avoidance.

The resolver never silently reduces an authored font or clamps unsupported
pixel metrics. A style that cannot fit its margin stack or the shared painter's
pixel limits produces a rendering reason and legacy preview fallback; export
blocks it. Text wrapping/line-box overflow remains a separate advisory.

This box-anchor policy is not an ASS/libass glyph-placement parity claim. The
pending ASS application flow must disclose the geometry difference, along with
any unrepresentable preset appearance, before import/export acceptance.

## Evidence and remaining work

Eight focused suites pass **176 tests**, including composition/painter coverage,
exact interval traversal, export allocation ordering, diagnostics/shared layout
and architecture guards. Production typecheck/build and lint pass; the existing
Vite large-chunk advisory remains. Initial test fixture/message/type errors are
retained in the evidence and were corrected without changing the shared painter.

This is source and fake-canvas evidence. No browser pixel, encoded export/reopen
or new authoring UI acceptance is claimed. The historical title schema fixture
pins remain untouched; the supervisor owns that separate integration correction.
Authoring controls, selected/mixed style editing, loss-reviewed ASS/plain-text
downloads, visible diagnostics and final browser acceptance are still pending.
Speech source and its runtime gate are unchanged.
