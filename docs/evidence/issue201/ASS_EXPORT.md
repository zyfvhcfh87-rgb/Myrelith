# Issue #201 pure ASS export proposal

Date: 2026-09-08. Pure semantic boundary; no schema, renderer, UI or download
integration is claimed by this commit.

`planCaptionAssExport` extends the existing ASS authority and shares its bounded
reports, exact centisecond helper, style validator and import validation. It
returns `ready`, `review` with a proposed file and explicit losses, or `rejected`
without a partial file. A caller must require ready for strict export; review is
not permission to download. The eventual app review must own explicit acceptance.

## Resolved input and deterministic output

Input is the existing `CaptionAssProposal`: explicit script resolution, complete
known track style, optional supported cue overrides, semantic text and integer
ranges. This resolved interchange profile has no shadow and currently requires
`minimal` as the proposal's future preset selection. Correction: legacy minimal
itself does enable a shadow; its name is not proof of resolved ASS appearance. Partial track styles, other unresolved presets and unavailable
future descriptors reject. This avoids inventing legacy preset values before
schema24 and the shared style resolver exist. Future app wiring must resolve
every preset, including minimal, and report shadow/box/provenance/language/role losses; this
pure proposal has none of that project metadata and cannot qualify it.

Styles are flattened for serialization, deduplicated by their canonical field
values and sorted by code-unit order. The base is `Default`; other rows use
stable `Style001` names. Cues use existing stable frame/id ordering, unaffected
by input array or override key order. Colors encode inverted ASS alpha and BGR;
newlines use `\N`. Literal braces/backslashes, control characters and unpaired
surrogates reject with an explanation. Ordinary Unicode, emoji and commas remain
text. Source ids are not ASS fields and the input is never mutated.

## Exact semantic reimport and visible losses

Export searches bounded decimal spellings which reproduce normalized size and
outline values using the importer's exact arithmetic. Margins use bounded ASS
integer pixels. The entire generated file is then reimported, not just its time
strings. Every original style field is compared with its reconstructed value
using exact equality. Numeric quantization, inactive outline width/enablement,
background box/color and other differences become loss details. Unavailable
styles are never partly interpreted. This includes inactive intent: pixels that
look unchanged are not enough to claim semantic equality.

The existing time helper proves positive exact frame ranges or proposes outward
coverage with original/reimported frames in a loss report. Full file reimport
also checks the resulting overlap budget and stable text/frame ordering. Thus
individually representable expanded cues cannot silently create nine simultaneous
captions. Reimport failure rejects the entire proposal.

Exact supported semantic round-trip does not mean original file bytes, cue ids,
formatting or pixels in another ASS renderer. Existing SRT/VTT code is unchanged.
The parser's supported profile follows the previously reviewed
[Aegisub ASS tag reference](https://aegisub.org/docs/latest/ass_tags/).

## Bounds and validation

- Existing 20,000 cue, 4,000 per-cue and 2,000,000 total text limits; unique valid
  identities and whole-caption visible overlap validation before generation.
- At most 256 deduplicated styles and 2 MiB of input style intent. Project-wide
  retained/history and future origin validation remain app/schema work.
- Complete output, including headers, styles, escaping and line breaks, is capped
  at 2,000,000 characters / 4,000,000 UTF-8 bytes before joining the file.
- Reports retain 100 bounded details and exact counts; final rejection stays
  visible after the detail cap. Loss values precede long cue labels so truncation
  does not hide what changed.

Validation: **7 focused Vitest files / 158 tests**, including 26 new export tests;
**18 deterministic laboratory regressions**; build/typecheck and lint pass.
Vite reports its existing large-chunk advisory. Coverage includes 24/25/30/50/60
and NTSC rates, exact and expanded one-frame ranges, repeated styles, non-round
script dimensions, transparent colors, Unicode, unknown styles, full-file limits,
overlap rejection and diagnostic limits. A first test chose a representable NTSC
frame for a loss case; it was corrected to the nonrepresentable frame 3 at
60000/1001 without changing time arithmetic. A control-regex lint warning was
removed by checking character codes explicitly.

No observable production surface changes yet, so no browser/pixel acceptance is
claimed. Schema24, the preset/style resolver, project/currentness/history checks,
accessible review/download controls and independent renderer parity remain gated
work. Speech remains separately NO-GO after run04.
