# Changelog

All notable release changes are recorded here. Myrelith follows semantic version
labels while it is experimental; prerelease APIs and project behavior may
still change.

## Unreleased

No changes recorded yet.

## [0.2.0-alpha.1] - 2026-08-23

**First Light** is the first prerelease published under the Myrelith name. It
rolls up the post-MVP work shipped since `v0.1.0-alpha.1`; the hosted preview at
[myrelith.pages.dev](https://myrelith.pages.dev) continues to track `master`.

### Added

- Full clip Inspector with transforms, crop, blend modes, color correction,
  masks, chroma key, and keyframed animation curves.
- Caption tracks with SRT/VTT import, timeline markers, snapping guides,
  constant-speed retiming, and speed ramps.
- Searchable virtualized Media Pool, collections, and optional OPFS editing
  proxies that never replace the original export source.
- Video stabilization, point and box tracking, and manual lens correction
  when a capable WebGL2 path is available.
- Adaptive preview quality, video scopes, playback audio meters, command
  palette, and workspace presets.
- Signed local plugin packages with review, enable/disable, and fail-closed
  preview and export.
- OS file drops through the existing compatibility flow, contextual Timeline
  and Media Pool menus, and list/grid Media Pool views with local sorting.

### Fixed

- New-project setup scrolls on shorter viewports so audio settings and Create
  stay reachable instead of sitting below a clipped frame.
- New-project setup switches to one column before its desktop grid can clip at
  intermediate viewport widths.
- Linked A/V partners outside the bounded timeline window now join live move,
  trim, ripple, slip, and slide previews before the edit commits atomically.
- Project replacement, plugin activation, preview-worker teardown, and audio
  channel-mixing races now preserve their current owners and settle cleanly.

### Changed

- Renamed the app, repository, package, container target, documentation, and
  public site from WebCut to Myrelith.
- New portable saves use `.myrelith`, the `myrelith-project` marker, and
  Myrelith-owned procedural text identifiers.

### Compatibility

- Existing `.webcut` files and `webcut-project` documents still open and are
  normalized without changing their timeline or media identity.
- Existing browser preferences and origin-local IndexedDB records remain
  readable after an in-place upgrade. Browser storage cannot cross from the
  previous public hostname to the new Myrelith hostname.

## [0.1.0-alpha.1] - 2026-08-01

### Added

- Complete browser-local MVP editing flow with portable `.webcut` projects,
  recent files, crash recovery, media relinking, timeline editing, inspector
  controls, linked A/V editing, and transition authoring.
- Capability-aware MP4/WebM export with explicit compatibility, web, modern,
  and HEVC profiles plus buffered or direct-to-file output.
- Content-probed video, audio, and still-image import with bounded local
  ProRes and AC-3/E-AC-3 decoder fallbacks.
- MIT project license, privacy notice, third-party notices, security and
  contribution policies, CI, and a self-hostable container package.

### Known limitations

- Desktop Chrome is the primary supported browser; Edge is verified, while
  Firefox and Safari are not yet verified.
- Codec availability varies by browser, operating system, and hardware.
- This is an experimental public preview, not a production-ready editor or a
  patent-clearance certification.

[Unreleased]: https://github.com/zyfvhcfh87-rgb/Myrelith/compare/v0.2.0-alpha.1...HEAD
[0.2.0-alpha.1]: https://github.com/zyfvhcfh87-rgb/Myrelith/compare/v0.1.0-alpha.1...v0.2.0-alpha.1
[0.1.0-alpha.1]: https://github.com/zyfvhcfh87-rgb/Myrelith/releases/tag/v0.1.0-alpha.1
