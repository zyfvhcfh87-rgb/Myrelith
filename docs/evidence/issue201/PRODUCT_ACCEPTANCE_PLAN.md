# Issue 201 product acceptance checkpoint

Status: source implemented, browser/build unexecuted. Supervisor owns the exclusive
runtime slot and publication. This is the existing issue acceptance step, not a
new model or runtime research gate.

## Source changes

The caption editor lazily opens local transcription. One connected original audio
source, English/French, 1–300 seconds and one insertion frame produce an editable
review. Native output with unavailable timing has no cue endpoints. Users may
edit, exclude or split text and enter manual timing. Apply uses CaptionEditSession
and one fresh portable edit, with source fingerprint and exact model provenance.

One dedicated worker uses the exact approved runtime09 native bytes and relocated
protocol. Source preparation copies at most4096frames/plane, canonical stereo
fold-down and streaming16kHz resampling; output/native PCM stays3.84MB with≤2MiB
scratch. Source-rate output is never retained whole. Resampled output uses floor
coverage; exact rational caption projection uses floor start/ceil end. Worker
ownership closes before the review is published and scheduler admission releases.

Actual Program start/restart, Source start/new Source selection and export await
cooperative retirement. Gesture-time audio unlock and current generation checks
remain. Missing acknowledgement rejects essential work while retaining analysis
admission; the app explicitly requests reload. Setup/preparation10s, native
load/inference120s, closing100ms; cancellation waits the remaining phase+100ms.

Model acquisition reads into one fixed exact-byte buffer, verifies the SHA, stages
Cache Storage then commits metadata with cancellation rollback. Removal and local
derived-data clearing include only the owned namespace. No speech worker/model
acquisition occurs before the user opens/starts these optional tools.

Cold app/runtime assets still require an app connection. Installing the model is
not an offline-ready claim. Digest-named runtime and hashed Vite assets have
immutable response headers; loaded-app offline acceptance requires those assets
to have been cached, with the model download blocked. Reopening requires served
app files, as already approved. No service worker or generic offline framework.

Root owns the factual additions to README.md, PRIVACY.md, public/privacy/index.html,
public/licenses/index.html and THIRD_PARTY_NOTICES.md in the integration checkout.

## Inert validation

- Latest combined focused run:185tests/13files passed, including baseline caption
  editor, actual affected playback/Source/export controllers, speech ownership,
  bounded reader, streaming stereo/filter/fractional coverage, short-frame math,
  resource-free review/Apply/Undo, relink/project cancellation and constructor failure.
- TypeScript and targeted oxlint passed. Native core/model inspector relocation
  preserves reviewed source bytes. No WASM/native model execution in these checks.
- Full production build and real browser qualification remain outstanding.

## Requested bounded execution sequence

1. Explicit exclusive build grant: run `npm run build` once on the committed source
   with DEVELOPER_DIR=/Library/Developer/CommandLineTools. No toolchain install,
   native compilation, model download, server or browser in this step. Check built
   files exclude laboratory/dev closures and retain exact native asset hashes;
   record build result/chunk paths before preparing the exact browser runner.
2. Freeze a single-purpose product runner and input hashes, then obtain the runtime
   grant. Serve the actual built dist at127.0.0.1:5201 with the checked-in static
   cache headers; Chromium151 muted/headless, one fresh owned persistent profile.
   Use existing qualified process/RSS monitor and fail-fast host bounds; no parallel
   media job/browser, no laptop awake helper. Keep partial evidence and process IDs.
3. Real visible product paths, no production test hooks or direct state injection:
   create project; import exact English/French fixtures and a derived48kHz stereo
   WAV through media input; install selected exact model and exercise fixed download
   URL with the pinned local bytes as the disclosed network fixture; model identity,
   no-model path, progress/cancel and cache removal verified through UI/cache facts.
4. Transcribe stereo English from a nonzero source window; review/edit/exclude,
   apply one track, Undo/Redo, Save/Open and verify portable caption provenance.
   Short speech covers untimed/manual timing. French remains explicitly French.
   A300s real selected range covers12windows without losing untimed text. No broad
   new codec/platform matrix or upstream decoder changes.
5. Cancel during preparation/inference, then retry after acknowledged cleanup;
   close the dialog/project/relink during a job; exercise Play/Source/export waiting
   through real controls. Validate late work cannot apply or start stale playback.
   Playback after complete review preserves text. Exported captions remain shared
   renderer output; root may reuse existing accepted caption renderer coverage.
6. With speech app assets warm, block model download and switch offline: fresh
   worker reuses exact cached model. Reopen with app serving and model downloads
   blocked, inspect unchanged provenance. Remove model, verify its namespace gone,
   and verify a no-model retry cannot create a worker/acquisition. No claim of a
   full offline application shell or physical native file-picker qualification.
7. Capture normal/narrow screenshots and keyboard focus, UI/errors/network evidence,
  100ms-cadence browser-tree RSS with the existing1GiB delta bound, final zero owned
   resources/cache and process/profile/port release. Independent release inspection
   before returning the slot. If a case fails, preserve exact failure and stop;
   fix source and request the next focused grant instead of broad repeated runs.
