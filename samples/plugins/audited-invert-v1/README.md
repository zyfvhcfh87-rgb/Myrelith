# Audited Invert v1 sample plugin

This directory contains Myrelith's deliberately small, human-installable sample
for the version-1 signed WebAssembly video-effect contract. It exists to prove
the end-to-end package, trust, parameter, preview/export, and cleanup path. It is
not built into Myrelith and it receives no trust shortcut.

## Behavior

- plugin id: `com.myrelith.sample.audited-invert`
- contribution: `plugin:com.myrelith.sample.audited-invert/invert`
- render export: `myrelith_effect_audited_invert`
- required permission: `myrelith.effect.video-frame.rgba8` version 1
- fixed imported memory: 1,025 pages
- parameter record: exactly `{"invert":true}` or `{"invert":false}`

When `invert` is true, the module replaces each straight-alpha RGBA8 pixel's
red, green, and blue bytes with `255 - byte` and leaves alpha unchanged. It
returns success code 0. When false, it leaves every byte unchanged and returns
identity code 1. Any other parameter bytes return failure code 2 without a
successful output.

The module uses no time, randomness, persistent state, migrations, passive data,
assets, functions or capabilities beyond the fixed imported memory. Equal input
pixels and canonical parameters therefore produce equal output bytes.

## Files and audit model

- `source/module.mjs` is the dependency-free authoritative Wasm source. Its
  named sections and opcodes deterministically emit the module bytes.
- `manifest.json` is the exact RFC 8785 canonical manifest stored in the package.
- `signature.json` is created once after independent source review. It contains
  only the public key, integrity table, fingerprint, and signature.
- `audited-invert-v1.myrelith-plugin` is the deterministic stored ZIP accepted by
  Myrelith's ordinary file-install path.
- `audit.json` records source and artifact SHA-256 values, public release
  identity, ABI constants, and exact behavior vectors.
- `verify.mjs` rebuilds and tests the source, reconstructs the package, and
  verifies every public release fact without a private key.

`signature.json`, `audit.json`, and the package are intentionally absent until
the unsigned source has passed independent review. A pre-review trial release
may be generated only outside the repository and is not the audited sample.

## Read-only verification

Before the one-time release exists:

```powershell
node samples/plugins/audited-invert-v1/verify.mjs --source-check
```

After the reviewed release is frozen:

```powershell
node samples/plugins/audited-invert-v1/verify.mjs --check
npm test -- src/test/plugins/auditedSamplePluginArtifact.test.ts
```

The verifier requires the committed manifest to equal its canonical source
byte-for-byte, regenerates the Wasm module, executes exact identity/failure/
inversion vectors in fresh fixed memories, verifies the Ed25519 signature and
package digest, reconstructs the ZIP with fixed entry order and metadata, and
compares the complete package bytes. It refuses partial release artifacts.

## One-time signing

After independent review accepts the unsigned generator, the release is created
once with:

```powershell
node samples/plugins/audited-invert-v1/verify.mjs --sign-once
```

That command refuses to overwrite any release artifact. It generates an
Ed25519 keypair in process memory, exports only the raw public key, signs the
reviewed manifest/module integrity envelope, and writes only the three public
artifacts. No seed, private key, PKCS#8 encoding, or recovery material is
exported or written.

The public key and signature are sufficient to verify this immutable release.
The private key is deliberately not retained, so a future sample version cannot
inherit signer continuity: it must use a new signer and Myrelith must require a
fresh explicit trust and permission decision.

A valid signature identifies the package bytes associated with one public key.
It does not certify publisher identity, privacy, code quality, or safety.

## Installation and browser acceptance

The committed `.myrelith-plugin` file must be selected through Myrelith's real
file input. The application must show its unknown signer fingerprint, package
digest, required frame permission, memory request, and failure policy. Nothing
may activate until the user explicitly trusts that signer and grants frame
access.

The Issue #77 Chromium gate later applies this contribution through the real
preview and export seams to one frozen RGBA fixture. It compares exact parameter
bytes, call order, and output hashes, then covers cancellation, retry, disable,
uninstall, project close, stale replies, page clearing, and terminal sandbox,
worker, port, queue, watchdog, and server cleanup. The sample never enters the
production application bundle.
