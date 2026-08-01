# Contributing to WebCut

Thanks for helping make WebCut better.

## Before you start

- Search existing issues and open a focused issue for substantial changes.
- Read `ARCHITECTURE.md` and `docs/HANDOFF.md` before editing.
- Keep media local, capability-probe real codec configurations, use integer
  frame math, and follow every ownership rule for frames and bitmaps.
- Do not silently substitute a different export profile when an explicit choice
  is unsupported.

## Development

Use Node.js `^20.19.0` or `>=22.12.0`, npm, and a current desktop Chromium
browser.

```bash
npm ci
npm run dev
```

Before opening a pull request, run:

```bash
npm test
npm run build
npm run lint
npm audit --omit=dev --audit-level=high
```

Add focused tests for behavior changes and browser-check anything observable.
Keep pull requests small enough to review, explain the user-visible result, and
record any verification that could not be completed.

By contributing, you agree that your contribution is licensed under the MIT
License in `LICENSE` and that you will follow `CODE_OF_CONDUCT.md`.
