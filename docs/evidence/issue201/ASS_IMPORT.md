# Issue #201 semantic ASS import boundary

The pure `captionAss.ts` parser now returns `ready`, `review`, `needs-fonts` or
`rejected`; it owns no project state and never commits. It uses the already
reviewed ASS centisecond math and caption style descriptor. Schema 24, app/UI,
persistence, painter and retained-history admission remain separate work.

Supported v4+ input requires explicit resolution, complete duplicate-free style
and event formats, bounded styles and dialogue, and valid semantic caption text.
The importer preserves hard newlines, text commas, font/size/RGBA/outline,
bold/italic, alignment/margins and supported static prefix overrides. Defaults
live once on the proposed track; cues store only differing style fields. The
same caption collection validator enforces IDs, text, timing and eight-active-cue
overlap. Its extraction from `captionDocumentValidationError` preserves existing
document behavior and avoids fabricating a TimelineDoc merely to validate a file.

Imported styles use a complete override over the existing `minimal` preset,
which has no shadow. This preserves supported ASS Shadow=0 without adding a new
shadow field or altering legacy classic/boxed/minimal pixels. Raw ASS, attached
fonts, positions, animated effects or vector drawings never enter stored intent.
The parser does not claim pixel equivalence between Canvas and other renderers.

Named fonts require a caller-supplied explicit generic-family substitution and
remain a reported loss. Unsupported appearance returns a review proposal with
bounded diagnostics, never `ready`. Cases include layers/effects, asymmetric
margins, nonzero shadows, opaque boxes, unsupported style values, animation and
span tags, nonstandard wrapping/border-scaling/color-matrix behavior. Metadata
comments have informational reports. Draw-mode tags are rejected even inside
unsupported transforms, so drawing commands cannot become spoken text. Ambiguous
escapes, malformed braces/columns/headers/references/times and resource overflow
reject without exposing partial items. Only a future explicit loss-review action
may admit a `review` proposal.

The profile follows the primary [Aegisub ASS tag reference](https://aegisub.org/docs/latest/ass_tags/)
for hard/soft breaks, override scope and reset behavior, BGR colors/alpha,
numpad alignment and wrapping; the supported subset and all losses are explicit.
No existing SRT/VTT grammar or shared text painter was changed.

Validation: seven focused files / 119 Vitest tests and 17 repository runner
checks pass. Coverage includes all nine alignments, rational coverage, static
override/reset precedence, margins, named fonts, nested/span styling, vector
rejection, text/byte/style/tag/diagnostic bounds, duplicate identities and visible
overlap. Production build/typecheck and lint pass, with the existing Vite chunk
size advisory. No UI/browser or complete ASS export acceptance is claimed yet.
