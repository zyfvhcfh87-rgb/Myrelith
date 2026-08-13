# Plugin threat model

Status: Issue #76 design. Scope is the proposed third-party plugin boundary,
not a claim that a runtime exists. The complete ABI, packaging, compatibility,
failure, and unsupported-capability contract is in [PLUGINS.md](PLUGINS.md).

## Overview

Myrelith is a local-first browser video editor. It handles user-selected media,
portable project JSON, origin-local recovery and file-handle sidecars, preview
pixels, and encoded output. Third-party effects would process sensitive frame
pixels and could otherwise threaten the editor's origin storage, local file
capabilities, network privacy, output integrity, and availability.

The proposed first runtime accepts only locally selected, signed offline
packages. Package code is WebAssembly, not JavaScript. It runs behind an
opaque-origin iframe broker in a dedicated worker, with one bounded imported
memory and no callable imports. The host copies one isolated RGBA8 layer into
that memory and copies an exact validated result back. The plugin receives no
ambient browser API and no project, file, network, storage, DOM, audio, codec,
or export-sink capability.

This design assumes plugin packages and plugin-bearing projects may be actively
malicious. A valid signature identifies byte continuity for one key; it does
not make a package safe. User consent does not replace isolation, bounds, or
failure containment.

## Threat Model, Trust Boundaries, and Assumptions

### Assets and security invariants

| Asset | Required invariant |
| --- | --- |
| User media and frame pixels | A plugin sees only pixels for an effect instance the user enabled; it cannot read source bytes, paths, unrelated layers, audio, or later frames without separate calls. |
| Local file capabilities | `File` and `FileSystemHandle` objects never cross the app/controller boundary into a manifest, store, sandbox, message, or project. |
| Origin storage | Plugins cannot access Myrelith IndexedDB, OPFS, Cache Storage, local/session storage, cookies, recovery, Recents, remembered media, proxy manifests, or trust records. |
| Network privacy | No plugin-controlled request, socket, beacon, WebRTC channel, navigation, form, popup, or download is possible. |
| Project truth | Projects contain only bounded primitive descriptors. They cannot carry code, grants, package locations, trust, revocation changes, or an instruction to install/execute. |
| Preview/export integrity | Authored stack order and the exact v1 display-referred sRGB RGBA encoding are shared. Every export starts in a newly instantiated export-owned worker/memory, receives only deterministically ordered export calls, and shares no mutable state with preview/scrub. Missing/failing plugins are visible; export aborts by default instead of silently dropping an effect. |
| Editor availability | Package parsing, decompression, expanded WebAssembly signatures/locals, code-body bytes, decoded instructions/immediates/control, activation, fixed memory regions, queues, calls, diagnostics, and retries are bounded. Parent-realm deadlines can terminate a non-cooperative activation or runtime sandbox. |
| Supply-chain identity | Every executed byte is covered by the verified package integrity table and Ed25519 signature; signer and digest changes cannot inherit trust/grants silently. |
| Recovery | Missing, denied, revoked, incompatible, crashed, and safe-mode plugin descriptors remain ordered, editable, saveable, and recoverable without execution. |

### Actors

- **Project author:** may craft a syntactically valid `.myrelith` file with
  hostile plugin descriptor ids, versions, values, counts, or animation targets.
- **Package author:** controls every package byte, manifest value, signature key,
  WebAssembly instruction, export behavior, return code, runtime duration, and
  output pixel.
- **Supply-chain attacker:** may replace an unsigned download, compromise a
  publisher build system or signing key, replay an old signed version, or trick a
  user with a look-alike id/name/key.
- **Local operator:** chooses packages, reviews signer fingerprints and
  permissions, applies effects, enables bypass, imports revocations, and may make
  an unsafe trust decision.
- **Myrelith release developer:** controls built-in trust/revocation keys, host
  policy, ABI implementation, CSP, package parser, compositor, and UI copy.
- **Browser/OS:** enforces WebAssembly memory safety, workers, iframe sandboxing,
  CSP, Web Crypto, storage origins, and process termination. It is trusted to
  enforce its documented boundary but is still probed at runtime.

### Trust boundaries

1. **Local file to package parser.** All bytes are untrusted. No allocation,
   path use, decompression, JSON parse, or hash may occur beyond a checked bound.
2. **Parser to integrity/signature verifier.** Normalized paths, byte lengths,
   and exact entry bytes must match one signed canonical table. Parser ambiguity
   is a verification failure.
3. **Verified package to local trust policy.** Cryptographic validity is not
   user trust. Signer continuity, revocation, downgrade, and permissions are
   independent checks.
4. **Trust policy to compatibility registry.** A trusted package is still inert
   until required host API, permissions, contribution kind, descriptor version,
   and runtime features match exactly.
5. **App window to opaque-origin broker.** The app sends only verified module
   bytes, bounded metadata, and a private port. The broker has no same-origin
   access.
6. **Broker to worker/WebAssembly.** Only host-authored JavaScript runs. Before
   an engine API sees the module, trusted-parent byte validation rejects a start
   section, canonically scans every policy-allowed body/initializer opcode and
   immediate, and enforces every declaration/payload/decoded-complexity ceiling.
   A fresh disposable worker owns validation, compilation, and instantiation
   under one non-resetting
   parent deadline; if ready it becomes the sandbox's runtime worker, otherwise
   it is terminated. The untrusted module receives imported bounded memory but
   no callable imports.
7. **Compositor to plugin frame call.** The host copies one exact pixel buffer
   and minimal integer metadata, applies a watchdog, validates the complete
   response, and accepts no partial result.
8. **Session registry to portable project.** Installed package/trust/grant facts
   may explain a descriptor but can never mutate or disappear it implicitly.
9. **Preview, migration, and export.** Preview and export consume the same effect
   plan, but export separately preflights fresh export-owned instances and fails
   transactionally. Only
   digest-bound immutable module bytes or compiled code may be reused; no worker,
   instance, memory, port, queue, request generation, or mutable module state
   crosses from preview/scrub into export.
   Explicit descriptor migration is a third boundary: each descriptor chain is
   freshly activated with its own mutable owner and migration-only port, and no
   preview, export, or other descriptor-chain state crosses it.

### Attacker-controlled inputs

- archive headers, compression ratios, names, case/Unicode forms, sizes, counts,
  overlaps, trailing bytes, and compressed payloads;
- manifest JSON bytes, duplicate keys, ids, labels, semantic versions, API and
  permission ranges, entry path, memory request, contribution/parameter schema;
- signature envelope, public key, fingerprint text, integrity table, signature,
  digest, version ordering, and signer changes;
- WebAssembly binary sections, compressed signature/local multiplicities,
  declaration counts, body sizes, opcode streams, prefixed subopcodes,
  instruction immediates/vectors, control depth, branch tables, initializer
  expressions, start section, active/passive data modes, features, imports,
  exports, memory/table limits, segment payloads, code, traps, loops, output
  bytes, return values, and timing;
- project effect descriptors, parameter primitives, versions, enable state,
  order, counts, string lengths, ids, and animation targets;
- plugin-provided diagnostic codes/text and message ordering;
- local revocation-bundle bytes before their Myrelith signature is verified.

User/operator-controlled inputs are package selection, explicit trust and
permission decisions, effect application, retry, bypass, disable/uninstall,
offline revocation import, migration, export-with-bypass confirmation, and safe
mode. Developer-controlled inputs are shipped keys, host limits, CSP, ABI,
policy reason strings, and built-in revocations.

### Assumptions and residual trust

- The browser and OS are not already compromised. A browser sandbox,
  WebAssembly engine, JIT, or process-isolation vulnerability may defeat this
  design and must be handled through browser updates and disabling plugins.
- Myrelith's release artifacts and built-in release/revocation keys are trusted.
  Compromise of that supply chain can authorize malicious host code and is
  outside a plugin-only containment proof.
- A plugin granted frame access is allowed to learn and transform those frame
  pixels. Isolation prevents expanding that grant; it cannot make the granted
  pixels non-sensitive.
- CPU/cache timing, total call count, dimensions, and coarse watchdog behavior
  can leak limited information within the sandbox. No cross-origin secrets are
  intentionally co-resident, but hardware side channels are residual risk.
- Removing an iframe/terminating a worker must remain responsive in supported
  browsers. Issue #77 must prove this with hostile infinite-loop fixtures; a
  browser that cannot contain them is unsupported for plugins.
- Signature fingerprints establish key continuity, not legal identity or
  reputation. Look-alike names remain a user-interface/social-engineering risk.

## Attack Surface, Mitigations, and Attacker Stories

### Package parsing and decompression

**Attacker story:** a package uses traversal, duplicate/colliding names, ZIP64,
overlapping entries, forged sizes, symlinks, or a decompression bomb to overwrite
data or exhaust memory before verification.

**Controls:** parse a deterministic in-memory ZIP subset; reject every ambiguous
or unsupported feature; normalize and validate names before use; never extract
to disk; enforce archive, entry, module, manifest, count, and running expanded
budgets before allocation; require the signed table to list every exact entry.

**Residual risk:** parser bugs and decompressor vulnerabilities. Hostile archive
fixtures, fuzzing, locked dependencies, and production dependency audit are
required. Package parsing remains outside the plugin sandbox, so this is one of
the highest-risk implementation surfaces.

### Signature, identity, downgrade, and revocation

**Attacker story:** a malicious download reuses a trusted name, swaps a module
after manifest inspection, changes signer on update, replays an older vulnerable
version, or relies on signature-valid but revoked bytes.

**Controls:** sign the complete sorted integrity table; verify exact bytes before
trust UI; bind installation and grants to plugin id + signer fingerprint +
package digest; treat signer changes and widened permissions as new decisions;
prompt on downgrade; consult local built-in/user/imported revocations before
registration and every activation.

**Residual risk:** compromised publisher keys and convincing look-alike names.
Offline revocation cannot learn a newly announced incident until the app or user
imports an updated signed deny set. UI must say “signed by this key,” never
“safe” or “verified publisher.”

### Manifest ambiguity and compatibility confusion

**Attacker story:** duplicate JSON keys, unknown fields, overlong labels,
prototype-looking parameter keys, numeric steps smaller than local binary64
spacing, reused render exports, version-range tricks, an unverifiable intermediate
migration schema, optional-permission downgrades, or URL-shaped entry paths cause
different reviewers/components to interpret one package differently.

**Controls:** byte limit and duplicate-key rejection before parse; canonical
JSON; exact keys at every object; ASCII-bounded ids/paths/entrypoints; shared
durable numeric bounds, a positive step that makes representable progress from
both declared range endpoints, and reserved-key rejection; unique ids/render
entrypoints/parameter keys/options; disjoint render/migration export names;
bounded forward-only migration declarations whose explicit exports all lead to
the current descriptor version; generic non-final migration outputs instead of
invented historical schemas; inclusive integer version ranges; required-
unavailable is incompatible; optional-unavailable remains explicit and
unselected; no compatibility substitution.

**Residual risk:** future schema evolution can create confused-deputy behavior
if old and new code disagree. Each manifest/API/capability/contribution schema is
independently versioned and old implementations must remain exact.

### Remote loading and data exfiltration

**Attacker story:** a project points at attacker JavaScript, a package fetches a
second stage, pixels are sent through fetch/WebSocket/WebRTC/beacons/images/forms,
or navigation/downloads encode data.

**Controls:** project schema contains no package URL; installation begins only
from a user-selected local `File`; manifest runtime entry is a safe relative
`.wasm` path; package JavaScript is rejected; WebAssembly has no callable
imports; iframe has an opaque origin and strict CSP; no navigation/form/popup/
download tokens; network APIs receive no reference; negative real-browser probes
must fail closed.

**Residual risk:** browser CSP/sandbox bypasses, side channels, and newly added
web request primitives not covered by old CSP behavior. `default-src 'none'`,
explicit `connect-src 'none'`, current browser support gates, and repeated
negative probes reduce but do not eliminate browser-engine risk.

### Local file/media overreach

**Attacker story:** an effect reads source containers, filenames/paths, offline
media, hidden tracks, unrelated layers, future frames, audio, clipboard, or
remembered directory capabilities.

**Controls:** only a copied isolated RGBA8 layer crosses the call boundary. The
manifest-unique render export is the contribution discriminator; arguments carry
only width/height/stride, exact frame, rational rate, and the effect's own bounded
params. Every input and successful output pixel is four `R, G, B, A` bytes:
nonlinear IEC sRGB OETF code values over sRGB/Rec.709 primaries and D65, plus
independent straight/unassociated 8-bit alpha. Linear-light, Display-P3, and
premultiplied interpretations are outside version 1. The host converts before
copy-in and after copy-out; preview and export share that conversion. No ICC or
other profile/gamut metadata enters the sandbox. App controllers retain all
file/handle/URL ownership. The module has no browser imports. Permission copy
explicitly names the frame access grant.

**Residual risk:** the granted frame itself may reveal faces, documents, or other
sensitive content. A malicious effect may encode earlier frames into later output
while one editor or export sandbox remains alive. That temporal state is part of
the granted computation within one owner lifecycle; deterministic export order
makes it reproducible, not pure. Version 1 destroys editor state on effect
removal/project replacement and destroys export state at every terminal outcome.
State never transfers between those lifecycles: each export attempt uses a fresh
export-owned worker, instance, and memory.

### Origin storage and project crossover

**Attacker story:** a plugin reads recovery snapshots, proxy bytes, recent file
handles, another project's plugin state, or leaves durable tracking data.

**Controls:** opaque-origin broker; no storage/network imports; first version has
no plugin storage capability; packages/grants are host-owned records; project
copy does not carry them; safe mode avoids activation; sandbox and memory are
destroyed on project replacement.

**Residual risk:** browser bugs or inadvertent host messages. Message schemas
must reject unknown fields and use exact project/sandbox generations. Future
persistent storage is a new capability and threat-model review, not an extension
of frame access.

### WebAssembly/JIT escape and import smuggling

**Attacker story:** a module imports JS/WASI functions, declares shared or
unbounded memory, exploits an unsupported feature/parser discrepancy, creates
huge tables, traps the engine, or exploits a browser JIT vulnerability.

**Controls:** the trusted parent parses the raw binary before
`WebAssembly.validate`, compilation, or instantiation and rejects every start
section. Allow exactly one import, the non-shared bounded host memory, and reject
all function/global/table/tag imports plus defined memories and tags. Enforce at
most 1,024 types, 128 parameters and 16 results per function type, and 16,384
expanded signature fields; 8,192 imported-plus-defined functions; 2,048
expanded code locals per defined function and 16,384 per module; 2,048
parameters-plus-locals per defined function and 16,384 aggregate defined-
function runtime slots after charging the referenced parameter vector for every
function that reuses it; 16 imported-plus-defined tables; one imported-plus-
defined memory; 2,048 imported-plus-defined globals; 8,192 exports; 1,024
element segments and 4,096 aggregate element initializers; 1,024 passive data
segments and 8 MiB aggregate data payload; 16,384 aggregate raw type/import/
function/table/memory/global/export/element/data/tag section entries; and a
32,768 checked sum of raw entries, expanded signature fields, and defined-
function runtime slots.
Independently cap each defined-function payload (locals plus expression) at
256 KiB and their checked aggregate at 16 MiB; decoded opcodes at 65,536 per
body and 1,048,576 per module; simultaneously open explicit `block`/`loop`/`if`
constructs at 256; `br_table` vector labels at 1,024 per instruction, 16,384 per
body, and 65,536 per module; and constant/initializer expressions at 64 opcodes
each and 16,384 per module. Every opcode, prefix/subopcode, and immediate uses
one closed binary-policy-versioned grammar. A prefixed opcode counts once;
structural delimiters and each expression's final `end` count. The mandatory
`br_table` default is decoded and depth-checked but is not a vector label.
Vector immediates are contained and bounded before allocation; typed `select`
requires exactly one supported result type. Branch targets, `else` placement,
and the fixed control stack must be valid, and one final `end` must consume the
exact body/expression with no trailing byte.

Initializer expressions admit type-matching numeric/vector constants for defined
numeric globals, `global.get` of an earlier immutable defined numeric global,
and only integer `add`/`sub`/`mul` as extended-constant operators; the parser
type-checks the small stack expression and its one declared result. Element
offsets are exactly one `i32.const`; items use the exact legacy function-index or
single `ref.func`/`ref.null funcref` forms. Indexes must be in range. Imported
globals, every other extended-constant/reference form, malformed/truncated/
overflowing/noncanonical immediates, and unlisted features/opcodes fail before
engine work. The closed function-body table is derived from dated WebAssembly
Core 2.0 grammar, while only that explicitly listed Core 3.0 initializer subset
is added. Threads/atomics, tail calls, exceptions, typed function references,
GC, memory64, multi-memory, relaxed SIMD, and every unlisted proposal are rejected.
Require every table maximum, cap each and both aggregate initial and maximum
table entries at 4,096, and require one fixed-size host memory from 258 through
1,025 pages. Pages 0-127 are the module's 8 MiB passive-data reserve, 128-255
its 8 MiB stack/heap workspace, page 256 the host parameter/migration-input
page, and pages 257 onward the host pixel/migration-output region. At 1,025
pages that final region is 48 MiB/12,582,912 RGBA pixels; a request `P` supports
only `(P - 257) * 16,384` pixels. Reject every active data segment, require the
data-count value to equal the data-section count, and allow only passive
segments plus lazy `memory.init`/`data.drop` into the data reserve during a
watchdog-bounded call; the engine bounds-checks dynamic copy ranges. Reject zero
local-group multiplicity, checked-addition overflow, noncanonical encoding,
duplicate singleton section, function/code count mismatch, body/section overrun,
missing or early final `end`, trailing bytes, additional memory, WASI, unknown
value types/features, unexpected entrypoint types, and oversized sections before
an engine call. The imported minimum and maximum
and host initial/maximum all equal the manifest request, preventing growth. The
module can corrupt its own imported memory, so the host rewrites fixed input
regions before a call and copies/validates only its exact output afterward; the
layout prevents conforming toolchain regions from colliding but is not an
intra-module security boundary. A larger valid project surface remains valid,
but the plugin is unavailable in preview and blocks export unless the user
accepts the existing reviewed bypass. A fresh, disposable activation-
candidate worker performs engine validation, asynchronous compilation, and
instantiation under a non-resetting five-second trusted-parent wall-clock
deadline. A successful candidate becomes the dedicated runtime worker for its
requesting lifecycle; timeout or failure destroys the candidate and sandbox. An
editor runtime is never reused for export or migration. Every export preflight
creates a new export-owned worker, instance, and imported memory. Every explicit
migration action creates a new migration-only owner per descriptor chain; a
multi-descriptor action runs those distinct owners serially and stages one final
atomic commit. Only digest-bound immutable module bytes or compiled code may be
cached across lifecycles. Runtime-probe and fail closed.

**Residual risk:** browser-engine vulnerabilities and binary-parser mistakes.
Keeping browsers current and shipping an emergency local revocation are required.
Defense does not claim WebAssembly alone is a complete security boundary.

### Denial of service and resource exhaustion

**Attacker story:** a start function or pathological compiler input monopolizes
activation; compact type/local vectors expand to millions of compiler slots;
huge bodies, dense instruction streams, deep control trees, `br_table` and
typed-`select` vectors, or initializer expressions exhaust parser/compiler
memory; huge declaration/segment vectors exhaust compiler memory; active data or
a module allocator collides with host I/O; infinite loops, deep recursion,
repeated traps, memory/table growth, huge output messages, queue floods,
diagnostic spam, slow decompression, or crash/retry loops freeze the editor or
exhaust memory.

**Controls:** fixed package/manifest/module, raw/expanded/combined declaration,
body-byte, instruction, control-depth, branch-table, initializer-expression,
segment, memory-region, and table limits; byte-level start-section and active-
data rejection before engine work; canonical closed-allowlist decoding of every
opcode and immediate with exact body/expression termination, checked per-type,
per-function, per-body, repeated-signature, and module accounting;
fixed-size imported memory with separately budgeted passive-data, workspace,
parameter, and pixel ranges; a fresh
activation-candidate worker under the non-resetting five-second trusted-parent
deadline; one active call per sandbox, two globally, bounded/coalesced queue;
trusted-parent call watchdogs; whole-sandbox termination; atomic export-slot
reservation under the hard eight-resident ceiling with no mid-export eviction or
batch reinstantiation; one pinned serial migration slot with a fresh terminal
owner per descriptor chain; a session-only compiled-code cache capped at eight
entries and a 64 MiB accepted-raw-module-byte charge, with checked accounting,
deterministic idle LRU eviction, in-use leases, and trust/revocation/update/
policy/app-teardown invalidation; exact response sizes; bounded diagnostics;
three consecutive failures disable for the session; no background activation;
safe mode and stale-activation sentinel.

**Residual risk:** terminating an activation or runtime worker may briefly
consume a CPU core or renderer memory, and browser scheduling/process sharing can
still degrade the tab. Activation and preview deadlines trade effect availability
for editor responsiveness. A sandbox escape is not required for a meaningful
availability attack.

### Message confusion, stale responses, and output corruption

**Attacker story:** plugin replays an old result after seek/project replacement,
sends a response for another instance, returns partial/oversized pixels, detaches
buffers, interprets nonlinear sRGB bytes as linear-light or Display-P3, races
cancellation, or injects diagnostic HTML.

**Controls:** private port, exact protocol version/type/keys, sandbox generation,
project generation, instance id, monotonic request id, exact lengths, one in
flight, latest-wins preview, deterministic non-coalesced export/migration
ordering, separate editor/export/per-descriptor-migration ports and mutable
instances, migration-only messages with no frame/editor/export traffic,
abort/close settlement,
late-response rejection, copy-in/copy-out ownership, one exact IEC
sRGB/Rec.709-primary and D65 nonlinear RGBA encoding in both directions,
straight alpha, shared preview/export host conversion, no ICC/profile metadata,
cleared reusable memory, and escaped bounded plain-text diagnostics. Every
terminal export outcome destroys its instance; retry starts from the first
requested frame in another fresh sandbox instead of restoring a checkpoint.

**Residual risk:** host lifecycle bugs. Tests must cover cancel/retry/revoke/
update/project replacement/close at every awaited boundary, including staged
multi-descriptor migration and its one final generation-checked commit.

### Project portability, migration, and data loss

**Attacker story:** opening a project auto-installs or executes code; an older
host drops unknown descriptors; a non-final migration feeds oversized, nested,
or ambiguous data into the next step; a changed schema or unit silently
reinterprets retained effect keyframes; a failing migration corrupts params/
animation; revocation removes authored data; export silently omits an effect.

**Controls:** project stores only bounded descriptors; unknown types/versions/
keys/animation targets preserve and bypass; open never installs/prompts/migrates/
executes; migration follows only manifest-declared version steps and typed Wasm
exports, is explicit, sandboxed, and cloned. The action freezes every original
target and generation, resolves every chain, and rejects all targets before code
if any fails the static-animation gate. Immediately before each chain, current
trust/revocation/availability, cache binding, and target snapshot are rechecked.
Every descriptor chain freshly owns a migration-only worker, instance, fixed
imported memory, private port, queue, and generation. It can carry temporal state
only across sequential steps of that one chain and receives no pixels or preview/
scrub/Inspector/export messages. A multi-descriptor action runs distinct owners
serially in immutable document order under one reserved sandbox slot, destroys
each before activating the next, and stages all candidates outside the document/
history. Before another step can run, every
non-final output must be strict UTF-8 canonical JSON no larger than 65,536 bytes:
one object with at most 64 entries, keys and string values using the bounded
manifest-v1 local-identifier grammar, the three reserved record keys excluded,
and only booleans, finite +/-1,000,000,000 numbers, or those bounded strings. Only
static effect instances are eligible under descriptor migration ABI version 1:
before any migration export runs, the host rejects the entire chain if an entry
in the owning clip's `ClipAnimation.effectTracks` targets that effect id. It does
not attempt key-range-only validation because a future, separately versioned
contract must define how animated parameters change schema or unit. The final
output must exactly match the current contribution schema and pass durable
descriptor and whole-document replacement budgets. One action-wide history
commit occurs only after all targets succeed and their exact starting values and
generation still match. Success, failure, malformed output, trap, cancellation,
watchdog expiry, trust/revocation change, project replacement, stale state, or
commit rejection settles outstanding host work and destroys the current owner
without waiting for plugin acknowledgement. Any non-success discards every
staged candidate and retains every original descriptor plus complete animation;
retry is fresh, and only exact-key immutable compiled code may survive. Revoke/
disable/safe mode never delete descriptors; export blocks by default and names
every unavailable instance. Issue #77 must implement and fixture these byte-level,
static-instance, fresh-owner, terminal-cleanup, and action-atomicity gates before
any migration export can execute.

**Residual risk:** a user can deliberately remove an opaque effect or explicitly
export with reviewed bypass. Those are visible user edits, not silent recovery.

### Permission fatigue and social engineering

**Attacker story:** a package uses a trustworthy name, verbose labels, repeated
prompts, fake warnings, or an “optional” permission that changes behavior to
pressure acceptance.

**Controls:** host-authored bounded labels and prompt layout; display stable id,
signer fingerprint, digest, requested access, memory, update/downgrade state, and
failure policy; no prompts during project open/playback/export; deny by default;
one explicit Manage Plugins action; plugin text cannot create dialogs/HTML.

**Residual risk:** users can approve malicious code. The narrow first permission
limits consequence but still reveals applied frame pixels and permits visual
output tampering.

## Severity Calibration (Critical, High, Medium, Low)

Severity assumes a malicious project or package can reach the stated surface in
a supported browser without prior browser/OS compromise.

### Critical

- sandbox or browser-engine escape that executes in the Myrelith/app origin or
  native OS context and can read arbitrary local file capabilities;
- plugin access to remembered directory/file handles, recovery media, or other
  origin secrets without a user grant;
- automatic project-driven remote code loading or unsandboxed JavaScript
  execution;
- compromise of a Myrelith built-in signing/revocation key combined with an
  automatic trusted-code path.

### High

- network exfiltration of granted frame pixels or project/media metadata;
- persistent same-origin storage access enabling cross-project secret theft;
- signature/integrity/parser confusion that executes bytes different from those
  shown and approved;
- silent export corruption or omission affecting many frames without an
  actionable warning;
- archive/parser memory corruption or a reliable tab/browser compromise;
- a package update inheriting trust/grants across an unapproved signer change.

### Medium

- reliable editor/tab denial of service that requires package installation but
  survives watchdog/restart or defeats safe mode;
- cross-instance/stale-response confusion that places pixels on the wrong frame
  or project but does not disclose them externally;
- permission-prompt spoofing or repeated background prompting that materially
  changes a user's decision;
- data-loss bugs that delete unknown plugin descriptors, params, order, or
  animation during save/recovery/migration;
- local revocation bypass that requires an already installed, explicitly trusted
  package but no browser exploit.

### Low

- bounded single-call crashes/timeouts with clear bypass/retry and no data loss;
- incorrect or ugly pixel output from an effect the user explicitly applied,
  when export detects or clearly reports the failure;
- bounded diagnostic spoofing rendered as escaped plugin-attributed text;
- package compatibility or install failures that preserve the previous version
  and project data;
- coarse timing leakage such as dimensions, call count, or watchdog class when
  no unrelated secret is exposed.

Out of scope for a plugin-only finding are a malicious local user with direct
filesystem/browser-profile access, an already compromised browser/OS, and visual
misbehavior that is exactly the granted effect's declared operation with no
boundary expansion. Those may still be product-quality issues, but they do not
demonstrate a plugin trust-boundary failure.
