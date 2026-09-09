# Atomic animation and title ownership integration

Reviewed Gate2 ec12258 and correction971b5114b7c45028cef0991c8cca7eb16fd7614f
are integrated after schema23 ownershipc52727b. The parent reproduced the same-ID
effect-type clipboard defect before the fix; the exact reproducer now refuses
paste. The correction covers scalar/path owner type changes, unchanged future
and missing owners, and preserving clipboard, selection and both history
branches. Independent correction checks pass2files44tests plus17runner checks;
all188source manifest entries match. Original Gate2 review also passed9files
109tests plus17runner checks. No unresolved correction remains.

The app facade now composes the canonical isProceduralTitleClip and
readTitleClipElement functions in one stable adapter. A new integration test
authors actual title-element keys, copies/pastes with exact local ticks and
checks undo/history through that facade. Supported and opaque future titles
retain outer-opacity-only authoring and static mask/path restrictions.

The new generic effect authoring API also keeps procedural title effects
unavailable until the agreed text-stage applicability contract is implemented.
This closes an integration bypass of the existing static-title effect helper.
Stored inactive keys retain copy/move/delete semantics. The #200 rendering and
#199 UI owners must review safe scalar effect eligibility together; this
provisional guard is not the final feature acceptance or a new effect registry.

Combined validation passes17files187tests plus17runner checks, build/typecheck,
lint and diff hygiene. Exact logs: /private/tmp/milestone9-animation-title-
integration-*.log. The existing Vite chunk advisory remains. No browser/native
pointer, export pixel/PCM, measured performance or full-suite claim is made for
this checkpoint. The earlier held-mask5/5 browser result applies before schema23
and the generic editor merge; combined browser acceptance remains pending.
