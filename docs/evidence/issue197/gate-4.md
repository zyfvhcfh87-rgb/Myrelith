# Gate 4: sequential video-bus design proof

The semantic prototype selects sequential reuse over recursive surface groups.
It introduces no schema fields or bus product controls. Its source lives in
`src/test/videoBusProof.ts`; only the disposable browser test imports it.

## Order and conditions

The explicit reference allocates an isolated child-sequence canvas and separate
track canvases. The sequential candidate uses the existing destination, leg and
transition-group canvases. Their full RGBA output and scoped execution traces
are byte-identical at nesting depths 0, 1 and 8, including repeated child
instances with sequence id, local integer frame and complete instance path.

Ordinary media/text uses leg -> clip effects -> intrinsic opacity into group ->
track effects -> outer blend. Crossfades add weighted premultiplied legs into
the group, then process the track once before its existing same/mixed-mode
outer blend. Do not expand the track descriptors onto the clips. Adjustment
slots copy the accumulated destination through leg scratch and keep their own
opacity; that track's media stack is not applied again. Empty tracks do nothing.
Multicam gaps retain the existing opaque black base and still form track media.
Captions paint after tracks, then the sequence master runs once.

Nested instances in the current schema have no outer opacity/geometry/blend;
`nestedSequences.ts` requires equal project settings. Each child starts with an
opaque black base. Every admitted post-composite built-in explicitly declares
`preservesOpaqueInput: true`, and a pure test checks alpha at parameter extrema.
Consequently the child fully replaces the lower parent picture, so it may
finish on the destination without retaining the covered parent pixels. Child
caption -> child master -> parent track -> later parent tracks/captions ->
parent master remains explicit. Future alpha-reducing post effects cannot use
this optimization merely because they declare post-composite support.

Production integration must encode these requirements in bus eligibility and
scope markers. Unknown/wrong-stage descriptors are preserved and bypassed.
Masks, chroma keys, source geometry/lens and current plugins stay source-only.
The existing source stage remains unchanged; the separate Gate 3 acceptance
covers the actual installed audited plugin plus pixel effects and encoded export.
The prototype's awaited plugin is only a borrow-lifetime stand-in, not evidence
of signed-plugin execution. Actual bus-plus-plugin/lens/mask/caption rendering
and export are mandatory integration checks in Gates 5–6.

## Owned resources and admission

The reference's surface count grows with nested depth; two extra full-size 4K
surfaces already exceed the existing lens/export render allowance. The candidate
holds exactly three compositor canvases at all tested depths and raster sizes.
The existing fourth preview/presentation surface remains in host accounting.
No parent retains leg/group across recursion. Each clip await completes before
track/master processing borrows scratch. Injected rejection/cancellation and
three repeated finite owners return the prototype's canvas/array ledgers to zero.
This demonstrates owned-resource release, not immediate browser garbage collection.

At 720p/1080p/4K, depth-eight synthetic compositions take 920/1942.8/7723 ms on
Chromium 151.0.7922.34, darwin arm64. This is a deliberately stacked offline
proof, not a playback-rate target. Recorded JSON keeps the complete traces and
resource counts. The two-array prototype peak is its before/after await check;
bus execution itself holds one readback plus bounded algorithm scratch.

| Phase | Simultaneously reachable resources relevant to this change |
| --- | --- |
| Ordinary/transition source stage | Existing compositor surfaces; two reusable lens surfaces when present; decoded/cache loans until the frame promise settles; one pixel readback for a built-in path. |
| Awaited plugin stage | Caller readback, transactional working array, fresh transferable input and returned output (up to four RGBA frames conservatively), plus the plugin's separately bounded Wasm memory (up to 67,174,400 bytes per runtime), bridge/transfers and retained source loans. Bus execution has not begun. |
| Track/master bus stage | Existing canvases/lens owners and source loans; one readback; one spatial scratch set (at most 810,372 measured bytes at 4K). No plugin input/output/working arrays are retained by the bus. |
| Final export readback | Happens after composition settles. Export has its own compositor/plugin/lens owner; it cannot borrow preview resources. |

The documented equal-size 4K conservative baseline is seven RGBA surfaces,
232,243,200 bytes. Adding one bus readback plus maximum measured spatial scratch
yields 266,231,172 bytes, below 268,435,456. This is not a browser-process memory
bound. Plugin memory, encoded media and opaque native/GPU storage keep their
existing separate contracts; the bus must not relabel them as free.

Integration must calculate dimension-dependent readback/scratch admission,
including larger source-space lens surfaces, before allocation. A valid old
project at a maximum size is not automatically admitted for added bus work.
Program's high-water reservation must include the bus allowance before optional
monitor admission. No ceiling increase or new persistent surface is authorized
by this proof. Failure of that integration gate leaves bus shipping pending.

38 focused tests in four files, 17 runner checks, build/typecheck and lint pass;
two muted Chromium prototype checks pass. The production bus feature and full
issue acceptance remain pending. The next gate may now implement this measured
schedule with the explicit traits, admission and integration checks above.
