# Media Pool Thumbnail Cards Design

**Date:** 2026-07-11
**Status:** Approved for implementation

## Goal

Improve the Media Pool's visual hierarchy and make imported videos easier to
recognize. Replace the browser-native file input with a compact panel header
and render each asset as a horizontal card with a representative video
thumbnail, filename, and existing metadata.

## Scope

This is a UI-layer change. It may update the MediaPool component, its UI tests,
and the media-pool styles in the app stylesheet. It must not add another media
decoder, change the media store shape, or change the filmstrip generator.

The existing `mediaStore.visuals` filmstrip is the thumbnail source. The first
filmstrip tile is an early representative frame sampled by the current visual
generation pipeline; it is intentionally not required to be the exact first
video frame.

## Interface

The panel begins with a compact header:

- `Media` title on the left.
- Styled `Import` button on the right.
- A visually hidden file input retains the current accepted video formats and
  permits re-importing the same file after selection.

Imported assets appear as compact horizontal cards sized for the existing
280-pixel panel:

- A roughly 88 by 50 pixel thumbnail area on the left.
- Filename and resolution/timecode metadata in the middle.
- A small remove control at the top-right.
- Subtle border, hover, and draggable-ready states that match WebCut's dark UI.

Long filenames stay on one line and truncate with an ellipsis. The full name
remains available through the existing title text. Cards keep their current
drag source behavior and become draggable only after duration metadata is
ready.

## Thumbnail States

When a video filmstrip exists, the thumbnail area displays only its first tile
by using the stored filmstrip URL and CSS cropping. The image keeps its aspect
ratio and is contained within a dark thumbnail surface.

Before visual generation completes, or when it produces no filmstrip, the card
shows a neutral video placeholder. Thumbnail absence is presentation-only and
must not affect importing, dragging, removing, or timeline insertion.

## Data Flow and Boundaries

`MediaPool` reads both `assets` and `visuals` from `useMediaStore`. For each
asset it looks up `visuals.get(asset.id)?.filmstrip` and derives the card's
thumbnail presentation. It does not import pipeline, worker, or engine code.

The existing flow remains unchanged:

1. Import registers a placeholder asset.
2. Existing controllers demux metadata and generate the filmstrip in the
   background.
3. `mediaStore.setAssetVisuals` publishes the filmstrip URL.
4. The matching card re-renders from placeholder to thumbnail.

The media store continues to own and revoke all object URLs.

## Accessibility and Interaction

- The import control has a clear accessible name.
- The remove control keeps its asset-specific accessible label.
- Thumbnail imagery is decorative because the filename provides the asset's
  identity.
- Import, remove, and drag events remain independent so clicking remove never
  starts a drag.

## Verification

Component tests will establish:

- A filmstrip URL produces a thumbnail for the matching asset.
- An asset without a filmstrip displays the placeholder.
- Existing ready-versus-analyzing draggable behavior remains intact.
- Existing filename, metadata, drag payload, import, and remove contracts are
  preserved.

The focused component tests, full test suite, production build, and lint must
pass. A real-browser pass with an imported video must confirm the placeholder
transitions to a representative thumbnail, the card fits the narrow panel,
the console stays clean, and the card still drags to a compatible timeline
lane.

## Non-goals

- Exact-first-frame decoding.
- New thumbnail persistence or project serialization.
- Grid/list view switching, asset search, sorting, folders, bins, or selection.
- Audio waveform thumbnails in the Media Pool.
- Changes to timeline filmstrip rendering.
