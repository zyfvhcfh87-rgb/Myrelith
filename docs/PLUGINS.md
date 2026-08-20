# Sandboxed plugin capability and compatibility contract

Status: normative version-1 contract. Issue #77 implements this boundary in
PR #123; the implementation remains merge-gated on the acceptance and
independent security/compatibility review requirements below and in
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
opcodes count too. A closed, binary-policy-versioned profile table enumerates
every accepted primary/prefixed opcode and its immediate grammar; an entry absent
from the selected table is rejected instead of feature-sniffed through the
browser engine.

The candidate selects the profile once, before scanning any WebAssembly section,
from the already-validated signed manifest facts supplied by the trusted parent:

| Signed manifest fact | Exact binary-policy profile id |
| --- | --- |
| every contribution has an empty `migrations` array | `myrelith-wasm-render-general-v1` |
| any contribution has one or more migration declarations | `myrelith-wasm-migration-integer-v1` |

The render-general profile derives its closed table from the dated
[WebAssembly Core 2.0 (2025-09-16)](https://webassembly.github.io/spec/versions/core/WebAssembly-2.0.pdf)
binary instruction grammar for numeric, control, parametric, variable, table, memory,
reference, fixed-width SIMD, sign-extension, nontrapping-conversion, multi-value,
and bulk-memory operators. It applies the type/import/memory/table restrictions
in this document and adds no threads/atomics, shared memory, relaxed SIMD, tail
calls, exceptions/tags, typed function references, GC, memory64, multi-memory,
component-model features, or other proposal. The initializer-only Core 3.0
subset below does not expand the function-body table.

Keeping scalar floating point and fixed-width SIMD in this render-only profile
preserves common render toolchains and performance. Version 1 does not claim
that third-party plugin output pixels are bit-identical across different browser
engines or hardware: its portability contract pins the host's exact input and
parameter bytes, color interpretation, requested-frame/order semantics, and
lifecycle isolation. A future pixel-determinism capability would need its own
numeric profile and conformance fixtures.

The migration-integer profile is a strict whole-module subset. It rejects
`f32`, `f64`, and `v128` in every function parameter/result, block signature,
typed-`select` result, local declaration, and defined global. It omits every
`f32`/`f64` constant, load, store, arithmetic, comparison, conversion, and
reinterpretation form; every float-related nontrapping/prefixed conversion; and
the complete fixed-width SIMD `0xfd` prefix, including integer-lane forms. Only
the render-general table's deterministic `i32`/`i64` numeric, control, variable,
parametric, fixed-memory, bulk-memory, and bounded `funcref` table forms remain,
with `table.grow` explicitly omitted. Its allocation-dependent success/failure
must not enter durable migration behavior; the declared table bounds and every
other allowed table operation still receive the normal static and runtime
checks. The only import is still the fixed host memory, and the migration port
provides no time, randomness, pixels, editor/export messages, or other
nondeterministic input.

This stricter profile applies to every declaration, initializer, function body,
export, and otherwise unreachable helper in the signed module, not only the
declared migration exports. A function referenced by an element segment or
`ref.func`, stored or moved with `table.set`/`table.init`/`table.copy`/`table.fill`,
or invoked through `call_indirect` receives no exemption. Whole-module parsing is
deliberate: version 1 performs no fallible reachable-function analysis and cannot
let float/SIMD state flow indirectly into durable migration output. The
tradeoff is explicit: render exports packaged beside any migration declaration
are integer-only too. A publisher that needs the wider render-general profile
must ship a version with no migration declarations; a future separately
versioned package/runtime contract may define a narrower split safely.

Each profile owns a canonical normative opcode/immediate-table artifact and an
exact digest encoded as `sha256:` plus 64 lowercase hexadecimal characters. The
profile id and that profile's table digest are fixtures of the binary-policy
version and exact raw-module cache identity. Unknown profile ids, digest mismatch,
reserved/unlisted primary or prefixed opcodes, and using general-profile
acceptance for a migration-bearing manifest all fail before an engine call.

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

Constant and initializer expressions use the same selected-profile canonical decoder. Each is
capped at 64 opcodes, including its final `end`, and checked addition caps the
module at 16,384 initializer-expression opcodes. Render-general global initializers
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
forbidden, so it has no offset expression. Under the migration-integer profile,
global initializers are limited to the listed `i32`/`i64` constants, earlier
immutable `i32`/`i64` globals, and integer `add`/`sub`/`mul`; `f32.const`,
`f64.const`, and `v128.const` reject. Render-general function parameters,
results, locals, and all defined globals may use only `i32`, `i64`, `f32`,
`f64`, or `v128`; migration-integer narrows those positions to `i32`/`i64`.
Both profiles use the separately bounded `funcref` table contract. No attacker
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

Every reference in this contract to the JSON Canonicalization Scheme or `JCS`
means [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785). Its I-JSON input,
ECMAScript primitive serialization, UTF-16 property sorting, and final UTF-8
encoding rules are part of the wire contract rather than implementation advice.

Version 1 `signature.json` is one closed `SignatureEnvelopeV1` object with
exactly these members and types:

| Member | Version-1 value |
| --- | --- |
| `format` | exact string `myrelith-plugin-signature` |
| `formatVersion` | exact JSON integer `1` |
| `algorithm` | exact string `Ed25519` |
| `publicKey` | canonical unpadded base64url, exactly 43 ASCII characters decoding to the 32 raw Ed25519 public-key bytes |
| `fingerprint` | exact `sha256:` followed by 64 lowercase hexadecimal characters equal to SHA-256 of those 32 public-key bytes |
| `entries` | exactly two closed `IntegrityEntryV1` objects, ordered as specified below |
| `signature` | canonical unpadded base64url, exactly 86 ASCII characters decoding to 64 raw Ed25519 signature bytes |

Each `IntegrityEntryV1` has exactly `length`, `path`, and `sha256`. `length` is
an exact non-negative JSON safe integer equal to the expanded entry byte length:
`manifest.json` is 1 through 65,536 bytes and the Wasm entry is 8 through
33,554,432 bytes. `sha256` is exactly 64 lowercase hexadecimal characters for
SHA-256 of those expanded bytes, with no prefix. `path` is ASCII and the two
paths are exactly `manifest.json` and the parsed manifest's `runtime.entry`.
The runtime path is 1 through 240 characters, relative, slash-delimited, ends in
`.wasm`, and every nonempty segment matches
`[A-Za-z0-9][A-Za-z0-9._-]*`; `.`, `..`, a leading or trailing slash,
backslash, drive/absolute form, NUL, or any alternate spelling is invalid.
`signature.json` is never an integrity entry, and version 1 accepts no asset or
other package entry.

The entries array is strictly ascending by the raw ASCII/UTF-8 bytes of `path`;
duplicate paths are invalid. That array order is a schema rule. Object member
order is not: RFC 8785 supplies the serialized UTF-16 property order. Before an
ordinary JSON parse, the package verifier rejects a BOM, invalid UTF-8,
duplicate keys, or bytes beyond the one JSON value. It then requires exact
top-level/nested member sets, types, literals, bounds, and canonical base64url/
hex spellings, and finally requires the original `signature.json` bytes to equal
the RFC 8785 JCS UTF-8 re-encoding byte-for-byte. Thus whitespace, a trailing
newline, alternate escapes/numbers, padding, or differently cased hex fails.

The signed payload is the exact closed object containing `algorithm`, `entries`,
`fingerprint`, `format`, `formatVersion`, and `publicKey` from the accepted
envelope, excluding only `signature`. The Ed25519 message is exactly that
object's RFC 8785 JCS UTF-8 bytes. Decode/re-encode equality is required for the
public key and signature before Web Crypto verifies the decoded raw public key,
algorithm `Ed25519`, decoded signature, and exact message bytes. Ed25519 is
defined by the current
[Web Cryptography API](https://w3c.github.io/webcrypto/#ed25519-operations);
support is still treated as runtime fact rather than assumed.

The package digest uses independent framing rather than ambiguous
concatenation. Let `message` be the exact signed-payload bytes, `sig` the decoded
64 signature bytes, `U32BE(n)` the four-byte unsigned big-endian encoding, and
`domain` the ASCII bytes for `myrelith-plugin-package-digest-v1` followed by one
`00` byte. Then:

```text
packageDigestBytes = SHA-256(
  domain || U32BE(message.byteLength) || message ||
  U32BE(sig.byteLength) || sig
)
packageDigest = "sha256:" || lowercaseHex(packageDigestBytes)
```

Every stored, displayed, granted, revoked, and cache-key package digest uses
that exact 71-character text. Lengths are checked before framing.

#### Canonical signature golden vector

This deterministic complete-package vector uses the 32-byte seed from RFC 8032
test vector 1 only as fixture key material; the message and signature below are
Myrelith-specific and were independently verified with Node classic crypto and
Web Crypto. Each JSON code block is one exact UTF-8 line with no BOM or trailing
newline.

Seed (test-only, never shipped as a trusted key):

```text
9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60
```

Raw public key, canonical `publicKey`, and fingerprint:

```text
d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a
11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo
sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9
```

Exact 496-byte canonical `manifest.json`:

```json
{"api":{"maxVersion":1,"minVersion":1},"contributions":[{"contributionVersion":1,"descriptorVersion":1,"entrypoint":"myrelith_effect_fixture","id":"fixture","kind":"video-effect","migrations":[],"name":"Fixture","parameters":[]}],"id":"com.example.fixture","name":"Fixture","permissions":[{"id":"myrelith.effect.video-frame.rgba8","maxVersion":1,"minVersion":1,"required":true}],"runtime":{"entry":"runtime/plugin.wasm","kind":"wasm","memoryMaximumPages":258},"schemaVersion":1,"version":"1.0.0"}
```

Its SHA-256 is
`4e0895870d15157857e53bbd261230b8d3cffad62d7d2fb8a5be1bd65c8b59b7`.
The exact 91-byte Wasm entry is this hexadecimal byte string; it validates as a
minimal module importing fixed 258-page `myrelith.memory` and exporting the
declared ten-`i32` render function:

```text
0061736d01000000010f01600a7f7f7f7f7f7f7f7f7f7f017f021701086d7972656c697468066d656d6f727902018202820203020100071b01176d7972656c6974685f6566666563745f6669787475726500000a0601040041000b
```

Its SHA-256 is
`a14d35d3869f4460413d414bef13e060c7e20c9a37f27a91a2cab8a6d8e79915`.

Exact 469-byte signed-payload JCS:

```json
{"algorithm":"Ed25519","entries":[{"length":496,"path":"manifest.json","sha256":"4e0895870d15157857e53bbd261230b8d3cffad62d7d2fb8a5be1bd65c8b59b7"},{"length":91,"path":"runtime/plugin.wasm","sha256":"a14d35d3869f4460413d414bef13e060c7e20c9a37f27a91a2cab8a6d8e79915"}],"fingerprint":"sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9","format":"myrelith-plugin-signature","formatVersion":1,"publicKey":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}
```

Its SHA-256 is
`a99cac0e2462fd36cb0c329b7e33dc97bbeeaaffe2f8a3ff3fa24c6bfb71876a`.
The canonical 64-byte Ed25519 signature is:

```text
mGj9h_CF_9V9S01ClcHESESk0QxSo-HM1Dxxpo98lo3UA-R9zRGjIXuv8XoLmBAFti0625yjz-UbiktJmpQJDg
```

Exact 570-byte canonical `signature.json`:

```json
{"algorithm":"Ed25519","entries":[{"length":496,"path":"manifest.json","sha256":"4e0895870d15157857e53bbd261230b8d3cffad62d7d2fb8a5be1bd65c8b59b7"},{"length":91,"path":"runtime/plugin.wasm","sha256":"a14d35d3869f4460413d414bef13e060c7e20c9a37f27a91a2cab8a6d8e79915"}],"fingerprint":"sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9","format":"myrelith-plugin-signature","formatVersion":1,"publicKey":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","signature":"mGj9h_CF_9V9S01ClcHESESk0QxSo-HM1Dxxpo98lo3UA-R9zRGjIXuv8XoLmBAFti0625yjz-UbiktJmpQJDg"}
```

The envelope SHA-256 is
`04881c8c0d9c0e3094d2be3a03708db61ad4ef4e5b792c576b682f1ec687ac4d`.
The domain byte string is
`6d7972656c6974682d706c7567696e2d7061636b6167652d6469676573742d763100`;
the complete framed package-digest input is 575 bytes and yields
`sha256:cb47299284c74ad83fce88a8c2d50af97e9de6f6d56513f9e07ac7dac2851d97`.

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

Any nonempty contribution `migrations` array also selects the whole-module
`myrelith-wasm-migration-integer-v1` binary-policy profile described above for
every editor, migration, and export activation of that signed package. This is a
compatibility gate, not a per-call switch: a float/SIMD type or opcode or
`table.grow` anywhere in the module rejects before `WebAssembly.validate`, even
when it is unreachable from the migration export or referenced only through a
table. With one fresh
initial state, canonical migration input, fixed sequential step order, integer-
only Wasm semantics, no callable imports or host nondeterminism, and canonical
JCS/schema validation after every step, every successful version-1 migration is
required to produce the same accepted bytes across supported engines. The host
still treats any trap, timeout, malformed/noncanonical output, or final schema/
budget failure transactionally under the unchanged all-or-nothing lifecycle.

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
  requested timeline-frame low/high 32-bit words, frame-rate numerator/
  denominator, RFC 8785 JCS render-parameter pointer, and exact parameter byte
  length. The parameter pointer is always `0x01000000`; the frame words encode
  the same non-negative global integer timeline frame used by the composition
  plan and parameter-animation resolver, with language-neutral reconstruction
  `frame = u32(low) + 2^32 * u32(high)`. The result must be no greater than
  `2^53 - 1` before the host uses it;
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

#### Canonical render-parameter record

Each render call receives exactly one top-level `RenderParameterRecordV1` JSON
object. It has one own property for every entry in the selected contribution's
manifest `parameters` array and no other property. Each property name is that
entry's `key`; each value is exactly the declared finite binary64 number,
boolean, or enum machine-id string. The record has no nested object, array,
`null`, contribution selector, descriptor id/type/version/enabled field,
animation metadata, local/source frame, or host-only state.

The host builds the record once from the immutable manifest, document/effect,
and owning-clip animation snapshot used to plan that call:

1. for each declared key, an own authored descriptor value is accepted only
   when its kind and number range or enum option exactly match the manifest. A
   present invalid value makes the stage `invalid` and follows the existing
   visible preview-bypass/export-block policy without calling plugin code; the
   default must not conceal it;
2. when a declared key is absent, the host puts that declaration's manifest
   default into this ephemeral record. Defaults seed creation/reset and this
   render-time completion only; it does not mutate the durable
   descriptor, history, recovery, or save data. Unknown forward-compatible
   descriptor keys remain durable and preserved, make the descriptor
   unsupported/bypassed under the existing rule, and never enter a version-1
   call;
3. after all static values/defaults are materialized, each valid effect track
   targeting this effect instance and a manifest-declared animatable number key
   resolves through the shared pure effect-animation evaluator at the exact
   requested global integer timeline frame passed in the call. The evaluator
   derives the existing clip-local frame, applies the existing boundary hold,
   exact-key, left-key easing/interpolation, and static-fallback rules. Its
   static fallback is the materialized base number: the valid authored value, or
   the manifest default when the key was absent. It returns a finite value inside
   the declared range. `step` is host-control
   metadata and never rounds or quantizes a resolved render value. Unknown,
   dangling, non-animatable, or invalid tracks/results retain the existing
   ignore/preservation and materialized-base-fallback semantics. Only a declared
   authored parameter that fails current contribution validation makes the stage
   invalid/bypassed; plugin rendering may not invent a divergent fallback.

Issue #77 must make plugin parameter declarations available to that same pure
effect-track resolution authority; it may not invent a second interpolation
path. Given the same immutable manifest/document snapshot and requested global
frame, preview, scrub, playback, and export therefore produce byte-identical
parameter records. An export uses its already-frozen export snapshot; mutable
preview or plugin state cannot affect these call bytes.

The complete object is serialized once with RFC 8785 JCS and then encoded as
UTF-8 without a byte-order mark. JCS emits no inter-token whitespace and sorts
raw property names by UTF-16 code units; because version-1 parameter keys use
the ASCII local-identifier grammar, that order is also ascending bytewise ASCII
order. JCS/ECMAScript string escaping and binary64 number serialization are
normative (`-0` serializes as `0`); `NaN`, infinities, lone surrogates, duplicate
keys, alternative number spellings, a trailing NUL, and any byte after the object
are forbidden. No Unicode normalization is performed. Version-1 enum ids and
keys already use the ASCII grammar, so their valid strings require no escape
substitution.

The resulting length is from 2 bytes (`{}`) through 65,536 bytes inclusive. The
host uses checked addition to prove the half-open slice
`[0x01000000, 0x01000000 + parameterByteLength)` stays within page 256, clears
that complete 64 KiB page, copies exactly the canonical bytes at `0x01000000`,
and passes their exact length with no terminator. A conforming module parses only
that slice against its selected contribution schema; it neither scans for NUL
nor supplies missing defaults. Parse/schema failure returns a failure code other
than success/identity, and the host discards the output. After the request
settles, the host clears the page again. Oversize or unencodable host input makes
the stage unavailable/failing before invocation and is never truncated.

This record is render-only. Migration continues to receive the separate cloned
static descriptor-parameter record under the migration ABI below; it receives
neither frame-resolved values nor render-time default materialization. Version 1
still rejects migration of any descriptor targeted by effect animation.

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
bounded WebAssembly byte string or a fresh copy from the optional exact-key raw-
module cache, plus the immutable validated manifest facts needed to distinguish
empty from nonempty migration arrays. The candidate itself selects the exact
render-general or migration-integer profile before scanning the module and
requires its profile id and normative table digest to match the activation/cache
identity. It always runs the complete selected-profile byte-policy parser without
invoking an engine API; only after parse success does that same worker call
`WebAssembly.validate`, asynchronous compilation, and fresh instantiation. The parent
does not synchronously iterate any attacker-driven WebAssembly section,
instruction, or initializer structure, and the deadline does not reset when
parsing or any later activation phase completes. A raw-byte cache hit skips no
parse, validation, compilation, or instantiation gate. Every path allocates new
imported memory and creates a fresh `WebAssembly.Instance` in the candidate. The
worker sends an instance-ready acknowledgement only after all phases finish. On
success the same worker becomes the dedicated runtime worker
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
and any requested raw-module cache entry's exact identity. For exactly one
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
instance, memory, port, and queue without waiting for plugin-controlled
acknowledgement. The parent waits only for a bounded, host-authored broker
termination acknowledgement before its fallback cleanup; retry creates fresh
owners. Only a parent-owned verified raw-byte cache entry may remain, and retry
still repeats every activation gate from a fresh copy.

As part of every export attempt's exact plugin preflight, before a sink or encoder
is acquired, the host creates a separate export-owned sandbox and fresh
activation-candidate worker for every required package. It instantiates a new
`WebAssembly.Instance` with newly allocated imported memory. The host may reuse
only a fresh copy of exact-key verified raw module bytes. It must not reuse or
share an editor `WebAssembly.Module`, compiled/JIT/engine artifact, worker,
instance, memory, tables, globals, port, queue, request generation, or any other
mutable module state. The export
port accepts export calls only; preview, scrub, Inspector, migration, and other
editor-session messages never enter its queue. Concurrent editor preview cannot
mutate export state.

The optional raw-module cache has one trusted-parent, session-only owner. Its
exact key contains plugin id, signer fingerprint, package digest, normalized
signed module path, signed expanded module length and SHA-256, negotiated host
API version, sorted selected capability id/version pairs, sorted selected
contribution id/kind/version pairs, binary-policy version, and normative opcode/
immediate-table digest. That policy portion is specifically the exact selected
profile id plus that profile's normative table digest; a render-general entry
cannot satisfy a migration-integer activation even when the raw module bytes are
identical. The first implementation holds at most eight entries and
charges each by the actual retained raw `Uint8Array.byteLength`; checked addition
caps the aggregate at 64 MiB. Insertion clones verified bytes into a private
write-once host-owned buffer whose reference/backing store is never exposed,
shared, transferred, or detached. Each activation receives a separate fresh
copy, so the retained entry has no in-use lease and may be evicted after copying.

Insertion evicts entries until both bounds fit, ordered deterministically by
oldest host access sequence and then lexicographic complete key. If eviction
cannot make room, activation may continue from a fresh copy of the verified
package bytes without insertion. A hit still rechecks current trust, revocation,
package availability, and the complete key, then repeats candidate-worker byte-
policy parsing, `WebAssembly.validate`, asynchronous compilation, and fresh
instantiation under the one non-resetting deadline. Cache pressure and a hit
never weaken or skip a gate or make execution necessary for project recovery.

Myrelith retains no `WebAssembly.Module`, compiled/JIT/native/engine code or
metadata, instance, imported memory, table, global, worker, port, queue, request
generation, or other mutable runtime state across lifecycles. A transient engine
artifact belongs only to its activation worker and becomes unreachable when that
worker terminates; browser-internal opaque engine caching is outside Myrelith's
ownership guarantee. Disable, uninstall, revocation, package replacement/update,
signer/digest/hash mismatch, binary-policy/ABI version change, and app teardown
remove matching raw-byte entries. Nothing is persisted to IndexedDB, OPFS,
recovery, or a project. The 64 MiB ceiling accounts only actual retained cache
buffers; fresh activation copies and transient parser/compiler allocations remain
bounded separately by the 32 MiB module limit, declaration/complexity ceilings,
sandbox/candidate concurrency, the non-resetting deadline, and termination.

Calls delivered to one export sandbox are serialized in ascending requested
timeline-frame order and, within a frame, the authored composition/effect-plan
order. The host never coalesces, skips, or replays a planned plugin call from a
checkpoint.
Terminal success destroys every export-owned worker, instance, and memory after
the final planned call and output transaction complete. Failure, cancellation,
or watchdog expiry makes the trusted parent terminate outstanding export workers
and settle their host-side requests without waiting for plugin-controlled
acknowledgement. It may wait only for the bounded host-authored broker
termination acknowledgement before fallback cleanup. Retrying or restarting an
export is a new attempt: it starts again at the first requested frame with
another fresh instance, so no partial or prior export state is inherited.

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
| Verified raw-module-byte cache | session-only; at most 8 private exact-keyed entries and 64 MiB aggregate actual retained `byteLength`; fresh copy per activation; deterministic oldest-access/key LRU; no compiled artifact or lease |
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
- crash during activation: retain an origin-local, owner-counted activation
  sentinel until every origin activation owner finishes successfully, so the
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

Execution is release-eligible only while all of these are independently reviewed
and green:

1. byte-level ZIP, canonical JSON, integrity, Ed25519, trust, update, rollback,
   and revocation fixtures including hostile archives; exact/+1 envelope/member/
   entry/path/length/base64url/lowercase-hex boundaries; duplicate/missing/extra
   keys and entries; wrong array order; noncanonical JSON/encoding; alternate
   payload or package-digest framing; and the complete canonical golden vector's
   exact manifest/Wasm/envelope lengths and hashes, message bytes, public key,
   signature verification, domain bytes, framed input, and package digest;
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
   and aggregate declaration boundary in the package-budget table. Profile
   fixtures must prove that any nonempty migration declaration selects
   `myrelith-wasm-migration-integer-v1` for the complete module and rejects
   `f32`, `f64`, and `v128` separately in parameters, results, block types,
   typed-`select`, locals, and globals; every float/SIMD constant, load, store,
   arithmetic, comparison, conversion, reinterpretation, float-related prefixed
   conversion, the complete `0xfd` SIMD category, and migration-profile
   `table.grow`; future/unlisted features must fail under both profiles.
   Otherwise-identical render-only/no-migration fixtures for every scalar-float/
   fixed-SIMD category and `table.grow` must remain accepted by
   `myrelith-wasm-render-general-v1` when the form is in its wider closed table.
   Uncalled functions,
   element/table-only functions, `ref.func`, mutable-table dispatch through
   `table.set`/`table.init`/`table.copy`/`table.fill`, and `call_indirect` must not
   bypass whole-module rejection. NaN-payload/reinterpret/branch bombs and
   resource-dependent `table.grow` variants must fail in the candidate parser
   before any engine API;
3. CSP/opaque-origin negative probes for network, storage, navigation, DOM, and
   worker escape attempts;
4. activation-worker promotion; a five-second parent deadline that begins
   before worker creation and never resets across parse/validate/compile/
   instantiate; parent responsiveness and termination during a near-limit parse;
   parse-failure proof that no engine API ran; same-worker parse-to-promotion
   identity; compile/instantiate termination, call watchdog, queue, memory,
   project replacement, cancellation,
   crash, late-message, and safe-mode tests; raw-module cache exact-key/count/
   actual-byte accounting, insertion/activation copy isolation, attempted
   mutation/transfer/detachment isolation, deterministic access/key LRU,
   pressure bypass, invalidation, and teardown; spies proving cold and hit paths
   both parse, validate, compile, and instantiate; and proof that no
   `WebAssembly.Module` or engine artifact enters or survives through the cache.
   Cache fixtures must bind the exact selected profile id and its canonical table
   digest, separate general from migration-integer identities, and prove that a
   prior general-profile acceptance never skips migration-integer rejection;
5. unknown/disabled/revoked descriptor round trips through save, recovery,
   undo/redo, reorder, remove, and migration rejection, including the version-1
   static-instance gate for every effect targeted by an animation track; fresh
   per-descriptor-chain migration workers/instances/memories/ports/queues/
   generations; same-chain sequential steps; reciprocal editor/export message
   isolation; deterministic serial multi-descriptor actions; terminal teardown;
   fresh retry; stale-generation rejection; and all-or-nothing final commit.
   Cross-engine goldens must run identical canonical input/step sequences through
   accepted integer-only migration modules and compare exact canonical output
   bytes, while float-created NaN payload and payload-dependent branch variants
   remain pre-engine rejection fixtures;
6. authored built-in/plugin stack-order pixels shared by preview and export,
   plus exact render-parameter ABI fixtures: `{}` at two bytes; declared-key
   completeness and ASCII/JCS order independent of authored insertion order;
   absent-key default materialization without document mutation; present wrong-
   kind/range/enum invalid bypass and undeclared-key unsupported bypass with no
   call; canonical escaping,
   binary64 exponent/decimal forms and `-0` to `0`; BOM, whitespace, duplicate-
   key, trailing-byte/NUL, and non-finite rejection; the maximum reachable valid
   8,577-byte record (64 distinct 64-byte keys and 64-byte enum ids); lower-level
   synthetic raw canonical-buffer 65,536-byte page-boundary and cap-plus-one
   rejection; exact fixed pointer/half-open length/no-terminator/page-clear
   behavior; requested-global-frame boundary/exact/interpolated animation with
   authored and absent-key/default static fallbacks and no `step` quantization;
   identical preview/export bytes from the same frozen
   snapshot and frame; and proof that migration receives none of this render-
   time materialization,
   plus stateful-module fixtures proving that every export starts from a fresh
   instance/memory, follows deterministic call order, and cannot inherit prior
   or concurrent preview, canceled export, or retried export state;
7. actionable install, permission, incompatibility, crash, retry, export-block,
   bypass-confirmation, disable, uninstall, and safe-mode accessibility;
8. focused/full tests, production build/typecheck, lint, production dependency
   audit, source fingerprints, and real Chromium verification;
9. a separate security reviewer explicitly signs off the residual risks in
   `PLUGIN_THREAT_MODEL.md`.

PR #123 implements the runtime behind these gates. Any failed gate blocks merge
or release; install, activation, preview, migration, and export continue to fail
closed rather than weakening the version-1 boundary.
