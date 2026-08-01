# Third-party notices

WebCut is MIT-licensed, but its built application includes third-party work
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
legal-compliance certification. If you redistribute WebCut, review the exact
dependency sources and obligations for your distribution.
