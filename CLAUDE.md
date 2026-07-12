# WebCut

Web-native non-linear video editor.
Stack: React + Vite + TypeScript + Zustand + Immer + WebCodecs + Mediabunny + Canvas2D/WebGL.

**Before editing, read [ARCHITECTURE.md](ARCHITECTURE.md).** It holds the
dependency hierarchy and the non-negotiable rules (frame-closing, integer
frame math, audio-master-clock, UI-reads-state-only, one-module-per-prompt).
Those rules are binding for every change and are not repeated here to avoid
drift — treat ARCHITECTURE.md as canonical.

## Continuing the build (start here in a new session)

1. [docs/HANDOFF.md](docs/HANDOFF.md) — status, file map, invariants,
   hard-won lessons (browser-only bugs!), dev toolbox, working agreements.
2. [docs/PLAN.md](docs/PLAN.md) — completed MVP build record and gate
   evidence; supersedes the original plan file.

Phases 0–5 are done and committed; the MVP gate is closed. 594 tests.
Select a post-MVP item from HANDOFF.md or write a new user-approved plan
before starting another phase.

## Build & test

- `npm run dev` — dev server (preview config: `.claude/launch.json`)
- `npm run build` — typecheck + production build (must stay green;
  vitest alone is NOT enough — run tsc via this)
- `npm test` — Vitest
- `npm run lint` — oxlint

## Working style (user preference — binding)

- One module per turn: implement → test → build/lint → browser-verify if
  observable → commit (message file + `git commit -F`, author Aryel only;
  never add AI co-author or attribution trailers).
- Never skip a phase gate. Quality over speed, explicitly requested.
- End-of-turn summaries: short, plain, low-jargon (see HANDOFF.md).
- TypeScript `erasableSyntaxOnly`: no constructor parameter properties.
