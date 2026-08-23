# Media Pool View Modes, Density, and Sorting Research

**Date:** 2026-08-22
**Status:** Research for issue drafting; no implementation approved by this note

## Recommendation

Add one Media Pool display system with three projections over the same asset
catalog:

1. **Thumbnail grid** — image-first cards with a one-line filename and a small
   status marker.
2. **Compact list** — one dense row per asset, without a thumbnail, retaining
   filename, kind, duration, and connection/compatibility state.
3. **Details** — a small thumbnail beside the filename and useful metadata,
   similar to the current card but substantially denser.

Make **Small / Medium / Large** a separate density control, and make sorting a
separate property/direction control. View, density, and sort should be
browser-local user preferences. They must not enter the portable project
schema, collection ordering, timeline history, or media-resource pipeline.

This is a well-established pattern in professional editors. The closest direct
precedent is DaVinci Resolve's Thumbnail, List, and hybrid Metadata views;
Premiere Pro similarly separates List and Icon presentation from icon sizing
and sorting.

The feature should reuse Myrelith's existing variable-height virtualizer,
stable asset IDs, first-filmstrip-tile presentation, filters, collections, and
visible-item scheduling. It must not create three catalog implementations or
decode thumbnails from React.

## First-party product research

### Professional editor precedents

| Product | First-party behavior | Relevance to Myrelith |
| --- | --- | --- |
| Adobe Premiere Pro | The Project panel has List, Icon, and Freeform views. List emphasizes metadata; Icon emphasizes thumbnails. A zoom slider is present in both documented panel layouts. [Adobe: Project panel views](https://helpx.adobe.com/premiere/desktop/get-started/customize-the-project-panel/customization-options-for-the-project-panel.html) | Confirms that presentation mode and thumbnail scale are independent controls. Freeform/storyboard layout is intentionally beyond this issue. |
| Adobe Premiere Pro | Icon view uses a zoom control and can sort by user order, the List-view sort, or metadata such as name and media type, ascending or descending. [Adobe: Icon view sizing and sorting](https://helpx.adobe.com/premiere/desktop/get-started/customize-the-project-panel/customize-icon-view-in-project-panel.html) | Supports a single sort projection shared across visual modes. Manual/user ordering is a separate durable feature and should not be smuggled into this issue. |
| DaVinci Resolve 20 | The Media Pool offers Thumbnail, List, and Metadata views. Metadata view deliberately combines a live thumbnail with a prominent metadata field, and each pane can have its own view settings. [Blackmagic Design: Resolve 20 Editor's Guide](https://documents.blackmagicdesign.com/UserManuals/DaVinci-Resolve-20-Editors-Guide.pdf) | This almost exactly matches the requested thumbnail-only, name-list, and small-thumbnail-plus-details choices. |
| Final Cut Pro | The browser supports Filmstrip and List views; filmstrip height and detail can be adjusted separately. It also supports configurable columns and metadata sorting/grouping. [Apple: browser views](https://support.apple.com/en-gb/guide/final-cut-pro/ver7ff5e14b9/mac), [Apple: browser sorting and grouping](https://support.apple.com/guide/final-cut-pro/sort-and-group-items-in-the-browser-ver53cadfb73/mac) | Reinforces view, scale/detail, and ordering as separate axes. |
| Avid Media Composer | Bins expose Text, Frame, and Script views. Text is a metadata table; Frame is visual; Script combines frames with text. Current guidance also carries Text-view sorting into Frame/Script views. [Avid: Media Composer 2025.x Editing Guide](https://resources.avid.com/SupportFiles/attach/Media_Composer/Media_Composer_v2025.x_Editing_Guide.pdf) | Confirms that the ordering should be shared when the presentation changes, rather than each mode quietly producing a different order. |

### Familiar operating-system precedents

- Finder provides Icon, List, Column, and Gallery views, lets users adjust icon
  size and grid spacing, and can retain a view for one folder or apply it as a
  default. [Apple: change Finder folder views](https://support.apple.com/en-au/guide/mac-help/mchldaafb302/mac)
- File Explorer offers multiple icon sizes plus List, Details, Tiles, and
  Content layouts. Microsoft documents keyboard access to both layout and sort
  controls. [Microsoft: File Explorer with a screen reader](https://support.microsoft.com/en-us/accessibility/windows/use-a-screen-reader-to-explore-and-navigate-file-explorer-in-windows)

These precedents make three Myrelith modes plus an independent size control
predictable without copying the full complexity of a desktop file manager.

### Accessibility and large-list guidance

- A WAI-ARIA grid is a composite widget with one page-tab stop and author-owned
  directional, Home/End, and Page Up/Page Down navigation. Layout grids need
  movement that agrees with the visible rows and columns. If virtualized rows
  are absent from the DOM, total and positional ARIA metadata must remain
  truthful. [W3C WAI-ARIA APG: Grid pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)
- APG notes that a listbox is not suitable when each option contains
  independently interactive controls. Myrelith's rows contain relink,
  collection, proxy, and remove actions, so retaining a grid-style composite is
  more appropriate than converting the Media Pool into a listbox. [W3C
  WAI-ARIA APG: Listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/)
- Windowing keeps the DOM bounded by rendering only a moving visible subset.
  Overscan reduces blank flashes, but excessive overscan gives back the
  performance benefit. [web.dev: Virtualize large lists](https://web.dev/articles/virtualize-long-lists-react-window)

APG is informative guidance, not a substitute for browser and screen-reader
verification.

## Current Myrelith truth

### Existing behavior to preserve

- `src/ui/MediaPool.tsx` builds one catalog from durable descriptors,
  connected assets, and compatibility state. Search, type/status filters,
  selected collection, and selected asset are currently transient React state.
- `src/ui/mediaPoolModel.ts` preserves descriptor/project insertion order,
  builds deterministic search/filter models, packs visual rows, and computes a
  variable-height overscanned window.
- `src/ui/useMediaPoolVirtualizer.ts` derives one, two, or three columns from
  the measured panel width, measures rendered rows, and exposes the visible IDs
  used to prioritize visual work.
- The Media Pool is already a `role="grid"` composite using stable asset IDs,
  `aria-activedescendant`, arrow/Home/End/Page navigation, and virtual-boundary
  focus recovery.
- `docs/HANDOFF.md` records a 500-source Chromium gate: the DOM stayed bounded,
  keyboard navigation reached item 500, exact search remained fast, and visible
  asset IDs continued to drive the background visual scheduler.
- Every mounted card alone subscribes to its `mediaStore` descriptor, asset,
  visual, and compatibility entries. Off-screen visual updates therefore do
  not repaint every row.
- Current secondary actions and diagnostics include offline relink,
  collection membership, proxy generation, compatibility details, partial
  import review, and remove. A new compact mode must not make any of these
  unreachable.

### Why the current view looks like a long block list

`buildMediaPoolItems()` marks every video item as expanded. The row planner
therefore isolates every video into a full-width estimated 230 px row, and the
card always renders its proxy and compatibility surfaces. The responsive
multi-column grid is used primarily for ordinary image/audio cards, not the
video-heavy pool shown in the supplied screenshot.

The implementation should separate **catalog presentation** from **secondary
details**. A practical contract is one selected/explicitly opened detail
surface at a time. Unselected assets remain compact in every mode, while the
selected asset can expose the complete existing relink/organize/proxy/
compatibility/remove controls in a measured full-width detail row. This reuses
the current variable-height planner without forcing all videos to remain tall.

### Existing sort data

`PortableAssetDescriptor` already provides the sortable facts below:

- project/insertion position (the existing descriptor array/Map order),
- `fileName`,
- `kind`,
- `durationMicroseconds`,
- source `lastModified`,
- source `size`,
- dimensions and audio facts for deterministic tie-breaks if needed.

There is no authored **date imported** field. Calling `lastModified` an import
date would be incorrect. Adding an import timestamp would change portable
project data and needs a separately justified migration.

Compatibility and connection status are session/runtime facts. Sorting by
status can make cards jump while imports or checks settle, so the first issue
should keep status as the existing filter/badge rather than a primary sort.

### Existing preference boundary

`src/state/preferencesStore.ts` owns small serializable preferences without
browser APIs. `src/app/preferencesController.ts` hydrates/version-persists them
to local storage and safely falls back to in-memory defaults when storage is
missing or throws. Media Pool view settings fit this boundary; they do not
belong in `ProjectFileV5` or collection history.

## Proposed issue contract

### Controls

Place a compact view toolbar near the result count, after search/type/status
filters:

- View: **Thumbnail grid / Compact list / Details**.
- Size: **Small / Medium / Large**.
- Sort property: **Project order / Name / Type / Duration / File modified /
  File size**.
- Sort direction: one adjacent ascending/descending toggle whose accessible
  label names the active property and direction.

The mode control should have visible selected state, accessible names, and
keyboard operation. Icon-only buttons need tooltips in addition to their
accessible names. Size is a discrete three-value choice rather than a
continuous slider because it is easier to persist, test, and keep aligned with
virtual-row measurements.

### Mode definitions

#### Thumbnail grid

- Responsive poster cards using the current representative visual.
- Always retain a truncated one-line filename below the poster. A literally
  unlabeled wall of images is ambiguous for similar takes and weak for
  accessibility; Premiere, Resolve, Avid, and Finder all retain item identity
  in their visual views.
- Show a compact media-kind/connection/problem indicator without the full
  diagnostics block.
- Large size reduces column count instead of squeezing cards below the chosen
  minimum.

#### Compact list

- One column, no poster thumbnail.
- One row exposes filename, kind, duration, and a concise connection/
  compatibility state.
- The selected/open row exposes the full existing secondary actions and
  diagnostics in a measured detail row.

#### Details

- One column at narrow panel widths; more columns are permissible only when
  the responsive layout and keyboard model agree.
- Small thumbnail plus filename, dimensions/sample quality, duration, and
  state.
- The selected/open row uses the same complete detail surface as the other
  modes; behavior must not fork per presentation.

### Sorting semantics

Sorting is a pure projection after collection membership and the existing
search/type/status filters, before virtual-row planning:

`catalog -> collection -> filters -> stable sort -> view row plan -> virtual window`

- **Project order** preserves current durable descriptor order and is the
  default.
- All other sorts are stable and deterministic. Equal primary values fall back
  to case-folded filename, then original project position, then stable asset ID.
- Direction changes only the primary ordering contract; it must not mutate the
  descriptor Map, project assets, collection membership/order, or undo history.
- Changing view or size never changes order. Changing sort never changes view.
- Preserve selection by asset ID. After a layout/sort change, ensure the
  selected asset is rendered and visible rather than silently selecting a
  different item.

Manual drag ordering and Premiere-style Freeform/storyboard layout are explicit
non-goals. Media-card drag already means timeline insertion or collection
organization, while durable manual order would require new project semantics,
validation, undo, migration, and drag-disambiguation work.

### Persistence

Persist a validated value such as:

```ts
interface MediaPoolViewPreference {
  mode: 'thumbnail' | 'compact-list' | 'details'
  size: 'small' | 'medium' | 'large'
  sortBy: 'project-order' | 'name' | 'kind' | 'duration' | 'last-modified' | 'size'
  sortDirection: 'ascending' | 'descending'
}
```

Use the existing architecture split: browser-free validation/state in
`state/preferencesStore.ts`, browser persistence in
`app/preferencesController.ts`. A separate versioned storage key such as
`myrelith.media-pool-view:v1` keeps this preference independently recoverable.
Malformed or unavailable storage falls back to **Details / Medium / Project
order / Ascending** without disabling the controls.

Search text, type/status filters, selected collection, selected asset, scroll
position, and open details remain session-only for this issue.

## Architecture and implementation seams

1. Add browser-free view/sort preference types, validators, and stable
   comparison/layout helpers. `ui/mediaPoolModel.ts` is the current home for
   pure Media Pool presentation math; durable project/domain semantics are not
   required.
2. Extend `preferencesStore` and `preferencesController` with validated,
   versioned local persistence and safe legacy/default behavior.
3. Make row planning accept mode, size, and the one opened detail asset. Do not
   infer full-width expansion from `kind === 'video'`.
4. Derive CSS column count and keyboard column count from one pure layout
   result. Do not let CSS `auto-fill` disagree with ArrowUp/ArrowDown math.
5. Include mode/size in measured-row cache keys, or explicitly invalidate
   measurements on layout changes. Reusing a 230 px measurement after switching
   to a 36 px list row will corrupt spacer geometry.
6. Keep `MediaPoolItemCard` keyed by stable asset ID and keep per-card store
   subscriptions limited to mounted cards.
7. Continue sending only visible IDs through
   `setMediaVisualPoolViewport()`. View changes may change which IDs are
   visible, but not the scheduler's ownership or priority contract.
8. UI code continues to read state and call app facades. It must not import a
   decoder, pipeline, worker, or engine.

## Thumbnail-quality and ownership risk

The current timed-video filmstrip is optimized for 44 px-high timeline tiles.
Its first tile is acceptable for today's roughly 88 x 50 card, but a genuinely
large poster will upscale it and may look visibly soft. Still-image thumbnails,
by contrast, are already bounded up to 320 px wide.

Do not solve this by increasing the height of every tile in the up-to-48-tile
filmstrip: that multiplies joined-canvas area, encoded bytes, decode/draw work,
and retained object-URL memory for every connected video.

The implementation gate should be:

- first browser-check Small/Medium/Large using the current tile;
- if Large is visibly soft at its accepted CSS size, add one separately bounded
  representative poster (for example, up to 320 x 180) to the existing visual
  generation job;
- reuse an already decoded representative frame where the pipeline safely
  permits it, close the frame in the existing owner, publish only the Blob URL
  through `mediaStore`, and make `mediaStore` revoke it on replacement/removal/
  reset;
- never decode from `MediaPool.tsx`, create a decoder per mounted card, or
  eagerly generate posters for off-screen assets.

This source-quality decision needs real-browser evidence before the issue can
claim that Large is complete.

## Accessibility acceptance criteria

- The view group, size choice, sort property, and direction control have clear
  visible labels or accessible names, visible focus, and programmatically
  exposed current values.
- The Media Pool retains one predictable page-tab stop for grid navigation.
  Left/Right and Up/Down follow the actual computed columns in Thumbnail view;
  Compact list uses one column. Home, End, Page Up, and Page Down remain
  functional across virtual boundaries.
- Selection and focus stay on the same stable asset ID through mode, density,
  sort, resize, filtering, and virtualization changes whenever that asset still
  belongs to the result set.
- A screen-reader user hears filename, position/total, media kind, and concise
  connection/compatibility state without needing the decorative thumbnail.
- All existing row actions remain keyboard reachable in every mode. If grid
  navigation and nested controls use an enter/exit interaction, document and
  test the Enter/F2 and Escape behavior; do not trap arrow keys inside the row.
- If the virtual grid models absent rows, expose truthful total and positional
  metadata (`aria-rowcount`/`aria-rowindex`, and column equivalents where the
  semantic grid uses them). Never point `aria-activedescendant` at an unmounted
  element.
- Changing the view does not rely on color alone and does not cause an
  unexpected focus jump or modal announcement storm.

## Performance acceptance criteria

- A 500-item catalog remains windowed in all nine mode/size combinations. DOM
  count is bounded by viewport plus modest overscan, not total catalog size.
- Sorting/filtering is pure, deterministic, and measured with 500 sources;
  it does not subscribe every card to every visual update.
- Mode/size changes recalculate rows and spacers without rendering all assets.
- Visible scheduler IDs match the actual viewport after every mode/size/sort
  change; off-screen assets remain background priority.
- No new Blob URL, frame, bitmap, decoder, canvas, observer, or animation-frame
  callback survives replacement, removal, project reset, or component
  teardown.
- Narrow, normal, and wide Media panels have no page overflow. Large thumbnails
  reduce columns rather than overflowing or distorting media.

## Verification plan for the eventual implementation

### Pure and state tests

- Stable sort for every key/direction, null/equal values, case-folded names,
  and project-order tie-breaks.
- Collection then filter then sort ordering; source Maps/arrays remain
  unchanged.
- Column/row planning for every mode and size at boundary widths.
- Measurement invalidation when mode or density changes.
- Preference defaults, round-trip, corrupt/unknown values, unavailable storage,
  and legacy preference independence.

### Component tests

- Each mode renders its promised information and hides only presentation, not
  asset identity or functionality.
- Size changes affect layout independently from view mode.
- Sort direction and selected-state semantics are exposed accessibly.
- Focus/selection survives mode, size, sort, and a virtual boundary.
- Relink, organize, proxy, partial-import review, drag, and remove remain
  reachable in every mode.
- 500 assets keep mounted cards bounded; off-screen visual changes do not
  repaint the result set.

### Browser gate

- Source-bound video, audio, image, offline, limited/error, and proxy-capable
  assets exercise all three modes and all sizes.
- Verify keyboard navigation against the actual visual rows at narrow and wide
  Media-panel widths.
- Reload proves browser-local view/density/sort persistence without changing
  the saved project bytes.
- Large video posters are judged at actual CSS size; visible blur triggers the
  bounded poster path above rather than silently shipping poor quality.
- Import/relink/thumbnail/proxy controls still work, the scheduler/DOM remains
  bounded with 500 sources, and the console has no warnings/errors.

Run focused tests, the full Vitest suite, `npm run build`, `npm run lint`, the
production dependency audit, diff checks, and the clean Chromium gate required
by the repository's working agreement.

## Explicit non-goals

- Freeform/storyboard placement.
- Manual drag-to-reorder and new project ordering semantics.
- New bins, collection semantics, grouping, tags, ratings, or smart bins.
- Hover scrubbing, poster-frame selection, source preview playback, or new
  timeline behavior.
- Persisting search/filter/selection/scroll state.
- A general metadata-column editor.
- Eager higher-resolution regeneration of every filmstrip tile.
- Any cloud, analytics, telemetry, or remote media behavior.

## Source quality notes

- Adobe, Apple, Blackmagic Design, Avid, Microsoft, W3C, and Google web.dev are
  first-party sources for the behaviors attributed to them.
- The Resolve source is Blackmagic Design's official Resolve 20 Editor's Guide,
  not the exhaustive reference manual; it is sufficient for the view-mode
  precedent used here.
- WAI-ARIA APG is explicitly informative. Final semantics require live browser
  and assistive-technology verification.
