# Issue #197: reusable effects and video buses

Status: proposed implementation plan, awaiting user approval. No product code
has changed for this issue. Inspected on 2026-09-06 at merged master `573cb45`,
on `codex/issue197`.

Issue: [#197](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/197).
The next implementation starts with Gate 1. Approval covers the sequence below;
ordinary successful gates do not require another permission round. A failed
track/master proof requires a concrete revised proposal before that slice ships.

## Intended workflow

Select a clip, choose Copy attributes, select destination clips, then choose
Paste attributes. The dialog names the destinations and lets the user select
attribute groups, include animation, and append or replace effects. Apply is
one undoable edit across every destination. A rejected destination rejects the
whole operation and explains why.

The Effects Inspector also supports copying the complete stack or checked
effects in their authored order. Save preset stores a named local template.
An effect browser searches built-ins, installed plugin contributions, and local
presets, showing descriptions and the current target's capability restrictions.

Later gates add reviewed pixel effects, blend modes, and video track/master
stacks. Adjustment items remain the way to affect a chosen timeline interval.

## Current implementation and constraints

These are source observations, not new acceptance results:

| Existing owner | What this issue must reuse |
| --- | --- |
| `src/domain/effectStack.ts` | Versioned `EffectDescriptor`, registry defaults, source-layer/post-composite declarations, unknown preservation and capability resolution. Current built-ins are color adjustment, mask, and chroma key. |
| `src/domain/effectBounds.ts` | Descriptor bounds and aggregate effect/parameter/string budgets. |
| `src/domain/clipAnimation.ts`, `sourceTimeMap.ts` | Effect-id remapping, integer clip-local keys, interpolation, and durable source-time intent. Merely cloning source ticks would make later destination retiming wrong. |
| `src/domain/projectSequences.ts`, `src/state/documentStore.ts` | Project-wide identity/budget checks and one whole-project undo entry. Dormant sequences count too. |
| `src/domain/adjustmentItems.ts`, `src/pipeline/render.ts` | Adjustment effects process the accumulated lower picture and borrow existing transition scratch. That is not isolated track processing. |
| `src/domain/projectVideoCompositionPlan.ts` | Nested sequence plans currently flatten into paint order with explicit backgrounds. Track/master scopes cannot be inferred later from a leaf track id alone. |
| `src/pipeline/videoEffectStageExecution.ts` | Ordered built-in/plugin execution. Preview and each export keep separate runtime ownership. |
| `src/pipeline/blendModeCapabilities.ts` | Concrete-context probing and source-over fallback. Current names are normal, multiply, screen and overlay. |
| `src/domain/renderSurfaceBudget.ts`, `src/app/mediaResourceAdmission.ts` | Render allocation gates and Program/audio priority over optional multicam previews. New persistent surfaces must enter both applicable accounting paths. |

The documented equal-size 3840 x 2160 lens/export path accounts for seven RGBA
surfaces, 232,243,200 bytes. One additional full-size RGBA surface costs
33,177,600 bytes; two would exceed the 256 MiB render ceiling. This arithmetic
is not a measurement of total browser memory. Pixel arrays, plugin memory,
decoded frames and nested live allocations also need explicit accounting.

## Gate 1: clip attributes and effect copy/paste/reset

Deliver one complete domain-to-UI slice with no portable-schema change.

- Attribute groups: transform and its animation; crop/flip/scale-lock; opacity
  and its animation; blend mode; clip audio settings and gain/balance animation;
  visual effect stack and its owned animation. Only groups supported by every
  destination are offered. No implicit linked-partner edits.
- Preserve destination asset, text content, lens correction, source mapping,
  timeline range, name, links and transitions. Lens copying and audio-effect
  stack editing are outside this first visual-effect workflow.
- Copy a defensive snapshot from one source clip. Complete-stack copy preserves
  descriptor order, version, enabled state, omitted defaults and unknown intent.
  Selected-stack copy includes only the checked descriptors and their keys.
- Mint fresh effect ids per destination against the complete project and the
  pending batch. Remap every owned keyframe target. Preserve orphan/future
  tracks in complete-stack copies under fresh unattached ids so they cannot
  accidentally bind to an existing destination effect. Selected copies exclude
  unrelated orphan tracks.
- Default animation timing is exact clip-local frame offsets from destination
  start. Do not stretch to fit or discard keys outside the visible duration.
  Recompute source-time intent through the destination's canonical time map.
  Unrepresentable mappings reject atomically. Static text cannot receive keys
  while the current animation contract forbids them.
- Append preserves the destination stack and adds the copied stack. Replace
  explicitly replaces the whole destination stack and its effect animation.
  Attribute replacement clears/replaces only animation owned by chosen groups.
- Reset uses current registered defaults and clears only the chosen groups'
  animation. Effect reset preserves unknown parameter keys. Unsupported
  descriptors cannot be silently removed by Reset; removal is a separate action.
- Clipboard lifetime is the current project session. It survives source edits,
  deletion and sequence navigation as a snapshot, and clears on project
  replacement/exit. It contains data only and does not access the OS clipboard.
- Capture the exact project, sequence and target selection when opening Paste;
  recheck them at Apply. Locks, duplicates, incompatible kinds, malformed data,
  id collisions, or any clip/document/project budget failure produce no mutation
  and preserve the redo branch. Idempotent Reset creates no history entry.

Proposed public shape, subject to ordinary implementation refinement:

```ts
type StackPasteMode = 'append' | 'replace'
type ClipAttributeGroup =
  | 'transform' | 'crop-and-flip' | 'opacity' | 'blend'
  | 'audio-settings' | 'effects'

// Templates reuse EffectDescriptor and ClipAnimation value contracts.
// They never contain a Clip, source mapping, media reference, or runtime owner.
captureClipAttributes(source, selection): AttributeTemplateResult
planAttributePaste(project, sequenceId, targetIds, template, options, idFactory): EditResult
resetClipAttributes(project, sequenceId, targetIds, groups): EditResult
```

The pure operation constructs and validates the entire candidate before the
store commits once. The app controller owns clipboard lifecycle and dialog
currentness; a small state projection exposes availability and outcomes. UI
does not loop through existing single-effect store actions to fake a batch.

Proof: fresh ids across multiple destinations and dormant sequences; selected
order; omitted defaults; unknown/future/orphan preservation; trimmed, retimed,
frozen and different-duration destinations; locked mixed selections; boundary
budgets; exact undo/redo and redo preservation after rejection; project change
while Paste is open; keyboard activation, focus and narrow Inspector layout.

## Gate 2: local presets and searchable browser

Reuse Gate 1's stack instantiation and atomic application.

- Version 1 presets contain static effect descriptor templates, with instance
  ids minted on application. Saving an animated stack captures resolved values
  at the current playhead and explicitly says that keys are not included.
  Clip attributes continue through Copy/Paste; presets are effect stacks.
- Use an exact-key, versioned library envelope and strict bounded template
  parser. Proposed limits: 100 presets, 80 characters per name, 32 effects per
  preset, 128 KiB serialized UTF-8 per preset, 2 MiB per library. Existing
  descriptor/project limits apply too. These are proposed admission ceilings,
  not measured performance claims.
- Store through one app-owned IndexedDB repository and transactional writes.
  Zustand holds serializable library/status facts. The library is independent
  of project save/recovery, and applying a preset copies ordinary descriptors
  into the project so later preset deletion cannot change that project.
- Unknown bounded types/versions stay visible and bypassed. Templates have no
  media, package, signature, grant, runtime or fetch fields. Resource-bearing
  strings such as URL/data/blob/file references are rejected for presets;
  primitive payloads never gain a loader or execution path. Plugin use still
  requires the existing installed, trusted sandbox contribution.
- A corrupt record is unavailable with an explanation; retain valid siblings.
  Unsupported future library versions remain untouched and read-only. Storage
  failure cannot report a successful save or destroy an existing record.
- Import/export decision for version 1: local library only, no preset-file
  import/export or external clipboard parsing. Explain that clearing browser
  site data removes saved presets. A portable preset exchange format can be a
  later version with a separately tested parser and migration contract.
- Search matches names/types/descriptions. Filters distinguish built-ins,
  installed plugins and presets. Native controls expose target stage, missing
  capabilities, budget reasons and unavailable entries without claiming that
  renderer support equals plugin trust.

Proof: reload persistence, duplicate names/rename/delete, quota and transaction
failure, corrupt records, future versions, bounds, forbidden payloads, missing
plugin capability, search and keyboard use, and project replacement during an
asynchronous save/load. No library operation enters timeline undo history.

## Gate 3: measured built-ins and blend expansion

Start with bounded blur, sharpen and vignette candidates. Evaluate drop shadow
and outline next. Crop/transform utilities should write the existing canonical
fields instead of adding a second geometry model. Final promotion is based on
documented pixels, work and ownership evidence, not a filter-count target.

For every promoted descriptor, extend the existing registry and shared executor.
Specify version, defaults, allowed stages, color encoding, straight versus
premultiplied alpha, edge sampling, parameter/work bounds, transparent pixels,
identity fast path and preview scaling. Spatial radius must remain in authored
project units when preview resolution changes. Alpha-neighborhood operations
must avoid hidden-RGB fringes. Record exact reference pixels and tolerances
before comparing real Chromium preview and export.

Preregister timing and scratch-byte acceptance limits before measuring 720p,
1080p and 4K, including repeated and mixed plugin stacks. Reject or narrow a
candidate that cannot meet its declared work/memory envelope. Keep rejected
results and label them; do not silently weaken the gate.

First additional blend candidates: darken, lighten, difference and exclusion.
Extend the pure sRGB/alpha oracle, allow-list, concrete-context probe and UI
together. Test transparent pixels, partial opacity, text, same/mixed crossfade
intent, setter rejection and thrown probes. Preserve unsupported authored
names and source-over fallback. Existing output without new effects stays exact.

## Gate 4: track/master stage and resource proof

Prove the following proposed semantics before changing schema or product UI:

1. Each clip retains current lens, geometry, mask/key, effect and plugin order.
2. A track stack processes only that track's isolated visual result, after
   clip opacity and transition weighting, before its result meets lower tracks.
   Preserve the existing ordinary/crossfade outer blend intent. An empty track
   stays transparent. A track with no stack uses the unchanged rendering path.
3. Adjustment items still process the accumulated lower picture at their
   existing paint slot. They are not isolated track content and do not receive
   that track's media stack a second time. Explain this distinction in the UI.
4. Sequence master effects process the completed sequence, including captions.
   A nested child's master runs after its captions and before the child's
   result enters the parent track. The parent master runs once afterward.
   Editing a shared child propagates as ordinary sequence intent.
5. Track/master authoring admits only explicitly post-composite-safe effects.
   Source geometry, lens correction, masks, chroma keys and current source-only
   plugins remain ineligible. Preserved unknown or wrong-stage descriptors are
   reported and bypassed, never reinterpreted as supported operations.

Compare two concrete render designs: explicit bounded group scopes in the shared
plan with reusable owner-managed surfaces, and a sequential begin/end schedule
that borrows existing scratch where lifetimes permit. Both must preserve child
sequence identity, frames, repeated-instance paths and outer blend semantics.
The latter cannot reuse a surface still borrowed by an awaited plugin or parent.
Do not implement track effects as generated copies on every clip: that would
run before crossfade completion and drift when clips change.

Proof must cover noncommutative effects at each stage, two lower/upper tracks,
alpha, same/mixed blend transitions, adjustments above/below, captions, masks,
lens correction, trusted clip plugins, nested depth/repeated children and
multicam gaps. Count simultaneously live canvases, readbacks and typed arrays
at each stage, through exceptions, cancellation and repeated export.

Promote only after a measured design fits existing resource contracts. If it
needs a separate implementation issue as #197 permits, retain explicit pending
acceptance here and propose that child with the failed evidence. Do not call
the whole parent issue complete or raise the memory ceiling implicitly.

## Gate 5: track/master product integration

After Gate 4 passes, add resource-free track and sequence-master effect stacks
using the same descriptors and explicit stage declarations. Advance the
timeline schema with empty-stack migration and preserve old output. Extend
project validation, aggregate budgets, global ids, duplication, history,
recovery and save/open for active and dormant sequences. Determine whether the
outer project version needs a change from the final wire contract.

Start with static bus parameters; range-based automation remains available on
adjustments. The shared plan/compositor, preview status, worker protocol and
export path all gain the same scope semantics. Update Program admission before
allocating any additional accounted resources. UI reads status through state
and app facades, including target-specific preset rejection reasons.

## Gate 6: acceptance and delivery

Each implementation gate runs focused tests, production build/typecheck and
lint before moving on; observable slices also get real Chromium verification.
Final acceptance runs full Vitest plus repository runner checks, build, lint,
production high-severity dependency audit, diff checks and the full browser
suite. Reproduce unrelated failures against the unchanged baseline and report
them separately; previous issue totals are not current acceptance evidence.

Use the repository's Node 26 compatibility setting where applicable:
`NODE_OPTIONS=--no-experimental-webstorage npm test`. Browser automation is
headless with `--mute-audio`; visual review uses the in-app browser. Fixtures
need no audible tones. Use dedicated ports and disposable browser state.

The issue browser matrix includes real copy/paste and presets, undo/redo,
corruption/budget rejection, reload/recovery/project replacement, new reference
pixels, track/master order, trusted-plugin coexistence, original-media export
and reopen, cancellation and terminal cleanup. Numerical compositor parity and
lossy encoded-file tolerances are separate claims.

Record results and limitations in this document and `docs/evidence/issue197/`;
update HANDOFF/PLAN as gates finish. Commit accepted steps with Aryel authorship,
the required Codex co-author trailer, and a message file passed to `git commit
-F`. Publication/merge is not part of this planning checkpoint.

## Alternatives and external references

The internal clipboard avoids OS permissions and untrusted clipboard parsing;
the local preset library provides reuse across project sessions. Making presets
project-owned would duplicate the library and couple preset edits to project
history. Per-clip expansion of track stacks would duplicate intent and choose
the wrong processing order. A second generic effect/geometry engine would
duplicate the already versioned registry and SourceTimeMap contracts.

[Kdenlive's effects manual](https://docs.kdenlive.org/en/effects_and_filters.html)
documents clip/track/master application, stack presets and restrictions on
which effects make sense at each level.
[Shotcut's feature list](https://shotcut.org/features/) provides the issue's
broader filter/blend workflow reference. These inform workflow choices; they
do not establish Myrelith's rendering or performance support.
