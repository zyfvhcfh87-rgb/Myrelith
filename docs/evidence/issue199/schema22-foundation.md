# Issue 199 — schema 22 canonical foundation (Gate 1)

Date: 2026-09-08. This is a review request, not permission to start Gate 2.
The supervisor owns acceptance and integration; no publication is included.

## Accepted inputs and integration

- Scalar/timing extraction: `476235a5ab333e118a6190d1c9d7fd4b257a7b5a`.
- Held-path value foundation: `022aabaa45914ecdca15e43aff8092b0d6ae6569`.
- Pure title/property foundation: `381836fa3b45d83f7b7c1f932413b6ac067a154a`.
- Integer crop certificate: `61c13dcce5354d9d3efe809b2a0a8c9772675730`, accepted by the supervisor before runtime integration.
- Reviewed title budgets: `94e95eaa9ce4ba72cc51f9dfdb00d81aec231635`, received in exact accepted integration `f81700ca25ce5547042f941bb6822de91efa2d5f`.
- Schema checkpoint `2b9dc40` saved before that merge; merge commit `20b3ec1` contains it. The final Gate 1 commit adds complete orphan accounting and acceptance tests.

## Contract delivered

Timeline schema 22 adds optional `titleTracks`, optional `effectPathTracks`, optional clip `propertyVersion`, plugin `parameterIdentity`, and four crop properties. Project format remains 8. The 21→22 migration changes only the version number. Existing absent collections and implicit scalar v1 remain absent; explicit version metadata is retained.

The portable boundary preflights collection/key counts before reading key payloads. One semantic property can have only one lane regardless of version. Effect tuples use nested maps, avoiding separator-string collisions; scalar and path lanes cannot compete for the same effect parameter. Unknown bounded names, versions, dangling targets and path strings survive without becoming executable.

`animationCollections` supplies typed traversal and element-id remapping. Clone/count/shift/source-intent/slip/retime, duplication and attribute paste preserve all four collections and metadata. Retime collisions reject the complete edit. Procedural text split/head trim reanchor local ticks; timed media retains absolute source intent. Existing populated-project FPS changes remain unavailable. No new FPS conversion is added.

`clipAnimationProperties` is the clip property authority. `animationPropertyCatalog` delegates title semantics and exclusive padding bounds to the accepted title adapter. All scalar consumers use the accepted scalar evaluator. Title ownership/rendering still belongs to schema 23; orphan title tracks are data only. Legacy text exposes outer opacity; title-path geometry remains unavailable pending the owners' agreement, while timing and persistence retain it.

Plugin lanes without declaration identity remain unverified and inactive. The explicit binding controller checks project identity, generation, active sequence and the exact immutable catalog before and after candidate construction. Binding writes the current package digest, effect/descriptor/contribution identity, and no permission or trust state. Undo restores the unverified lane. Package/declaration drift makes bound keys unavailable. Existing animated-plugin composition fixtures now contain explicit matching identities; separate tests prove unbound fallback behavior.

## Admission and ownership

| Data | Admission |
| --- | --- |
| Scalar/title keys | Existing 1,024 keys per lane; 100,000 project-wide keys including paths and dormant sequences |
| Clip/title lanes | 64 clip scalar lanes; 256 title lanes; bounded future identifiers and finite values |
| Held paths | Accepted 256 keys/lane, 256 lanes/clip, 4,096 project keys and 1,048,576 path-value characters |
| Path retention | 32 MiB accounted path data, including candidate, current, both history branches and both path clipboards |
| Title retention | 1 MiB per title/orphan payload and 64 MiB accounted data across candidate, current, both history branches and title/element/key clipboard roots |
| Portable file | Unchanged 10,000,000 serialized-character limit, including the actual current assets and collections |

The shared title budget projection now accepts a tracks-only orphan owner. It charges the exact track array and all metadata without inventing a persisted `title`. Title owner schema 23 must extend `projectTitleAnimationOwners` to include actual `Clip.title` values in the same owner entry. Shared nested immutable data is counted once for retention; serialization counts every occurrence. These are bounded accounting measures, not browser heap measurements.

The shared path snapshot helper checks each lane's bounds but does not enforce semantic uniqueness across different clips in a flattened accounting projection. Per-owner validation retains uniqueness. This avoids rejecting two clips that preserve the same dangling target. Path-only paste now also reserves dangling source ids and attaches animation to an older clip that had no animation object.

Ordinary store commits perform project crop/title/path admission and history retention checks before changing either history branch. App-owned `commitPortableProjectEdit` supplies the complete media envelope and calls the real snapshot serializer before committing. Explicit animation binding and attribute paste use it. It is the required app boundary for the later animation batch editor and title upgrade. The domain/store cannot independently account for browser-owned assets and collections; this gate does not claim that every pre-existing unrelated editing controller has been migrated to this app preflight.

The accepted static-mask integration `125a8c8c69cedb9d3435c39128f94eaf2c54215b` was reported while this branch was dirty and was not force-merged. When integrating, preserve `commitMaskEdit`'s project/generation/sequence checks and ordinary store admission, and use the complete app file preflight for its accepted candidate. No duplicate timing or path wire should be introduced.

## Crop certificate binding and runtime

`certifyProjectCropAnimation` collects all sequences, including dormant/hidden clips. For each crop owner it certifies `[0, duration-1]` plus the entire integer local range consumed by either transition leg, using the same `crossfadeWindowAtCut` arithmetic as composition. Only touching from/to clips extend the range. Invalid transition structures remain the project structural validator's responsibility.

Authored keys are bounded to ±1e9. Beyond those endpoints the canonical scalar evaluator returns the exact endpoint value. Clamping a larger consumed range to these key bounds therefore certifies the identical held tail, without sampling or allocating by clip duration. A two-billion-frame regression exercises this case.

Cached proof binds the whole deeply frozen relevant project graph: sequence/track/clip ownership, timeline ranges, transition ids/durations, static crop, scalar track arrays, keyframes and easing. Freezing only the root is insufficient; mutable nested inputs are rechecked. A changed crop, track, transition or range requires a new immutable graph and proof. The shared certificate still enforces 16,384 intervals/clip, 1,048,576/project and 100,000 key visits. Failure never mutates the candidate, clamps values or certifies an unproven range. Runtime resolution consumes accepted integer crop values, without invoking the certificate per frame. No fractional-frame crop or sample-time crop claim is made.

Held path preparation validates geometry once per exact target/track contents. Runtime reuses it and validates other mask controls separately through the same factored mask rules. A regression spies on the geometry validator to prove repeated held selection does not parse the keys again. This is a domain selection claim; renderer/browser performance remains a later gate. Mask geometry remains normalized project-canvas space after crop and transform, with no crop-origin rebase.

## Production file-cap acceptance

`animationFileBoundary.test.ts` builds 600 legacy text clips in two sequences and, in the scalar variant, one timed media clip with existing scalar keys in the dormant sequence. It pads real bounded text payloads and uses the canonical production serializer to construct old wire shape at exactly 9,999,999 and 10,000,000 characters. No expanded title owner is fabricated.

For all four cases, the actual parser/migration/serializer changes only schema 21 to 22, with byte-identical remaining encoding. An equal-length text/content color edit commits through the app preflight, saves at the same length, creates one history entry, and restores exact snapshots/encoding through undo and redo. While redo is populated, adding title keys, path keys, explicit property metadata or plugin identity is rejected for exceeding the file cap, leaving the store object and both branches unchanged. Both parse and serialize reject the separately measured 10,000,001-character file. This is real schema 22 production acceptance, not the earlier schema 23 size projection.

## Verification and remaining gates

- Final focused matrix: **42 files / 499 Vitest tests**, plus **17/17 repository runner tests**. The exact command is in `schema22-final-tests.log`; every listed test path was checked to exist.
- `npm run build`: TypeScript and Vite production build pass, with the existing large-chunk advisory. `npm run lint` passes.
- Source hashes and the focused-file list accompany the logs. The earlier scalar oracle still checks 900 exact binary64 outputs and 36 complete timing outcomes from frozen master.
- Current-schema fixture literals were replaced by `CURRENT_TIMELINE_SCHEMA_VERSION` in 84 files to satisfy the existing architecture guard. Historical migration inputs keep their historical versions; current-output expectations use the shared constant.
- The final matrix initially reported a stale schema-21 expectation and an unbound animated-plugin fixture; both were corrected to the explicit current contract. Earlier new-test failures were fixture name/id/field-order/API mistakes, retained in a compact failure record. They are not hidden baseline failures.
- No full suite, browser, export pixel/PCM comparison, benchmark, dependency audit or completed feature acceptance is claimed. No browser/performance slot was used. Crop proof may conservatively refuse a safe curve when bounded proof work is exhausted. Retention accounting still needs the later measured performance gate.
- Gate 2 batch operations, Gate 3 UI, Gate 4 mixed-feature browser/export acceptance, and Gate 5 final issue completion remain. Stop here for exact-commit review.
