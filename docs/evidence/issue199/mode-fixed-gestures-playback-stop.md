# Issue 199 — native mode cancellation passes; playback warning stops run

Evidence only. The one granted gestures run used clean harness
`34b55e0ce06af0b5b7ba8c5db23b7ce63fcf13cc`, mechanically repinned to accepted
product `75b89ef6b70460a03ea99ca44d888b5ec06373ec`. The repin was committed,
hash-verified and recorded in the owned report before launch. Reviewed actions,
assertions and fixture bytes were unchanged.

The run lasted from 17:37:13.438Z to 17:37:26.259Z on 2026-09-08, using a fresh
private profile, muted headless Chromium 151.0.7922.34 / SwiftShader, and scoped
`caffeinate -is`. **Eleven checkpoints passed. Playback then failed the strict
console gate and stopped the segment. This is not a gestures or Gate 3 pass.**

## Reached result

Launcher and mixed-fixture/native selection passed. Exact native key movement,
both Bézier handle edits, key Escape, trusted capture loss and close cancellation
passed again. The mode-switch case now passes: Curve is selected and drawn,
preview is false, preview owner is null, and document/history/clipboard remain
unchanged. The inspected step-09 screenshot and raw step detail preserve this
native sheet→curve result. Selection and viewport cancellation also passed.
Native reverse-direction handle cancellation remains unreached.

During `native key cancellation: playback`, the action completed its playing,
preview cancellation, exact identity and pause assertions. Step acceptance then
failed at the unchanged console check with this warning:

```text
[transportController] audio clip "ordinary-audio" source open failed: Playback media asset "audio-asset" is missing from the media pool
```

The fixture audio is intentionally offline. Failure state shows preview false,
owner null, past 0 / future 1 and focused local key 40. The result is still failed;
the warning was neither ignored nor reclassified as passing playback. The
remaining key document/sequence cases, handle cancellation matrix, sibling
restoration and project departure did not run. No fixture workaround, product
change or nonmetadata harness change is included here.

## Raw evidence and cleanup

Original directory:
`/private/tmp/issue199-continuation/2026-09-08T17-37-13.437Z-gestures/`.

All 32 top-level artifacts are retained and hashed: complete result/failure
state/native events; 13 screenshots; 12 step DOM snapshots plus failure DOM;
trace; production build/source/browser/runtime/process provenance; console and
server logs; independent source/cleanup proof. The playback step has a snapshot
because its action completed before its console gate failed. It is not counted
as a passed checkpoint. Trace integrity was verified. The private profile remains
preserved without a profile-hash claim.

`gestures-attempt3/` contains exact JSON and normalized text/DOM/log copies;
`evidence-copies.json` records both raw and committed copy hashes. Original files
and both preceding failed attempts remain unchanged.

**Physical cleanup released 5199 at 17:37:26.223Z**: context closed, owned preview
exit 143, no fallback signals, no remaining owned process and no listener.
The `cleanup.error` text comes from the combined cleanup-or-console final guard,
which rejects the retained warning; the physical-release fields remain true.
Independent verification at 17:39:00.468Z found all seven observed PIDs
92336/92338/92339/92340/92341/92381/92382 absent, runner 92254 and scoped
caffeinate 92265 absent, port clear and all 242 source plus 44 checkpoint hashes
matching the clean observed source. The slot is explicitly released.

Read-only `pmset` inspection found no actual sleep/wake transition during this
12.821-second run. No persistent power/display setting changed. This evidence
checkpoint adds no source test, build or browser run beyond the granted attempt;
its build output is preserved. Any nonmetadata playback-fixture or harness
correction requires source review before a new native grant. Editing, large,
export, full suite and native follow-on remain gated.
