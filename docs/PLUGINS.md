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
  -> parent-owned activation deadline + fresh host-authored candidate worker
  -> candidate-worker WebAssembly byte-policy parser
  -> candidate-worker validate/compile/instantiate
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
animation eligibility. The step is no larger than the range and must make
representable IEEE-754 binary64 progress from both declared endpoints: validation
requires `min + step > min` and `max - step < max`. Every declared minimum,
maximum, and default stays within the shared durable effect magnitude of
+/-1,000,000,000. Enum values are stable machine ids with host-rendered labels.
Parameter keys are unique within one contribution; reserved durable-record keys
such as `constructor`, `prototype`, and `__proto__` are rejected. Current portable
effect bounds remain authoritative over the resulting descriptor.

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
| WebAssembly imports | exactly 1: the host-supplied memory |
| WebAssembly types | 1,024 type entries; at most 128 parameters and 16 results per function type |
| WebAssembly signature fields | 16,384 aggregate expanded function-type parameters + results |
| WebAssembly functions | 8,192 total across imported + defined |
| WebAssembly code locals | 2,048 expanded locals per defined function and 16,384 per module; parameters + locals are at most 2,048 per defined function and 16,384 across defined functions |
| WebAssembly tables | 16 total across imported + defined; 4,096 aggregate initial and maximum entries |
| WebAssembly memories | 1 total across imported + defined: fixed-size host memory; manifest request 258-1,025 pages / 16 MiB + 128 KiB through 64 MiB + 64 KiB |
| WebAssembly globals | 2,048 total across imported + defined |
| WebAssembly exports | 8,192 |
| WebAssembly element segments | 1,024 segments; 4,096 aggregate elements |
| WebAssembly data segments | 1,024 passive segments only; 8 MiB aggregate payload bytes; active segments forbidden; exact data-count section required when nonempty |
| WebAssembly code bodies | 256 KiB payload per defined function; 16 MiB aggregate payload bytes |
| WebAssembly decoded instructions | 65,536 per defined-function body; 1,048,576 per module |
| WebAssembly structured control | 256 simultaneously open explicit `block`/`loop`/`if` constructs per body; the implicit function frame is separate |
| WebAssembly branch tables | 1,024 labels per `br_table`; 16,384 aggregate labels per body; 65,536 per module |
| WebAssembly initializer expressions | 64 decoded opcodes per expression; 16,384 aggregate opcodes per module |
| WebAssembly tags | 0 |
| WebAssembly declarations | 16,384 aggregate raw section entries; 32,768 combined raw-entry + expanded-signature-field + defined-function-runtime-slot charge |
| WebAssembly start section | forbidden |

The trusted parent owns archive/manifest parsing, exact module-entry framing,
the 32 MiB raw byte-length check, integrity/signature verification, current
trust/revocation preflight, and activation termination. It treats the framed
WebAssembly byte string as opaque: no parent-realm loop may synchronously walk
attacker-authored sections, declarations, bodies, instructions, immediates, or
initializer expressions. Immediately before a raw-byte activation candidate is
created, the parent starts the one non-resetting five-second wall-clock deadline.
The host-authored WebAssembly byte-policy parser then runs entirely inside that
fresh disposable candidate worker, where every attacker-driven loop and parser
allocation remains subject to the static ceilings below and parent termination.

The declaration total is the sum of the raw vector counts in the type, import,
function, table, memory, global, export, element, data, and tag sections. An
import therefore contributes one import entry rather than being counted again
as a defined declaration. The expanded-signature total adds every parameter and
result vector length across the type section. The expanded-local total adds each
code-section local-group multiplicity, not merely the number of groups. Raw
entries remain capped at 16,384, signatures and locals retain their separate
16,384 ceilings. The defined-function runtime-slot total adds each function's
referenced type parameter count again, plus its expanded code locals, so reusing
one compressed signature cannot evade the module budget; it is capped at 16,384.
Checked addition must also keep
`raw entries + signature fields + defined-function runtime slots` at or below
32,768. Code-body bytes, decoded instructions, control depth, branch-table
labels, initializer-expression opcodes, element initializers, and data payload
bytes retain the separate ceilings above. Acceptance requires every independent
gate; byte, opcode, and declaration-entry units are never added into one
misleading counter.

Before iterating or allocating from a declared vector or body, the candidate-
worker byte-policy parser canonical-decodes each type vector, function body
size, local-group vector count, and local multiplicity and proves that it fits
the exact enclosing section/body bytes. A body payload is the declared byte range
after its size field, including the local-declaration vector and instruction
expression. The parser rejects a payload above 256 KiB and checked-adds accepted
payload lengths to the 16 MiB module ceiling. It requires the code-body count to
equal the defined-function count, rejects a zero-sized local group, and checked-
adds each positive multiplicity against the per-function, module, and combined
ceilings. It resolves every defined function's type index and requires
parameters plus code locals to stay within 2,048 value slots per function and
16,384 across all defined functions. Function imports are rejected by the
earlier exactly-one-memory import gate before this accounting.

The same parser decodes the complete instruction expression rather than handing
opaque body bytes to the engine. One decoded opcode, including a prefixed opcode,
counts as one instruction; structural `block`, `loop`, `if`, `else`, and `end`
opcodes count too. A closed, binary-policy-versioned table enumerates every
accepted primary/prefixed opcode and its immediate grammar; an entry absent from
that table is rejected instead of feature-sniffed through the browser engine.
Version 1 derives that closed table from the dated
[WebAssembly Core 2.0 (2025-09-16)](https://webassembly.github.io/spec/versions/core/WebAssembly-2.0.pdf)
binary instruction grammar for numeric, control, parametric, variable, table, memory,
reference, fixed-width SIMD, sign-extension, nontrapping-conversion, multi-value,
and bulk-memory operators. It applies the type/import/memory/table restrictions
in this document and adds no threads/atomics, shared memory, relaxed SIMD, tail
calls, exceptions/tags, typed function references, GC, memory64, multi-memory,
component-model features, or other proposal. The initializer-only Core 3.0
subset below does not expand the function-body table. The normative table
artifact and its digest are fixtures of the binary-policy version and compiled-
cache key; unknown/reserved or unlisted primary/prefixed opcodes fail policy.

The parser canonical-decodes every opcode, subopcode, index, lane, memory
argument, block type, numeric literal, and other immediate. Truncated,
overflowing, noncanonical, or unsupported encodings fail. Any vector-valued
immediate is contained and counted before allocation: `br_table` uses its
dedicated limits, and typed `select` requires exactly one allowed value type.
Every index immediate is range-checked against the already bounded type,
function, table, memory, global, element, or data count; memory/table immediates
must select resources accepted by this policy. Any reference-type immediate is
exactly `funcref`; `externref` and every other heap/reference type are unlisted.
The parser caps each body at 65,536 decoded instructions and the module at
1,048,576. A fixed parser stack permits at most 256 simultaneously open explicit
`block`/`loop`/`if` constructs, with the implicit function-expression frame held
separately. `else` must match the current `if` and occur at most once. Every
`br`, `br_if`, and `br_table` target, including the mandatory table default,
must be within the current label depth. A `br_table` may contain at most 1,024
vector labels; checked sums cap vector labels at 16,384 per body and 65,536 per
module. The default is decoded and depth-checked but is not a vector label. The
one final `end` must close the implicit function frame at the exact declared
body boundary. An early or missing final `end`, control-stack underflow or
overflow, or any trailing body byte is a policy failure.

Constant and initializer expressions use the same canonical decoder. Each is
capped at 64 opcodes, including its final `end`, and checked addition caps the
module at 16,384 initializer-expression opcodes. Version 1 global initializers
allow type-matching `i32.const`, `i64.const`, `f32.const`, `f64.const`, or
`v128.const`; `global.get` of an earlier immutable defined numeric global; and
only `i32.add`/`i32.sub`/`i32.mul` or `i64.add`/`i64.sub`/`i64.mul` as extended-
constant operators. The decoder type-checks this small stack expression and
requires exactly one value matching the declared global type. This permits a
policy-valid 64-opcode boundary fixture without admitting the broader Core 3.0
extended-constant/reference/GC grammar. Element offsets allow exactly one
`i32.const`; element items use legacy function indexes or exactly one `ref.func`
or `ref.null funcref`. Referenced global/function indexes must exist and satisfy
those rules. Imported globals are already forbidden; every other extended-
constant or reference form, an unsupported opcode, a missing final `end`, or
trailing expression bytes fail before engine work. Active data is already
forbidden, so it has no offset expression. Function parameters, results, locals,
and all defined globals may use only `i32`, `i64`, `f32`, `f64`, or `v128`;
tables use the separately bounded `funcref` contract. No attacker
count may drive an allocation before all byte-containment, decoding, feature,
and resource checks succeed.

Inside the fresh candidate worker, the host-authored parser checks every
WebAssembly ceiling, rejects every active data segment and start section, and
accepts only passive data segments. Only after that complete parse succeeds may
the same candidate worker call `WebAssembly.validate()`,
`WebAssembly.compile()`, or `WebAssembly.instantiate()`. A parse rejection or
parent deadline expiry calls no engine API and terminates the candidate. Every
other package limit is checked before the corresponding allocation.
Decompression tracks the running expanded total and aborts on the first
overflow.

The numbers leave bounded implementation headroom without inheriting a
browser-engine limit. A maximum-size version-1 manifest can reference 4,160
render/migration entrypoint names (64 contributions, each with one render and up
to 64 migration declarations); 8,192 function/export entries leave room for
internal helpers while the 16,384 declaration total prevents all per-kind maxima
from stacking. The 32,768 combined charge prevents compressed signatures or
locals, including signature reuse across many defined functions, from bypassing
that raw-entry bound. The 4,096 element ceiling equals the complete table-entry
budget, and the 8 MiB passive-data payload ceiling is one quarter of the already
bounded module. These are version-1 policy choices, not ambient capabilities or
promises that a module below every ceiling will be accepted.

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
5. each declared migration export runs in a fresh migration-chain-owned sandbox
   against cloned canonical parameter bytes; no plugin code runs merely to
   discover a chain and no editor or export runtime is reused;
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
The lifecycle and atomic multi-descriptor action rules are defined under
**Runtime instance lifetimes**; no candidate enters project state or history
before the final action-wide commit.

## First contribution: bounded video effect

### Permission meaning

`myrelith.effect.video-frame.rgba8` version 1 means:

- receive one complete, isolated RGBA8 layer in the exact display-referred sRGB
  representation below, after crop/transform and before clip opacity,
  transition weighting, and destination blending;
- mutate that same-sized RGBA8 buffer in place;
- receive exact integer timeline frame, exact rational document rate, project
  width/height, row stride, and bounded primitive parameters. Invocation of the
  manifest-unique render export identifies the contribution and its current
  descriptor schema without copying another selector into plugin memory;
- receive no lower/upper tracks, unrelated clips, source file bytes, filenames,
  paths, asset descriptors, audio, project name, project id, markers, captions,
  handles, URLs, clocks, randomness, storage, or network capability.

The color representation is normative in both directions. Each pixel is four
consecutive bytes in `R, G, B, A` order. The R/G/B bytes are nonlinear code
values encoded with the IEC 61966-2-1 sRGB opto-electronic transfer function,
using the sRGB/Rec.709 primaries and D65 white point. They are not linear-light
values and are not Display-P3. The A byte is an independently and linearly
quantized 8-bit coverage value. RGB is straight/unassociated and is never
premultiplied by A, including when A is zero. A successful output uses this
identical representation; the plugin may not change its interpretation.

Before every call, the host converts the isolated compositor layer from its
internal representation into this exact ABI encoding. After a successful call,
the host interprets the returned bytes in the same encoding and converts them
back to the compositor representation when needed. Preview and export use the
same conversion and interpretation, including the same boundary fixtures. No
ICC profile, source color-space tag, mastering metadata, or other profile/gamut
metadata crosses into plugin memory; version 1 has no color-space negotiation.

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
- the module defines no additional memory. For manifest request `P`, its import
  declares both minimum and maximum exactly equal to `P`, and the host constructs
  `myrelith.memory` with `initial == maximum == P`. Version 1
  accepts only `258 <= P <= 1,025`, so `memory.grow` cannot blur region ownership;
- linear memory uses this fixed, non-overlapping byte map:

  | Owner/use | Pages | Byte range |
  | --- | ---: | --- |
  | Module passive-data materialization | 0-127 | `[0x00000000, 0x00800000)` (8 MiB) |
  | Module stack/heap/allocator workspace | 128-255 | `[0x00800000, 0x01000000)` (8 MiB) |
  | Host canonical parameters / migration input | 256 | `[0x01000000, 0x01010000)` (64 KiB) |
  | Host RGBA pixels / migration output | 257 through `P - 1` | `[0x01010000, P * 65,536)` |

  Canonical render parameters occupy at most 65,536 bytes at the fixed parameter
  pointer. The host passes the fixed pixel pointer `0x01010000`. A request of
  `P` pages supports exactly `(P - 257) * 16,384` RGBA pixels. At 1,025 pages
  the pixel region is exactly 48 MiB, or 12,582,912 pixels; frames above that
  version-1 plugin limit are explicitly unavailable even when the ordinary
  compositor can render them;
- every data segment is passive. Aggregate payload remains capped at 8 MiB. The
  standard data-count section plus bulk-memory `memory.init` and `data.drop`
  forms are the only accepted data-initialization mechanism; the binary parser
  requires the data-count value to equal the data-section count, canonical and
  in-range static segment indexes, and the exact allowed opcodes/features before
  engine work. The engine still bounds-checks each dynamic `memory.init` source
  and destination. During an already watchdog-bounded render or migration call,
  a conforming module lazily copies passive bytes only into
  `[0x00000000, 0x00800000)` and then drops them. No package code runs before
  that call. Its stack pointer, heap, and allocator outputs remain within pages
  128-255. Active data segments are
  rejected from raw bytes before engine work, so instantiation cannot overwrite
  host I/O. These partitions are a conforming module-private ABI convention,
  not an isolation boundary inside the already-untrusted module. The module can
  corrupt its own imported memory, so the host refreshes parameters and pixels
  before every call, copies/validates only the exact successful host-owned
  output afterward, and clears host I/O ranges before reuse;
- the module defines at most 16 internal tables. Every table declares a maximum,
  each table's maximum is at most 4,096 entries, and both the sum of all declared
  initial sizes and the sum of all declared maxima are at most 4,096 entries.
  The binary-policy parser checks these count and aggregate limits before
  compilation or instantiation;
- the module contains no start section. The candidate-worker parser rejects its
  presence from the raw section stream before that same worker performs engine
  validation, compilation, or instantiation, so package code cannot run
  synchronously during activation;
- the candidate-worker parser enforces the package-budget ceilings for types,
  imported plus defined functions, tables, memories, globals, exports, element
  segments and
  initializers, passive data segments and payload bytes, imports, tags, expanded
  function-type fields, expanded code locals, defined-function runtime slots,
  raw declarations, the combined declaration-resource charge, code-body bytes,
  decoded body instructions, structured-control depth, branch-table labels, and
  initializer-expression opcodes before any engine call. Counts use checked
  addition and reject an overflow, a noncanonical encoding, a duplicate
  singleton section, a function/code count mismatch, or a section/body whose
  declared vector cannot fit inside its exact byte range;
- threads, shared memory, relaxed SIMD, component-model imports, WASI, and JS
  builtins are rejected;
- every contribution names a package-unique render entrypoint. Invoking that
  export is the contribution discriminator; no contribution-id string or numeric
  selector is copied into untrusted memory;
- each contribution render entrypoint is an exported function with signature
  `(i32, i32, i32, i32, i32, i32, i32, i32, i32, i32) -> i32`;
- arguments are the fixed pixel pointer `0x01010000`, width, height, stride,
  frame low/high 32-bit words, frame-rate numerator/denominator, UTF-8 canonical-
  parameter pointer, and parameter byte length. The parameter pointer is always
  `0x01000000`;
- the pixel region is exactly `stride * height` bytes, `stride` is exactly
  `width * 4`, `width * height` does not exceed the `P`-page capacity above,
  and every checked range stays inside fixed-size imported memory;
- a larger surface that satisfies Myrelith's ordinary render-surface budget
  remains a valid project. When it exceeds the selected package's plugin-memory
  capacity, preview reports that plugin stage unavailable and visibly bypasses
  it; export blocks by default and uses the existing explicit reviewed-bypass
  flow. The plugin ceiling never narrows project parsing or built-in rendering;
- input and successful output pixels both use the permission's exact
  display-referred IEC sRGB/Rec.709-primary, D65, nonlinear sRGB-OETF encoding
  with straight/unassociated 8-bit alpha. The host owns conversion before
  copy-in and after copy-out; no ICC/profile metadata or alternate encoding is
  passed or inferred;
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
  pointer/length, zeroed output pointer/capacity, and declared from/to versions.
  Input uses `0x01000000` and output uses `0x01010000`; no frame call is active
  concurrently. The fixed regions are non-overlapping, each is capped at 65,536
  bytes, a positive return is the exact output length, and zero or a negative
  value is a migration failure. The universal 258-page manifest minimum makes
  both pages available, and a migration export name must differ from every
  render export in the package;
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

On every raw-byte path, the module binary must pass the complete host-authored
byte policy inside its fresh candidate worker before that worker invokes any
WebAssembly engine API. `WebAssembly.validate()` is necessary but insufficient
for policy. The WebAssembly standard explicitly permits embedder resource
limits and module rejection; memory maxima are expressed in pages. See
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

After bounded package framing and lifecycle preflight, the trusted parent starts
one non-resetting five-second wall-clock deadline before asking the broker to
create a fresh, disposable activation-candidate worker from host-authored code
and pass a private `MessagePort`. The parent then supplies either the verified,
bounded WebAssembly byte string or immutable compiled code bound to the exact
accepted package digest, negotiated ABI, and binary-policy version. On the raw-
byte path, the candidate worker first runs the complete host-authored byte-policy
parser without invoking an engine API; only after parse success does that same
worker call validation, asynchronous compilation, and instantiation. The parent
does not synchronously iterate any attacker-driven WebAssembly section,
instruction, or initializer structure, and the deadline does not reset when
parsing or any later activation phase completes. A cache hit may skip repeated
byte parsing, validation, and compilation only when the requesting lifecycle's
preflight rechecks current trust, revocation, availability, and an exact cache
binding that records prior candidate-worker policy acceptance. Both paths
allocate new imported memory and instantiate a fresh `WebAssembly.Instance` in
the candidate. The worker sends an instance-ready acknowledgement only after its
path finishes. On success the same worker becomes the dedicated runtime worker
for the lifecycle that requested it, retaining sole ownership of the instance;
on every parse failure, engine failure, or timeout the parent terminates it
instead of reusing it. Package bytes are never interpreted as JavaScript. CSP
`worker-src` governs worker loads and `connect-src` is the fallback for
connection-like fetch destinations under the
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

### Runtime instance lifetimes

The ordinary editor sandbox may reuse its dedicated runtime worker,
`WebAssembly.Instance`, and imported memory across preview and scrub calls until
a lifecycle event below destroys it. Version 1 does not require render purity or
expose a reset ABI. Any temporal module state is therefore confined to that
editor lifecycle; it is never durable project truth and never becomes export
input.

Every explicit descriptor-migration action uses a migration-owned lifecycle,
separate from editor and export state. The host first freezes the exact project
generation, original target descriptors and animations, and a duplicate-free
target list. Before any plugin migration code runs, it resolves every complete
chain and rejects the whole action if any target fails the version-1 static-
animation gate. Immediately before each chain activation, it rechecks current
trust, revocation, package availability, the unchanged starting target snapshot,
and any requested immutable-code cache lease's exact binding. For exactly one
descriptor chain it then freshly activates a worker, `WebAssembly.Instance`,
fixed imported memory,
private port, queue, request sequence, and generation. The port accepts only
that chain's canonical migration records and host control messages. Frame pixels
and preview, scrub, Inspector, export, or other editor messages cannot enter its
queue. All declared steps for that descriptor may run sequentially in the same
chain-owned instance, but no mutable state, message, or intermediate value
crosses to another descriptor chain or action.

A user action targeting multiple descriptors processes them serially in the
immutable starting document's track-array, clip-array, then effect-stack order.
It destroys each chain owner before freshly activating the next. Validated final
candidates remain bounded trusted-host staging only; the host makes one history/
document commit after every chain succeeds, the final whole-document budgets
pass, and the exact starting generation and target values still match. Failure,
cancellation, watchdog expiry, trust or revocation change, stale state, or final
commit rejection discards all staged candidates and preserves every original
descriptor and complete animation. Success also terminates the final owner.
Every terminal path settles outstanding host requests and destroys the worker,
instance, memory, port, and queue without waiting for plugin acknowledgement;
retry creates fresh owners. Only exact-key immutable compiled code may survive.

As part of every export attempt's exact plugin preflight, before a sink or encoder
is acquired, the host creates a separate export-owned sandbox and fresh
activation-candidate worker for every required package. It instantiates a new
`WebAssembly.Instance` with newly allocated imported memory. The host may reuse
only verified digest-bound immutable module bytes or a digest-bound,
policy-accepted immutable compiled `WebAssembly.Module`/engine code cache. It
must not reuse or share the editor worker, instance, memory, tables, globals,
port, queue, request generation, or any other mutable module state. The export
port accepts export calls only; preview, scrub, Inspector, migration, and other
editor-session messages never enter its queue. Concurrent editor preview cannot
mutate export state.

The optional compiled-module cache has one trusted-parent, session-only owner.
Its exact key contains plugin id, signer fingerprint, package digest, signed
module path and hash, every negotiated host/capability/contribution ABI version,
and the binary-policy version. The first implementation holds at most eight
entries and charges each entry by its accepted raw module byte length; checked
addition caps the aggregate charge at 64 MiB. An insertion evicts idle entries
until both limits fit, ordered deterministically by oldest host access sequence
and then lexicographic cache key. Activation/export/migration code under an
explicit lease is never evicted. If idle eviction cannot make room, activation
may continue from
the verified bytes but does not retain the compiled result; cache pressure never
weakens a gate or makes execution necessary for project recovery.

A cache entry contains only immutable compiled code plus its key/accounting facts
and the fact that its exact bytes were accepted by the candidate-worker parser
under that binary-policy version—never an instance, imported memory, table,
global, worker, port, queue, or request state. Every lease first rechecks current
trust, revocation, package
availability, and the complete key. Disable, uninstall, revocation, package
replacement/update, signer/digest/hash mismatch, or binary-policy/ABI version
change removes matching idle entries and makes leased entries non-reusable after
their owner is terminated. App teardown clears the entire cache. No entry is
persisted to IndexedDB, OPFS, recovery, or a project.

Calls delivered to one export sandbox are serialized in ascending requested
timeline-frame order and, within a frame, the authored composition/effect-plan
order. The host never coalesces, skips, or replays a planned plugin call from a
checkpoint.
Terminal success destroys every export-owned worker, instance, and memory after
the final planned call and output transaction complete. Failure, cancellation,
or watchdog expiry makes the trusted parent terminate outstanding export workers
and settle their host-side requests without waiting for plugin acknowledgement.
Retrying or restarting an export is a new attempt: it starts again at the first
requested frame with another fresh instance, so no partial or prior export state
is inherited.

## Resource and failure containment

Each plugin id + signer + package digest + lifecycle receives its own sandbox and
bounded memory. Editor, export, and per-descriptor-chain migration lifecycles,
like different plugins, never share instances, memory, ports, or workers.

Before export activation, preflight atomically reserves one resident-sandbox slot
for every distinct required package identity, closing least-recently-used idle
editor sandboxes first. If the required export set plus non-idle editor sandboxes
cannot fit the hard eight-resident ceiling, preflight lists the resource failure
and stops before acquiring a sink or encoder. Export sandboxes stay pinned until
that attempt ends; the host never evicts, batches, or reinstantiates them midway
through an export to work around the ceiling.

Before a migration action activates its first target, it atomically reserves one
resident-sandbox slot for that action, closing a least-recently-used idle editor
sandbox first when necessary. If no slot is available, the entire action fails
before plugin code runs. The reservation stays pinned while chains are processed
serially, but exactly one fresh migration sandbox occupies it at a time; terminal
chain cleanup completes before the next activation. This reservation and every
migration call still count toward the global sandbox, active-call, and queue
ceilings.

| Resource | First implementation policy |
| --- | --- |
| Sandboxes | at most 8 resident across editor/export/migration; least-recently-used idle editor instance closes first, every export instance closes terminally, and a migration action reserves one serial slot while creating a fresh terminal instance per descriptor chain |
| Immutable compiled-module cache | session-only; at most 8 exact-keyed entries and 64 MiB aggregate accepted-raw-byte charge; deterministic idle LRU; leased code is pinned |
| Active calls | one per sandbox, at most 2 globally |
| Queued calls | at most 32 globally; preview may coalesce latest-wins, while export and migration never coalesce and stay deterministically serialized |
| Candidate create/parse/validate/compile/instantiate activation | 5 seconds total wall-clock |
| Configure/migrate call | 1 second watchdog |
| Preview frame call | 500 ms watchdog |
| Export frame call | 5 second watchdog |
| Diagnostics | latest 100 events per plugin, 512 characters each |
| Consecutive runtime failures | 3 disables that plugin for the editor session |

Every deadline lives in the trusted parent realm. The activation deadline is
one non-resetting wall-clock interval that starts before the candidate worker is
created and ends only when its instance-ready acknowledgement is accepted; it
therefore covers candidate-worker byte-policy parsing, engine validation,
asynchronous compilation, and instantiation without running attacker-driven
WebAssembly iteration on the app/UI thread. Timeout removes the iframe and
terminates its candidate or runtime worker; it never waits for plugin cooperation.
Abort, project replacement, source replacement, effect removal,
safe-mode entry, revocation, update, and app teardown close the sandbox and
settle every pending request. Late messages fail generation/request matching
and are ignored.

Output must match the requested byte length and metadata exactly. A detached,
short, oversized, malformed, late, duplicated, or wrong-generation response is
a failure. The host never uses partial output.

Failure policy is context-specific:

- Inspector/preview: preserve and bypass the failed descriptor, publish a stable
  reason and retry/disable controls, and continue the remaining stack;
- repeated preview failure: disable that package for the session and require an
  explicit Retry action to recreate it;
- export preflight: create and validate every fresh export-owned instance and
  list every unavailable plugin descriptor before acquiring a sink or encoder;
- export runtime failure: abort the output transaction. Do not silently produce
  a file with a missing effect;
- explicit “Export with listed plugins bypassed”: allowed only after a second
  confirmation naming exact instances and package/reason. The exported result
  records a bounded local diagnostic, not project data;
- migration rejection or failure: retain the original descriptor, complete clip
  animation, every other descriptor in the same action, and document history;
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
   browsers, including proof that raw-byte parsing runs only after candidate-
   worker creation, inside that worker, under the already-running parent
   deadline; start-section and active-data-segment rejection; fixed
   memory-offset/capacity arithmetic and exact-cap-plus-one behavior; passive
   data-count/segment/index/range consistency plus allowed `memory.init`/
   `data.drop` behavior; exact signature-field and code-local boundaries;
   near-`u32` local multiplicities; zero local groups;
   repeated type-index parameter amplification; checked per-function/module/
   combined overflow; 256 KiB/body and 16 MiB/module exact/+1 payload fixtures;
   65,536/body and 1,048,576/module decoded-instruction exact/+1 bombs;
   256-deep structured control; `else`, branch-depth, final-`end`, and trailing-
   byte failures; 1,024/instruction, 16,384/body, and 65,536/module branch-table
   label exact/+1 bombs; 64/expression and 16,384/module initializer-opcode
   exact/+1 bombs; accepted and rejected initializer allowlist forms; bounded
   typed-`select` and every other immediate vector; malformed, truncated,
   overflowing, noncanonical, reserved, and unsupported opcode/immediate
   encodings; function/code count mismatch; and every other per-kind, payload,
   and aggregate declaration boundary in the package-budget table;
3. CSP/opaque-origin negative probes for network, storage, navigation, DOM, and
   worker escape attempts;
4. activation-worker promotion; a five-second parent deadline that begins
   before worker creation and never resets across parse/validate/compile/
   instantiate; parent responsiveness and termination during a near-limit parse;
   parse-failure proof that no engine API ran; same-worker parse-to-promotion
   identity; compile/instantiate termination, call watchdog, queue, memory,
   project replacement, cancellation,
   crash, late-message, safe-mode, and compiled-cache count/byte accounting,
   deterministic idle eviction, lease pinning, invalidation, and teardown tests;
5. unknown/disabled/revoked descriptor round trips through save, recovery,
   undo/redo, reorder, remove, and migration rejection, including the version-1
   static-instance gate for every effect targeted by an animation track; fresh
   per-descriptor-chain migration workers/instances/memories/ports/queues/
   generations; same-chain sequential steps; reciprocal editor/export message
   isolation; deterministic serial multi-descriptor actions; terminal teardown;
   fresh retry; stale-generation rejection; and all-or-nothing final commit;
6. authored built-in/plugin stack-order pixels shared by preview and export,
   plus stateful-module fixtures proving that every export starts from a fresh
   instance/memory, follows deterministic call order, and cannot inherit prior
   or concurrent preview, canceled export, or retried export state;
7. actionable install, permission, incompatibility, crash, retry, export-block,
   bypass-confirmation, disable, uninstall, and safe-mode accessibility;
8. focused/full tests, production build/typecheck, lint, production dependency
   audit, source fingerprints, and real Chromium verification;
9. a separate security reviewer explicitly signs off the residual risks in
   `PLUGIN_THREAT_MODEL.md`.

Until those gates close, `pluginManifest.ts` remains data-only and no production
module may import package bytes or instantiate plugin WebAssembly.
