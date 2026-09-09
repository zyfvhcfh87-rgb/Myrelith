# Third-party notices

Myrelith is MIT-licensed, but its built application includes third-party work
under other licenses. Those components remain governed by their own terms.

## Runtime JavaScript dependencies

| Component | Version | License | Source |
|---|---:|---|---|
| Mediabunny | 1.50.9 | MPL-2.0 | [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny/tree/v1.50.9) |
| `@mediabunny/ac3` | 1.50.9 | MPL-2.0 | [package source](https://github.com/Vanilagy/mediabunny/tree/v1.50.9/packages/ac3) |
| `@mediabunny/prores` | 1.50.9 | MPL-2.0 | [package source](https://github.com/Vanilagy/mediabunny/tree/v1.50.9/packages/prores) |
| Turbores | 1.2.2 | MPL-2.0 | [Vanilagy/turbores](https://github.com/Vanilagy/turbores) |
| React and React DOM | 19.2.7 | MIT | [facebook/react](https://github.com/facebook/react) |
| Immer | 11.1.9 | MIT | [immerjs/immer](https://github.com/immerjs/immer) |
| Zustand | 5.0.14 | MIT | [pmndrs/zustand](https://github.com/pmndrs/zustand) |

The complete dependency tree and exact integrity hashes are recorded in
`package-lock.json`. License texts shipped by installed packages are available
from npm and their linked source repositories.

## Optional local speech runtime and model

The speech worker uses whisper.cpp at commit
`371b5a7561823ab2bb32142d2751e35e7534727b` (MIT), built with Emscripten 6.0.8.
The reviewed adapter and build records are in
[`docs/evidence/issue201`](docs/evidence/issue201/MODEL_DECISION.md).
This native payload is pinned separately from npm dependencies.

The optional `ggml-tiny-q8_0.bin` model comes from `ggerganov/whisper.cpp` at
revision `5359861c739e955e79d9a303bcbc70fb988958b1`. It is 43,537,433 bytes with
SHA-256 `c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca`.
The model is downloaded or selected by the user, rather than bundled in the
application. The model card identifies MIT; the preserved OpenAI Whisper MIT
notice is included. The exact upstream conversion/quantizer revision is unknown.

The application ships the reviewed
[`runtime-notices.zip`](public/speech-runtime/runtime-notices.zip), also linked
from the transcription panel and public license page. It contains the
whisper.cpp and OpenAI Whisper notices, Emscripten license/authors, and the
included musl, libc++, libc++abi, compiler-rt, libunwind, llvm-libc, and dlmalloc
notices. Preserve these component notices when redistributing the runtime.

## FFmpeg-derived AC-3/E-AC-3 module

`@mediabunny/ac3` contains a WebAssembly module built from the FFmpeg AC-3 and
E-AC-3 codec implementation. The extension's package documentation records a
minimal FFmpeg configuration with only the required codec and utility modules
enabled, without GPL or nonfree flags. FFmpeg is licensed under the GNU Lesser
General Public License version 2.1 or later unless optional parts change that
license.

- [FFmpeg legal and license information](https://ffmpeg.org/legal.html)
- [FFmpeg source](https://ffmpeg.org/download.html#get-sources)
- [The extension's reproducible build instructions](https://github.com/Vanilagy/mediabunny/tree/v1.50.9/packages/ac3)

Codec patent rights are separate from copyright licenses and can vary by
country and use. This experimental prerelease is not a patent-clearance or
legal-compliance certification. If you redistribute Myrelith, review the exact
dependency sources and obligations for your distribution.
