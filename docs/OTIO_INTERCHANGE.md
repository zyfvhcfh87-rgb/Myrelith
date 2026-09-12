# OpenTimelineIO interchange

Pinned family: official **OTIO JSON 0.17.0**.

Myrelith reads and writes `.otio` JSON entirely in the browser. It never
runs Python adapters, shell commands, scripts, `.otioz` packages, or
`target_url` values.

## Schema subset

Supported `OTIO_SCHEMA` values:

- `Timeline.1`
- `Stack.1`
- `Track.1` (alias `Sequence.1`)
- `Clip.1` / `Clip.2`
- `Gap.1`
- `Transition.1` (`SMPTE_Dissolve` and dissolve-named transitions)
- `Marker.1` / `Marker.2`
- `RationalTime.1`
- `TimeRange.1`
- `ExternalReference.1`
- `MissingReference.1`
- `SerializableCollection.1`

Rejected before any project mutation: malformed JSON, documents over
8,000,000 characters or 200,000 objects, nesting deeper than 16, cyclic object
graphs, Adapter/HookScript/PluginManifest/SchemaDef/MediaLinker roots, and
executable `javascript:` / `data:` / `vbscript:` media URLs.

## Mapping

Import appends new sequences to the **open project**. Clip timing is converted
with integer frames and `RationalTime` snapped to the destination sequence
rate. The imported sequences must match the root canvas, frame rate, and
audio sample rate after that conform.

| OTIO | Myrelith |
|---|---|
| Timeline | Sequence |
| Video/audio Track | Video/audio track (video lanes first) |
| Clip + External/MissingReference | Clip + offline media descriptor |
| Gap | Empty timeline span (no clip) |
| Dissolve between touching clips | Video crossfade |
| Timeline/clip markers | Sequence markers |
| `source_range` | Clip source and timeline ranges |
| Null `source_range` | `available_range` start and duration |

Missing media uses incomplete identity (`size` 0 and `lastModified` 0) and
the existing Media Pool offline/relink flow. Relink matches basename plus
kind, then upgrades the catalog from the analyzed local file. Remote
`http(s)` URLs are not fetched; only the basename is kept, with a loss line.

## Disclosed losses

Every dropped or approximated construct is listed in the staged preview
(bounded to 48 lines). Typical losses include nested stacks/timelines,
generators, image sequences, effects, speed/time-warp maps, titles, captions,
multicam, adjustment layers, audio dissolves, clip-to-gap dissolves, disabled
tracks (imported hidden), and non-empty OTIO metadata.

Export writes Clip.2 plus `ExternalReference` `file://` basenames. Titles,
captions, nested sequence instances, and non-unity speed maps are omitted
with loss lines. Export does not claim lossless interchange outside this
subset.

## Transaction

Import is one undoable project edit. Portable snapshot validation runs before
stores change. Failure leaves the original sequences untouched. Undo restores
the previous sequences; offline pool items stay, matching ordinary media import.

## Fixtures

`tests/fixtures/otio/` holds official OpenTimelineIO 0.17.0 samples (Apache-2.0)
and a small Kdenlive-style cross-editor JSON file. See that README for names.
