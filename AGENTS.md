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

## Cursor Cloud specific instructions

- Pure client-side app: no backend, database, or external service. `npm run dev`
  serves the whole product on `http://localhost:5173` (see Build & test above).
- Node version gotcha (important): the VM's default `node` on `PATH`
  (`/exec-daemon/node`) is v22.14.0, whose bundled build hits a jsdom
  cross-realm WebCrypto bug that fails 11 `src/test/plugins/*` vitest specs
  (`SubtleCrypto.digest` rejecting a cross-realm `ArrayBuffer`). App/lint/build
  are unaffected, but `npm test` needs a newer Node. Setup pins nvm's Node 24
  (matching CI) and prepends it in `~/.bashrc`, so login shells resolve
  `node` → v24 automatically. If a shell ever reports `node -v` = v22.14.0,
  run through nvm's Node 24 (e.g. `bash -lc 'npm test'`) or
  `nvm use 24`.
- The MVP hello-world flow (launcher → "Start a new project" → pick a canvas
  size → editor → toolbar "T" text overlay) renders text in the Program Monitor
  and adds a clip to timeline track V1; use it as a quick smoke test.
