# Issue #204 — image-sequence, audio-only, alpha, and chapter delivery

Status: implemented on `cursor/issue-204-alternative-delivery-bac0`.
Issue: https://github.com/zyfvhcfh87-rgb/Myrelith/issues/204

## Outcome

Add typed alternative delivery products next to unchanged MP4/WebM
`ExportProfile` contracts: PNG image sequences, WAV/PCM audio-only (then
proven compressed audio), alpha WebM only after an encode/decode round-trip,
and honest chapter sidecar JSON because Mediabunny muxers do not write
chapters.

## Product decisions

- Classic `ExportProfile` exact keys stay unchanged. New products are a tagged
  `DeliveryProfile` union in `domain/deliveryProduct.ts`.
- PNG sequences cover `[startFrame, endFrame)` with names
  `{prefix}_{zeroPad(absoluteFrame)}.png`. Pad width is
  `max(5, String(endFrame-1).length)`. Composite background is transparent.
  Download is ZIP STORE. Folder destination uses `showDirectoryPicker`.
  Overwrite is explicit. Cancel/quota report partial completion and keep
  written files.
- Audio-only WAV/PCM is first and uses the document sample rate/channels with
  no video track. AAC-in-M4A and Opus-in-WebM are explicit pairs after a
  capability probe. Range exports still pre-roll the mixer from frame 0.
- Alpha video is WebM + VP9 or AV1 only, offered after a real mux/reopen
  proof. `canEncodeVideo` forces `alpha:'discard'` and is not sufficient.
- Chapters are never claimed as container metadata. Sidecar JSON stores
  integer frames plus `framesToMicroseconds`. File destination + sidecar is
  rejected. Download + sidecar is a ZIP. PNG folders may write
  `{name}.chapters.json`.
- Render jobs store `profile: ExportProfile | DeliveryProfile` and optional
  `chapters`. Missing `chapters` on old records parses as `{ mode: 'off' }`.

## Verification

Focused domain/pipeline/controller/UI tests, production `npm run build`,
`npm run lint`, `git diff --check`, and muted Chromium flows for PNG range
names + sidecar JSON, WAV without a video track, alpha offered only after
proof or an honest unavailable reason, and unchanged MP4.
