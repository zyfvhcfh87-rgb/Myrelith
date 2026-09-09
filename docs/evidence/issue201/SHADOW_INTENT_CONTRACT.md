# Issue #201 explicit caption shadow intent

Date: 2026-09-08. **Narrow pure contract for review before schema24, app or
painter integration.** No legacy rendering implementation changed.

The earlier ASS foundation incorrectly described minimal as a no-shadow preset.
Correction commit8ae2d74 preserves that finding: `captionPaintFor` sets
`shadowEnabled: !boxed`, so both classic and minimal enable a legacy shadow.
Selecting minimal or adding a style object cannot represent ASS Shadow=0 by
itself. This contract removes that implicit assumption.

## Explicit optional boolean

Add `shadowEnabled` to the closed partial v1 caption style descriptor. It follows
the same exact boolean validation, descriptor/aggregate budgets, unknown-version
and whole-unknown-override rules as other fields. This is an amendment to the
unreleased contract; no persisted caption style schema has been enabled yet.
No shadow color, blur or offset controls are added.

The future resolver must obey these rules:

- No descriptor, an empty descriptor, or a descriptor omitting shadowEnabled
  inherits the selected preset's enablement. Merely entering custom layout must
  not switch shadow off. All historical preset inputs remain unchanged.
- Explicit track shadowEnabled overrides the preset; explicit cue shadowEnabled
  overrides the track. Cue omission inherits track/preset normally.
- Preserve the selected legacy preset's shadow color, blur and X/Y offsets.
  Only the enablement flag is new semantic intent. Even boxed's inactive legacy
  shadow parameters must be preserved if enablement is explicitly turned on.
- An unavailable descriptor is ignored as a whole with an unavailable report;
  apparently known shadow fields inside it must not partly apply. Existing
  preview fallback and burned-in export rejection policy remains required.

Pure ASS import now stores `shadowEnabled: false` in its complete track style,
including when an unsupported nonzero ASS shadow was explicitly reported as a
loss. Supported per-cue styles inherit that explicit false. Full resolved ASS
export requires this field just like its other complete style fields. The
supported output writes Shadow=0, then full semantic reimport detects and reports
any track/cue true→false change. A missing value is not silently treated as false.

## Preset anchors and later integration gate

`captionPresetBaseline.test.ts` freezes complete legacy paint inputs for classic,
minimal and boxed at 1920×1080, plus the existing eight-caption stack layout.
It checks actual shadow flags, colors, blur, offsets, font/box/padding, placement,
transform and visual inputs. These are paint-input goldens, not browser pixels.
They were captured before a custom-style resolver exists; later resolver tests
must preserve these baselines for no/empty overrides and prove explicit shadow
changes affect only the resolved contract. Real preview/export parity remains
an additional browser gate.

Schema22/23 checkpoint4340f9675ad56aa320f2498cf107fd55f8819568 was merged into this
worktree without conflicts at f94d3ac. The existing 158 focused caption tests,
build/typecheck and lint passed afterward. This shadow proposal then passes
**8 focused files / 165 Vitest tests**, build/typecheck and lint. The existing Vite
large-chunk advisory remains. No full suite or new native speech run was used.

After review, schema24 may add the bounded optional style/origin fields with
whole-project IDs/intent bytes, complete-file validation, retained-history and
stale-safe atomic admission. App review/download and painter/UI wiring retain
their following gates. The local speech composite remains a separate source
contract; neither this style change nor the schema merge grants inference.
