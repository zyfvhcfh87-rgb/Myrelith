# Changelog

All notable release changes are recorded here. WebCut follows semantic version
labels while it is experimental; prerelease APIs and project behavior may
still change.

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

[0.1.0-alpha.1]: https://github.com/zyfvhcfh87-rgb/WebCut/releases/tag/v0.1.0-alpha.1
