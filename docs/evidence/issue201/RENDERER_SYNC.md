# Issue201: reviewed renderer sync and caption Gate3 baseline

Root explicitly authorized merging exacte6a64a7898111a2c230c57eee890832a74fb88b3
after the speech source-preparation checkpoint was clean. Source preparation763baed
and separate loader correctiond8a1ff4 were committed first. The merge completed
without conflicts at **a5ce1c3076303b806c78692601c70bc7e484d5aa**.

After sync,17 focused caption/render/architecture files passed279 tests. The
ordinary frontend typecheck/production build passed with the existing Vite large-
chunk advisory. This was not compilation of the prepared whisper.cpp toolchain.
No browser, native model, performance or full-suite run occurred.

The first whole-project lint exited0 but reported72 warnings from the raw pinned
Emscripten internal-settings evidence file, which its `.js` suffix caused lint to
interpret as application code. The evidence is now named `.js.txt`; its bytes and
SHA-256 are unchanged, and the asset manifest tracks that inert filename. The
original lint log is retained in`whispercpp-preparation/initial-project-lint.txt`.
Whole-project lint then passed without warnings. The read-only verifier again
passed all eight exact assets and23 evidence files. No upstream source text was
rewritten to silence lint.

The integrated architecture and #200 shared painter/cache ownership were read.
Gate3 caption authoring source is unblocked by root's instruction, but no new
caption painter/UI has been promoted in this checkpoint. The staged diagnostics/
export prototypes remain ignored preparation. Legacy text remains top aligned
inside the large preset box; custom geometry and no-op overrides must preserve
that explicit compatibility contract before claiming pixel equivalence.

Speech source review is distinct: current proposed adapter source isd8a1ff4,
with52 passing source/VM checks and the pinned-loader correction. Its compiled
guard, generated artifact, native memory/quality/offline/lifecycle and product
acceptance gates remain open. No WASM install/activation/build/instantiation/
inference is authorized by this sync.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run src/domain/caption*.test.ts src/domain/captions.test.ts src/app/caption*.test.ts src/state/captionStore.test.ts src/ui/CaptionEditor.test.tsx src/pipeline/render.test.ts src/test/architecture.test.ts --maxWorkers=2
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run build
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run lint
```
