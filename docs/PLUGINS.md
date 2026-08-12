# Sandboxed plugin capability and compatibility contract

Status: design for Issue #76. No third-party code is loaded, installed, or
executed by this change. Runtime implementation remains gated on Issue #77 and
an independent security/compatibility review of this document and
[PLUGIN_THREAT_MODEL.md](PLUGIN_THREAT_MODEL.md).

## Decision summary

The first plugin runtime must be deliberately small:

- packages are selected from local files and verified offline; a package or
  project cannot name a remote URL;
- a package contains a signed WebAssembly module, never executable plugin
  JavaScript;
- third-party code runs in a dedicated worker behind a host-authored broker in
  an opaque-origin sandboxed iframe;
- the WebAssembly module receives no browser or operating-system imports;
- the only first-implementation contribution is a host-rendered video effect;
- the only first-implementation permission exposes one bounded RGBA frame to
  that effect while it is enabled;
- project files retain only bounded, namespaced effect descriptors. They never
  contain package bytes, locations, signatures, trust decisions, grants,
  storage, or executable code;
- missing, incompatible, denied, revoked, crashed, or disabled plugins preserve
  their descriptors and are bypassed. Preview may continue with an explicit
  warning; export fails until the user explicitly chooses a reviewed bypass;
- safe mode starts the editor without initializing any third-party package.

This is not a general extension host. It is one capability with a reviewable
wire format and an intentionally narrow ambient-authority budget of zero.

## Trust boundary

```text
local package File
  -> bounded ZIP parser
  -> hashes + Ed25519 signature + local trust/revocation policy
  -> strict manifest validation + compatibility negotiation
  -> explicit permission decision
  -> host-authored opaque-origin iframe broker
  -> dedicated host-authored worker
  -> imported bounded WebAssembly memory + no function imports
  -> validated request/response copies
  -> shared Myrelith preview/export compositor
```

Only the first arrow may receive attacker-controlled package bytes. Every
following arrow validates a smaller representation. The app window never
evaluates package text, imports a package URL, or gives a plugin a DOM object,
`File`, `FileSystemHandle`, `Blob`, URL, `VideoFrame`, `ImageBitmap`,
`AudioData`, `MessagePort` to another subsystem, storage handle, or network
primitive.

The sandbox is defense in depth, not the sole authority boundary. Core
WebAssembly has no ambient access to its embedding environment; access exists
only through imports supplied by the embedder. The first ABI supplies bounded
memory and no callable imports. See the WebAssembly specification's
[security considerations](https://webassembly.github.io/spec/core/intro/introduction.html#security-considerations).

## Version-1 manifest

`src/domain/pluginManifest.ts` is the non-executing prototype authority. It
validates an already-parsed JSON value, rejects unknown fields, applies strict
bounds, and negotiates declared API/permission ranges. It performs no file I/O,
package parsing, signature verification, trust mutation, registration, or code
execution.

The package parser in Issue #77 must additionally enforce the 65,536-byte raw
manifest limit, UTF-8 without a byte-order mark, duplicate-key rejection before
`JSON.parse`, and canonical JSON rules. Those byte-level checks are intentionally
not pretended by this value-level prototype.

An accepted manifest has exactly these fields:

```json
{
  "schemaVersion": 1,
  "id": "com.example.sparkle",
  "name": "Sparkle",
  "version": "1.2.3",
  "api": {
    "minVersion": 1,
    "maxVersion": 1
  },
  "runtime": {
    "kind": "wasm",
    "entry": "runtime/sparkle.wasm",
    "memoryMaximumPages": 1025
  },
  "permissions": [
    {
      "id": "myrelith.effect.video-frame.rgba8",
      "minVersion": 1,
      "maxVersion": 1,
      "required": true
    }
  ],
  "contributions": [
    {
      "kind": "video-effect",
      "contributionVersion": 1,
      "id": "sparkle",
      "name": "Sparkle",
      "descriptorVersion": 1,
      "entrypoint": "myrelith_effect_sparkle",
      "migrations": [],
      "parameters": [
        {
          "key": "strength",
          "name": "Strength",
          "kind": "number",
          "default": 0.5,
          "min": 0,
          "max": 1,
          "step": 0.01,
          "animatable": true
        },
        {
          "key": "preserve-alpha",
          "name": "Preserve alpha",
          "kind": "boolean",
          "default": true
        },
        {
          "key": "mode",
          "name": "Mode",
          "kind": "enum",
          "default": "soft",
          "options": [
            { "value": "soft", "name": "Soft" },
            { "value": "hard", "name": "Hard" }
          ]
        }
      ]
    }
  ]
}
```

### Identity and namespaces

- `id` is a lowercase reverse-DNS identifier. It is identity, not proof of
  ownership. The verified signer key supplies continuity.
- `version` is strict semantic versioning for package updates.
- `schemaVersion` versions the manifest JSON shape.
- `api.minVersion` and `api.maxVersion` bound the host message/Wasm ABI.
- every permission independently declares an inclusive compatible version
  range and whether it is required;
- every contribution id and render `entrypoint` is unique within the package.
  The unique render export is the WebAssembly-call contribution discriminator,
  and no migration `entrypoint` may reuse any render export;
- `contributionVersion` versions that contribution point's host ABI;
- `descriptorVersion` versions that contribution's durable parameter schema;
- `migrations` declares at most 64 deterministic descriptor-version steps. Each
  exact `{ fromVersion, toVersion, entrypoint }` object names a reviewed Wasm
  export; declarations are sorted by `fromVersion`, move only forward, and every
  declared starting version must lead to the current `descriptorVersion`;
- a plugin effect's project type is
  `plugin:<plugin-id>/<contribution-id>`, for example
  `plugin:com.example.sparkle/sparkle`.

The namespaced type contains no package digest or location. A package update may
continue to own the same descriptor only when its signer identity, plugin id,
contribution id, and declared descriptor compatibility all match.

### Parameter schema

The host renders all controls. A plugin cannot contribute HTML, CSS, React,
icons containing active content, event handlers, or an iframe panel.

Version 1 supports bounded number, boolean, and enum parameters. Number
parameters carry a finite range, finite default, positive step, and explicit
animation eligibility. Every declared minimum, maximum, and default stays within
the shared durable effect magnitude of +/-1,000,000,000. Enum values are stable
machine ids with host-rendered labels. Parameter keys are unique within one
contribution; reserved durable-record keys such as `constructor`, `prototype`,
and `__proto__` are rejected. Current portable effect bounds remain authoritative
over the resulting descriptor.

String inputs, rich text, file pickers, URLs, colors, curves, arbitrary JSON,
and custom editors are not part of the first parameter schema.

## Package, integrity, signing, and trust

### Offline package format

The file extension is `.myrelith-plugin`. Its contents are a deterministic ZIP
subset with these required entries:

- `manifest.json` — canonical version-1 manifest;
- the one `.wasm` path named by `runtime.entry`;
- `signature.json` — signature envelope and complete integrity table.

Optional entries are passive localization text or raster assets declared by a
future manifest schema. They are not accepted by the first implementation.

The parser must reject encrypted entries, data descriptors whose final sizes
cannot be checked before allocation, ZIP64, symlinks, absolute paths, `.`/`..`,
backslashes, drive prefixes, NULs, duplicate names, Unicode/case-fold collisions,
overlapping byte ranges, trailing bytes, undeclared entries, and mismatched
compressed/uncompressed sizes. It must never extract to the user's filesystem.

Package budgets for the first implementation are:

| Resource | Limit |
| --- | ---: |
| Archive bytes | 32 MiB |
| Expanded bytes | 64 MiB |
| Entries | 256 |
| `manifest.json` | 64 KiB |
| `signature.json` | 64 KiB |
| WebAssembly module | 32 MiB |
| WebAssembly memory | 1,025 pages / 64 MiB + 64 KiB |
| WebAssembly tables | 16 total; 4,096 aggregate initial and maximum entries |

Every limit is checked before the corresponding allocation. Decompression
tracks the running expanded total and aborts on the first overflow.

### Signature envelope

`signature.json` has a separately versioned exact schema containing:

- algorithm `Ed25519`;
- the raw 32-byte public key encoded as unpadded base64url;
- a display fingerprint equal to base64url SHA-256 of that raw public key;
- sorted entries containing normalized path, exact byte length, and SHA-256;
- an Ed25519 signature over UTF-8 JSON Canonicalization Scheme bytes for
  `{ format, publicKey, entries }`.

The integrity table includes `manifest.json` and every entry except
`signature.json`; no unlisted file is legal. The package digest is SHA-256 of
the same canonical signed payload plus the signature bytes. Signature
verification must runtime-probe the browser's Web Crypto Ed25519 support and
fail closed when unavailable. Ed25519 is defined by the current
[Web Cryptography API](https://w3c.github.io/webcrypto/#ed25519-operations);
support is still treated as runtime fact rather than assumed.

Signing proves that package bytes match one key. It does not certify the human
publisher, code quality, privacy, or safety.

### Trust states

Installed package records are origin-local and keyed by plugin id, signer
fingerprint, package version, and package digest. Trust has these states:

- `built-in-trusted`: key shipped in the reviewed Myrelith release;
- `user-trusted`: the user approved the displayed signer fingerprint for this
  exact plugin id;
- `untrusted`: valid signature, but no trust decision;
- `invalid`: malformed package, integrity failure, invalid signature, or id/key
  continuity conflict;
- `revoked`: digest, signer, or plugin-id/key binding appears in the effective
  local revocation set.

Unsigned packages are inspectable diagnostics only and cannot be installed or
executed. Version 1 exposes no developer-mode override.

An update signed by the same trusted key retains publisher continuity but is a
new package digest. It must pass all validation again. New or widened permissions
require a new prompt. A signer change is a new trust decision and cannot inherit
grants. Downgrades require explicit confirmation and cannot silently replace a
newer compatible package.

Installation is transactional: verify into memory, show identity and requested
access, obtain trust/permission decisions, write staged bytes, atomically replace
the local registry, then release the old version. Cancellation or failure keeps
the previously installed package and grants unchanged.

### Revocation

Revocation is local-first. The effective deny set combines:

- digests and keys compiled into the installed Myrelith release;
- explicit local Disable/Uninstall decisions;
- optional offline revocation bundles signed by a Myrelith release key and
  imported by the user.

There is no automatic network lookup, telemetry, certificate-status request, or
remote kill switch. Opening a project cannot clear or weaken revocation. A
revoked plugin is never initialized; its project descriptors remain ordered and
serializable.

## Compatibility negotiation

Validation answers “is this manifest structurally safe to inspect?”
Negotiation answers “does this host understand its required contracts?” Trust
and permission consent are later, independent gates.

The host selects a version only when its exact API version is inside the
manifest's inclusive range. Each permission is selected independently. An
unavailable required permission makes the package incompatible. An unavailable
optional permission stays explicitly unavailable and is never substituted.

The first host profile is:

| Contract | Version |
| --- | ---: |
| Plugin host API | 1 |
| `myrelith.effect.video-frame.rgba8` | 1 |
| `video-effect` contribution | 1 |

No nearest-version fallback, polyfill, package rewrite, or “best effort”
selection is legal. Future host versions must retain old implementations or
report an actionable incompatibility.

Descriptor compatibility is separate from package compatibility:

1. the namespaced contribution must be installed and trusted;
2. the package/host API and permission contracts must negotiate;
3. when the versions differ, the contribution must have an exact declared
   `fromVersion` step and every following step must terminate at its current
   `descriptorVersion`;
4. before any migration export runs, the host rejects the whole migration when
   any entry in the owning clip's `ClipAnimation.effectTracks` targets that
   effect instance id;
5. each declared migration export runs in the sandbox against cloned canonical
   parameter bytes; no plugin code runs merely to discover a chain;
6. after every non-final step, the host accepts only the canonical bounded
   primitive parameter record defined by ABI version 1, then uses those exact
   validated bytes as the next step's input; it does not infer or claim to
   validate an absent historical contribution schema;
7. only the final step must exactly match the current contribution's
   `parameters` schema and pass the shared durable descriptor and whole-document
   replacement budgets before one deliberate history commit;
8. rejection retains the original descriptor and complete clip animation
   byte-for-byte at the JSON value level and leaves the descriptor bypassed.

Migration never runs merely because a project was opened. It requires an
explicit user action after package trust and permissions are satisfied. Version
1 descriptor migration is static-instance-only. Before the first migration
export can run, the host inspects the owning clip's complete
`ClipAnimation.effectTracks` list and rejects the whole chain if any entry's
`effectId` targets that instance. It does not treat currently in-range keyframe
values as proof of compatibility: a schema change may also change a parameter's
meaning or unit. Migrating animated effect parameters requires a future,
separately versioned contract that can transform those tracks. Version 1 may
change only the cloned static parameter record; effect identity, enabled state,
stack order, and the complete animation object stay host-owned and unchanged.

## First contribution: bounded video effect

### Permission meaning

`myrelith.effect.video-frame.rgba8` version 1 means:

- receive one complete, isolated, display-referred unpremultiplied RGBA8 layer
  after crop/transform and before clip opacity, transition weighting, and
  destination blending;
- mutate that same-sized RGBA8 buffer in place;
- receive exact integer timeline frame, exact rational document rate, project
  width/height, row stride, and bounded primitive parameters. Invocation of the
  manifest-unique render export identifies the contribution and its current
  descriptor schema without copying another selector into plugin memory;
- receive no lower/upper tracks, unrelated clips, source file bytes, filenames,
  paths, asset descriptors, audio, project name, project id, markers, captions,
  handles, URLs, clocks, randomness, storage, or network capability.

The permission prompt says that an enabled effect can read and change the pixels
of every frame to which the user applies it. It names the affected contributions,
signer fingerprint, package digest, memory limit, and failure policy. Denial
keeps the package inspectable/disabled and prompts only from an explicit user
action; playback, project open, recovery, and export cannot summon a prompt.

### Ordered composition

Plugin stages participate in the existing authored effect order. The pure domain
resolver emits declarative built-in and plugin stage facts. The shared
preview/export compositor executes those stages through an injected app-owned
sandbox facade. Domain code never imports a plugin runtime, and React never
imports the compositor or sandbox.

Any stack containing a ready plugin stage uses the explicit RGBA pixel path so
built-in color, mask, chroma, and plugin effects cannot be reordered or collapsed
across each other. The no-plugin and wholly bypassed paths retain their current
byte behavior.

### WebAssembly ABI version 1

Issue #77 must publish binary layout fixtures before execution is enabled. The
ABI contract is:

- the module imports exactly one non-shared memory named
  `myrelith.memory` and no functions, globals, tables, tags, or other memories;
- the module defines no additional memory. Its declared maximum is present and
  no greater than both the manifest request and the host's 1,025-page ceiling;
- canonical render parameters occupy at most 65,536 bytes. The host always
  reserves one complete 64 KiB page beyond the RGBA region. A smaller manifest
  memory request makes frames that do not fit unavailable with an explicit
  reason; the 1,025-page ceiling lets the legal 16,777,216-pixel maximum frame
  and its parameter block fit simultaneously;
- the module defines at most 16 internal tables. Every table declares a maximum,
  each table's maximum is at most 4,096 entries, and both the sum of all declared
  initial sizes and the sum of all declared maxima are at most 4,096 entries.
  The binary-policy parser checks these count and aggregate limits before
  compilation or instantiation;
- threads, shared memory, relaxed SIMD, component-model imports, WASI, and JS
  builtins are rejected;
- every contribution names a package-unique render entrypoint. Invoking that
  export is the contribution discriminator; no contribution-id string or numeric
  selector is copied into untrusted memory;
- each contribution render entrypoint is an exported function with signature
  `(i32, i32, i32, i32, i32, i32, i32, i32, i32, i32) -> i32`;
- arguments are pixel pointer, width, height, stride, frame low/high 32-bit
  words, frame-rate numerator/denominator, UTF-8 canonical-parameter pointer,
  and parameter byte length;
- the pixel region is exactly `stride * height` bytes, `stride` is exactly
  `width * 4`, and the ranges must be non-overlapping and inside imported
  memory;
- return `0` means success, `1` means deliberate identity/no-op, and every other
  value is a stable plugin failure code. Unknown codes are failures;
- descriptor migration ABI version 1 is static-instance-only. Before copying a
  migration input or invoking the first migration export, the host rejects the
  entire chain if any `ClipAnimation.effectTracks` entry on the owning clip
  targets the effect instance id. The host does not attempt key-range-only
  validation or reinterpret an existing curve under a changed schema or unit;
  animated migration requires a future, separately versioned contract;
- each declared migration entrypoint is an exported function with signature
  `(i32, i32, i32, i32, i32, i32) -> i32`. Its arguments are canonical input
  pointer/length, zeroed output pointer/capacity, and declared from/to versions;
  input and output are non-overlapping, each is capped at 65,536 bytes, a
  positive return is the exact output length, and zero or a negative value is a
  migration failure. A contribution with migrations must request at least two
  memory pages, and a migration export name must differ from every render export
  in the package;
- every step output, including a non-final output, must be strict UTF-8 JSON
  Canonicalization Scheme bytes for one object. The host rejects a byte-order
  mark, malformed UTF-8, duplicate keys before parse, or bytes that differ from
  the canonical re-encoding. The canonical byte length, including JSON syntax,
  is at most 65,536 bytes;
- the generic intermediate object has at most 64 own entries, matching the
  manifest-v1 parameter-count ceiling. Every key and string value must use the
  same 1-to-64-character ASCII local-identifier grammar as manifest parameter
  keys and enum values; keys also reject `__proto__`, `prototype`, and
  `constructor`. Every value is exactly a boolean, a finite number from
  -1,000,000,000 through 1,000,000,000 inclusive, or such a bounded identifier
  string. Nulls, arrays, and nested objects are rejected;
- the host applies that generic byte/shape/value validation after every step
  before invoking the next export. A non-final output is not checked against a
  historical parameter schema because version 1 manifests do not declare one.
  Only the final output must have exactly the current `parameters` keys and
  declared value kinds/ranges/options; the candidate descriptor must then pass
  the shared durable bounds, and its atomic document replacement must stay
  within 10,000 total effects, 50,000 total effect parameters, and 10,000,000
  total effect-string characters. No temporary intermediate record enters the
  document or history;
- migration calls carry no frame bytes and run one declared step at a time under
  the same watchdog;
- the host copies input into the bounded memory, invokes once, copies the exact
  byte range out, then clears every pixel, parameter, or migration input/output
  region before reuse;
- no pointer, view, buffer, or module instance crosses into Zustand, React, a
  project file, or another plugin instance.

The module binary must be parsed before instantiation to enforce imports,
exports, features, section counts/sizes, memory/table maxima, and entrypoint
types. `WebAssembly.validate()` alone is necessary but insufficient for policy.
The WebAssembly standard explicitly permits embedder resource limits and
module rejection; memory maxima are expressed in pages. See
[module memories](https://webassembly.github.io/spec/core/syntax/modules.html#memories)
and [implementation limits](https://webassembly.github.io/spec/core/appendix/implementation.html).

## Sandbox construction

The app creates a host-authored `iframe` with `sandbox="allow-scripts"` and
without `allow-same-origin`, navigation, forms, downloads, modals, pointer lock,
popups, or presentation tokens. Omitting `allow-same-origin` activates the HTML
sandboxed-origin flag; the HTML Standard documents that boundary in
[sandboxed browsing contexts](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing).

The iframe content is generated entirely by Myrelith and contains only a
hash/nonce-authorized broker. Its enforced CSP starts from:

```text
default-src 'none';
connect-src 'none';
img-src 'none';
media-src 'none';
font-src 'none';
style-src 'none';
object-src 'none';
frame-src 'none';
child-src 'none';
worker-src blob:;
script-src 'nonce-<host-generated>' 'wasm-unsafe-eval';
base-uri 'none';
form-action 'none';
```

The broker creates one dedicated worker from host-authored bytes and passes the
verified WebAssembly bytes and a private `MessagePort`. Package bytes are never
interpreted as JavaScript. CSP `worker-src` governs worker loads and
`connect-src` is the fallback for connection-like fetch destinations under the
[Content Security Policy specification](https://w3c.github.io/webappsec-csp/).

Issue #77 must run negative browser probes in every supported engine before
enabling plugins: `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, WebRTC,
service/shared workers, nested frames, navigation, popups, forms, downloads,
IndexedDB, Cache Storage, OPFS, and parent DOM access must all be absent or
blocked. Any missing CSP/sandbox enforcement makes plugin execution unavailable;
the host does not weaken the policy for compatibility.

All messages use a versioned discriminated protocol, exact keys, generation and
request ids, bounded payload lengths, and a private origin-checked port. Window
`message` traffic is used only for the one-time host-authored broker handshake;
plugin requests never travel on a wildcard ambient channel.

## Resource and failure containment

Each plugin id + signer + package digest receives its own sandbox and bounded
memory. Different plugins never share memory, ports, or workers.

| Resource | First implementation policy |
| --- | --- |
| Sandboxes | at most 8 resident; least-recently-used idle instance closes first |
| Active calls | one per sandbox, at most 2 globally |
| Queued calls | at most 32 globally; preview may coalesce latest-wins |
| Configure/migrate call | 1 second watchdog |
| Preview frame call | 500 ms watchdog |
| Export frame call | 5 second watchdog |
| Diagnostics | latest 100 events per plugin, 512 characters each |
| Consecutive runtime failures | 3 disables that plugin for the editor session |

The watchdog lives in the trusted parent realm. Timeout removes the iframe and
terminates its worker; it never waits for plugin cooperation. Abort, project
replacement, source replacement, effect removal, safe-mode entry, revocation,
update, and app teardown close the sandbox and settle every pending request.
Late messages fail generation/request matching and are ignored.

Output must match the requested byte length and metadata exactly. A detached,
short, oversized, malformed, late, duplicated, or wrong-generation response is
a failure. The host never uses partial output.

Failure policy is context-specific:

- Inspector/preview: preserve and bypass the failed descriptor, publish a stable
  reason and retry/disable controls, and continue the remaining stack;
- repeated preview failure: disable that package for the session and require an
  explicit Retry action to recreate it;
- export preflight: list every unavailable plugin descriptor before acquiring a
  sink or encoder;
- export runtime failure: abort the output transaction. Do not silently produce
  a file with a missing effect;
- explicit “Export with listed plugins bypassed”: allowed only after a second
  confirmation naming exact instances and package/reason. The exported result
  records a bounded local diagnostic, not project data;
- migration rejection or failure: retain the original descriptor, complete clip
  animation, and document history;
- package/update failure: retain the previous committed installation;
- crash during activation: retain an origin-local activation sentinel so the
  next launch offers safe mode before initializing plugins.

Diagnostics use host-owned reason codes such as `manifest-invalid`,
`signature-invalid`, `untrusted`, `permission-denied`, `incompatible-api`,
`capability-unavailable`, `revoked`, `wasm-policy-rejected`, `timeout`,
`crash`, `bad-response`, and `disabled-safe-mode`. Plugin-provided text is
escaped plain text, bounded, and never treated as HTML. Logs never include frame
pixels, parameter values, project/media names, paths, handles, or package keys.

## Project portability and recovery

The existing `EffectDescriptor` is the durable seam. A plugin effect stores:

- stable effect-instance id;
- namespaced plugin contribution type;
- contribution descriptor version;
- authored enable/bypass state;
- bounded primitive parameters;
- ordinary bounded effect animation tracks where the manifest declares a
  numeric parameter animatable.

Unknown types, versions, keys, and dangling animation targets already remain
ordered and serializable. They resolve as unsupported and bypassed, while
enable, reorder, remove, save, recovery, undo, and redo remain available.

Package requirements are derived from descriptor types at open time. A future
portable requirements summary may improve diagnostics, but it must be advisory
and contain only ids/versions/digests—not URLs, code, grants, or installation
instructions. Project open never auto-installs, auto-enables, migrates, prompts,
or executes a plugin.

Trust, permissions, packages, revocations, crash counters, diagnostics, and
safe-mode state are origin-local sidecars. Copying a `.myrelith` file does not
copy or inherit them. A project with unavailable plugins remains saveable
without rewriting their descriptors.

Safe mode is available from the launcher and from crash recovery. It prevents
all third-party manifest registration and sandbox construction for that editor
session. Built-in effects remain available. Users may bypass, reorder, or remove
opaque plugin descriptors and save/recover normally.

## Explicitly not exposed in the first implementation

The following are rejected, not merely undocumented:

- JavaScript, TypeScript, source maps, eval, dynamic imports, WASI, native code,
  browser extensions, service workers, shared workers, worklets, threads, or
  shared memory;
- remote package discovery, remote URLs, marketplace/install links, automatic
  updates, telemetry, accounts, cloud services, or network access;
- `File`, `FileSystemHandle`, source bytes, folder enumeration, paths, object
  URLs, clipboard, drag payloads, camera/microphone, screen capture, MIDI,
  serial, USB, Bluetooth, HID, geolocation, notifications, or credentials;
- IndexedDB, OPFS, Cache Storage, local/session storage, cookies, durable plugin
  state, project-private storage, or cross-project storage;
- DOM, React, Canvas contexts, WebGL/WebGPU devices, custom Inspector panels,
  toolbar/timeline items, styles, commands, shortcuts, menus, dialogs, popups,
  arbitrary accessibility trees, or active vector assets;
- audio samples, decode/demux/encode, media importers, exporters, codecs,
  transitions, generators, analysis/tracking, captions, project mutation,
  timeline operations, markers, proxy/cache control, recovery/library access,
  or export sinks;
- direct `VideoFrame`, `AudioData`, `ImageBitmap`, `Blob`, stream, worker,
  `MessagePort`, `CryptoKey`, random source, clock, or performance telemetry;
- background execution when no enabled descriptor requires the plugin.

Adding any item requires a new versioned capability, a new threat-model review,
explicit permission copy, budgets, lifecycle ownership, failure behavior,
portable-data rules, negative browser probes, and preview/export agreement.

## Issue #77 implementation gates

Execution remains disabled until all of these are independently reviewed and
green:

1. byte-level ZIP, canonical JSON, integrity, Ed25519, trust, update, rollback,
   and revocation fixtures including hostile archives;
2. WebAssembly binary policy parser and exact ABI fixtures across supported
   browsers, including table-count, aggregate-initial-entry, and aggregate-
   maximum-entry boundaries;
3. CSP/opaque-origin negative probes for network, storage, navigation, DOM, and
   worker escape attempts;
4. watchdog, termination, queue, memory, project replacement, cancellation,
   crash, late-message, and safe-mode tests;
5. unknown/disabled/revoked descriptor round trips through save, recovery,
   undo/redo, reorder, remove, and migration rejection, including the version-1
   static-instance gate for every effect targeted by an animation track;
6. authored built-in/plugin stack-order pixels shared by preview and export;
7. actionable install, permission, incompatibility, crash, retry, export-block,
   bypass-confirmation, disable, uninstall, and safe-mode accessibility;
8. focused/full tests, production build/typecheck, lint, production dependency
   audit, source fingerprints, and real Chromium verification;
9. a separate security reviewer explicitly signs off the residual risks in
   `PLUGIN_THREAT_MODEL.md`.

Until those gates close, `pluginManifest.ts` remains data-only and no production
module may import package bytes or instantiate plugin WebAssembly.
