# Myrelith

Web-native non-linear video editor.
Stack: React + Vite + TypeScript + Zustand + Immer + WebCodecs + Mediabunny + Canvas2D/WebGL.

**Before editing, read [ARCHITECTURE.md](ARCHITECTURE.md).** It holds the
dependency hierarchy and the non-negotiable rules (frame-closing, integer
frame math, audio-master-clock, and UI-reads-state-only).
Those rules are binding for every change and are not repeated here to avoid
drift — treat ARCHITECTURE.md as canonical.

## Continuing the build (start here in a new session)

1. [docs/HANDOFF.md](docs/HANDOFF.md) — status, file map, invariants,
   hard-won lessons (browser-only bugs!), dev toolbox, working agreements.
2. [docs/PLAN.md](docs/PLAN.md) — completed MVP build record and gate
   evidence; supersedes the original plan file.

Phases 0–5 and the MVP gate are complete. Post-MVP work is tracked through
explicitly selected issues and HANDOFF.md's open list.

## Build & test

- `npm run dev` — dev server (defaults to `http://localhost:5173`)
- `npm run build` — typecheck + production build (must stay green;
  vitest alone is NOT enough — run tsc via this)
- `npm test` — Vitest
- `npm run lint` — oxlint

## Working style (user preference — binding)

- Follow a change end-to-end across every module it genuinely needs. Keep
  dependency boundaries clear, then test → build/lint → browser-verify if
  observable → commit (message file + `git commit -F`, authored by Aryel and
  including `Co-authored-by: Codex <codex@openai.com>` for Codex-assisted work).
- Never skip a phase gate. Quality over speed, explicitly requested.
- End-of-turn summaries: short, plain, low-jargon (see HANDOFF.md).
- TypeScript `erasableSyntaxOnly`: no constructor parameter properties.
