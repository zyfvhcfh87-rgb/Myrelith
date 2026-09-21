# Issue #208 — Firefox and Safari capability inventory

Status: inventory slice implemented. Not a public support claim.
Issue: https://github.com/zyfvhcfh87-rgb/Myrelith/issues/208

## This slice

Record live capability facts for a bounded desktop Firefox and Safari 26 path.
Chromium stays the advertised product. There is no WebCodecs polyfill, no
server fallback, and no README support change until a later live gate for the
named engines actually passes.

The inventory lives in `src/dev/issue208/` and is imported only by
`scripts/issue208/compatibility-inventory-gate.html`. Decisions use capability
facts, never a user-agent string.

## What it records

- WebCodecs constructors plus `isConfigSupported` and one-frame native
  encode/decode round trips for AVC, VP9, AV1, HEVC, Opus, and AAC
- Myrelith's existing Mediabunny `canEncode` and `freshEncode` probes for
  Compatibility, Web, Modern, and HEVC
- OffscreenCanvas 2D, `transferControlToOffscreen`, and a module dedicated worker
- AudioContext construct and resume from the Run-inventory gesture
- IndexedDB, Cache Storage, OPFS `getDirectory` / `createWritable`
- File System Access pickers through the existing app owners
- Worker WebGL2
- Plugin srcdoc sandbox, `wasm-unsafe-eval`, opaque origin, and negative
  network/storage/OPFS/DOM probes

Pickers, Recents, live save, folder PNG output, OPFS caches, worker WebGL2, and
plugin isolation stay optional. Missing ones are recorded as disabled, not
polyfilled.

A core `go` means the portable editor envelope is present on that engine: full
WebCodecs constructors, worker decode, OffscreenCanvas transfer, AudioContext,
and at least one honest download profile. It is not permission to advertise
Firefox or Safari.

## How to run

```bash
npm run qa:issue208:inventory -- --channel chromium
npm run qa:issue208:inventory -- --channel firefox
```

Safari 26+ is a macOS manual run of the same HTML. Playwright Linux WebKit is
not Safari and the runner refuses that channel.

Headless Firefox can stall if the runner clicks before the gate module is
Ready, if `AudioContext.resume()` never settles after the click, or if a
native encode probe hangs. The runner waits for Ready. The gate bounds
resume/close, skips round-trips when `isConfigSupported` is false, aborts
stuck encoders, drains a timed-out probe before the next codec starts, and
does not post a transferred OffscreenCanvas into the worker. Those bounds
are for evidence collection. They are not a Firefox product claim.

## Not in this slice

- Portable-core workflow gate (import/edit/preview/save/export) in live Firefox
  or Safari
- Optional-feature UX copy audit beyond existing disabled controls
- Playwright Firefox in CI
- README/CHANGELOG browser-support edits
