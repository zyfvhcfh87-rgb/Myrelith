# WebCut

Web-native non-linear video editor.
Stack: React + Vite + TypeScript + Zustand + Immer + WebCodecs + Mediabunny + Canvas2D/WebGL.

**Before editing, read [ARCHITECTURE.md](ARCHITECTURE.md).** It holds the
dependency hierarchy and the non-negotiable rules (frame-closing, integer
frame math, audio-master-clock, UI-reads-state-only, one-module-per-prompt).
Those rules are binding for every change and are not repeated here to avoid
drift — treat ARCHITECTURE.md as canonical.

## Build & test

- `npm run dev` — dev server
- `npm run build` — typecheck + production build (must stay green)
- `npm test` — Vitest
- `npm run lint` — oxlint

## Build sequence

The project is built phase-by-phase per the implementation plan. Each phase
has a gate that must pass before starting the next. Current status is tracked
in the plan; do not skip a gate.
