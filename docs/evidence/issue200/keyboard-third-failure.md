# Third keyboard attempt — macOS headless popup cancellation

The one granted run on `2e04cf9ff4dd1bc6ede5d17219169e9072be2fcf` stopped at the
first popup-open assertion (`keyboard.gate.ts:220`). Trusted Space reached the
focused native SELECT identity 79; `:open` remained false for the existing 5-second
predicate timeout. No ArrowUp/Enter selection followed. Result: 0 complete cases
passed, 1 failed, 3 unrun, zero retries; 11.497039 seconds overall. Browser problem
arrays are empty. Raw files and the normal manifest remain at
`/private/tmp/issue200-keyboard-2e04cf9-01`, with sibling outer records.

All 13 captured PIDs exited; port 5200 was clear at 21:30:27.872618 UTC. No runner
timeout, forced termination, observer/cleanup error or incomplete stdout occurred.
The parent independently confirmed release. The fresh receipt is in the raw folder.

The captured executable was **full Chrome for Testing 151.0.7922.34**, under
`chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app`, already launched
with `channel: 'chromium'`, `headless: true`. This is not the separate headless-shell
binary. [Playwright's browser documentation](https://playwright.dev/docs/browsers#chromium-new-headless-mode)
confirms that this channel selects full Chromium's new headless mode.

Chromium's macOS [native-menu bridge](https://chromium.googlesource.com/chromium/src/+/HEAD/content/app_shim_remote_cocoa/render_widget_host_ns_view_bridge.mm)
explicitly returns a cancelled result for a headless native window before displaying
the popup. This is a concrete upstream explanation consistent with the captured run;
the exact installed tag was not retrievable, so it is not an installed-source proof.

App source inspection found no relevant Space prevention: edit/history hooks exclude
HTMLSelectElement, the palette only handles Cmd/Ctrl+K, multicam excludes SELECT,
and title/animation gesture listeners only handle Escape. The native fallback select
has no key handler. The existing capture ledger does **not** record final
`defaultPrevented`, so that runtime flag remains unverified.

For wrap-up, the supervisor explicitly directed that native font selection remain
**UNVERIFIED in this environment; the cause is not definitively proved**. A closed
popup after the existing wait must leave the select and full project/history
unchanged, then annotate only the final native font-selection segment as unverified.
The remaining control/dialog cases continue. If the popup opens, all original
selection/history assertions still apply. Existing G2 font/fallback and component
history tests provide supporting coverage, not native keyboard acceptance. No headed
run, synthetic selection, special product path or additional popup infrastructure.
