# Media Pool Thumbnail Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain Media Pool file picker and text-only rows with a polished header and compact horizontal cards that show an existing early filmstrip frame as a video thumbnail.

**Architecture:** Keep the change inside the UI layer. `MediaPool` will subscribe to the existing `mediaStore.visuals` map, crop the first tile from an asset's existing filmstrip with CSS background sizing, and fall back to a decorative placeholder while visuals are unavailable. The media store, visual generator, worker pipeline, metadata flow, and drag payload contract remain unchanged.

**Tech Stack:** React 19, TypeScript 6 (`erasableSyntaxOnly`), Zustand 5, CSS, Vitest 4, Testing Library, Vite 8.

## Global Constraints

- Re-read `ARCHITECTURE.md` before editing.
- Stay in the UI layer: do not modify `src/state`, `src/pipeline`, `src/engine`, or `src/workers`.
- Use `useMediaStore((s) => s.visuals)` as the only thumbnail source; do not add decoding work or change `AssetVisuals`.
- Use the first existing filmstrip tile as an early representative frame; exact-first-frame decoding is out of scope.
- Keep the existing accepted formats: `video/*,.mp4,.mov,.mkv,.webm`.
- Keep the same-file re-import behavior by clearing the file input value after every change.
- Keep asset rows draggable only when `asset.durationFrames > 0` and preserve the existing `ASSET_DRAG_TYPE` plus kind-specific drag payloads.
- Preserve object URL ownership in `mediaStore`; the UI must never revoke a filmstrip URL.
- Treat thumbnail imagery as decorative; filename text remains the accessible asset identity.
- Follow TDD: observe the new tests fail before writing component or CSS implementation.
- After implementation run focused tests, the full test suite, production build, lint, and a real-browser verification.
- Commit with author `Aryel <zyfvhcfh87@privaterelay.appleid.com>` using a message file and `git commit -F`; do not add AI attribution trailers.

---

## File Map

- Create `src/ui/MediaPool.test.tsx`: focused UI contract for the header, import, thumbnail/placeholder states, metadata, and removal.
- Modify `src/ui/MediaPool.tsx`: read existing filmstrips and render the new header and horizontal card markup without changing import or drag behavior.
- Modify `src/app/layout.css:147-226`: replace only the Media Pool style block with the polished header, hidden input, card, thumbnail, and interaction styles.

### Task 1: Media Pool horizontal thumbnail cards

**Files:**
- Create: `src/ui/MediaPool.test.tsx`
- Modify: `src/ui/MediaPool.tsx:1-75`
- Modify: `src/app/layout.css:147-226`
- Test: `src/ui/MediaPool.test.tsx`
- Regression test: `src/ui/mediadrop.test.tsx`

**Interfaces:**
- Consumes: `useMediaStore` fields `assets`, `visuals`, `addAsset`, and `removeAsset`; `AssetVisuals.filmstrip` shape `{ url, tiles, tileWidth, tileHeight }`; `formatTimecode`; `ASSET_DRAG_TYPE`; `assetKindDragType`.
- Produces: existing `MediaPool` default component with stable test ids `media-thumbnail-${asset.id}` and `data-state="ready" | "placeholder"`; no new exported runtime API.

- [ ] **Step 1: Re-read architecture and confirm the working tree scope**

Run:

```powershell
Get-Content -Raw ARCHITECTURE.md
git status --short --branch
```

Expected: architecture rules are fresh; only the user's pre-existing untracked `AGENTS.md` may be outside the committed design/plan history. Do not stage or edit `AGENTS.md`.

- [ ] **Step 2: Create the focused failing component tests**

Create `src/ui/MediaPool.test.tsx` with this complete content:

```tsx
/**
 * ui/MediaPool.test.tsx — Media Pool card presentation.
 *
 * The existing visuals controller generates one full-source filmstrip per
 * video. MediaPool reuses its first tile as a representative thumbnail and
 * keeps import, metadata, removal, and drag-readiness behavior intact.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { MediaAsset } from '../domain/schema'
import type { AssetVisuals } from '../state/mediaStore'
import { useMediaStore } from '../state/mediaStore'
import MediaPool from './MediaPool'

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-9',
    fileName: 'beach.mp4',
    objectUrl: 'blob:video',
    kind: 'video',
    durationFrames: 120,
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...overrides,
  }
}

function seedAsset(asset: MediaAsset, assetVisuals?: AssetVisuals): void {
  useMediaStore.setState((state) => {
    const assets = new Map(state.assets)
    assets.set(asset.id, asset)
    const visuals = new Map(state.visuals)
    if (assetVisuals) visuals.set(asset.id, assetVisuals)
    return { assets, visuals }
  })
}

beforeEach(() => {
  let urlCount = 0
  URL.createObjectURL = vi.fn(
    () => `blob:import-${++urlCount}`,
  ) as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  useMediaStore.setState({ assets: new Map(), visuals: new Map() })
})

describe('MediaPool presentation', () => {
  test('renders the Media header and imports through the labeled control', () => {
    render(<MediaPool />)

    expect(screen.getByRole('heading', { name: 'Media' })).toBeInTheDocument()
    const input = screen.getByLabelText('Import media')
    const file = new File(['video'], 'fresh.mp4', { type: 'video/mp4' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(screen.getByTitle('fresh.mp4')).toBeInTheDocument()
    expect(useMediaStore.getState().assets.size).toBe(1)
  })

  test('shows a placeholder while preserving ready metadata and drag state', () => {
    seedAsset(makeAsset())
    render(<MediaPool />)

    const card = screen.getByTitle('beach.mp4')
    expect(card).toHaveAttribute('draggable', 'true')
    expect(screen.getByText('1920×1080 · 00:00:04:00')).toBeInTheDocument()
    expect(screen.getByTestId('media-thumbnail-asset-9')).toHaveAttribute(
      'data-state',
      'placeholder',
    )
  })

  test('crops the first tile from the existing filmstrip', () => {
    seedAsset(makeAsset(), {
      filmstrip: {
        url: 'blob:filmstrip',
        tiles: 4,
        tileWidth: 78,
        tileHeight: 44,
      },
      waveform: null,
    })
    render(<MediaPool />)

    const thumbnail = screen.getByTestId('media-thumbnail-asset-9')
    expect(thumbnail).toHaveAttribute('data-state', 'ready')
    expect(thumbnail.getAttribute('style')).toContain('blob:filmstrip')
    expect(thumbnail).toHaveStyle({ backgroundSize: '400% auto' })
  })

  test('removes an asset from its card control', () => {
    seedAsset(makeAsset())
    render(<MediaPool />)

    fireEvent.click(screen.getByRole('button', { name: 'remove beach.mp4' }))

    expect(screen.queryByTitle('beach.mp4')).not.toBeInTheDocument()
    expect(useMediaStore.getState().assets.size).toBe(0)
  })
})
```

- [ ] **Step 3: Run the focused tests and confirm the red state**

Run:

```powershell
npm test -- src/ui/MediaPool.test.tsx
```

Expected: FAIL. At minimum, the current component has no `heading` named `Media` and no `media-thumbnail-asset-9` test id. Record the actual failing assertions; do not modify tests merely to match the old UI.

- [ ] **Step 4: Replace `MediaPool.tsx` with the minimal implementation**

Replace `src/ui/MediaPool.tsx` with:

```tsx
/**
 * ui/MediaPool.tsx — Import + thumbnail asset cards.
 *
 * Importing only calls mediaStore.addAsset(file); the existing controllers
 * fill metadata and generate the full-source filmstrip in the background.
 * This UI crops the filmstrip's first tile as a representative thumbnail.
 * Rows become draggable only after demuxing supplies a real duration.
 */

import { formatTimecode } from '../domain/time'
import { useMediaStore } from '../state/mediaStore'
import { ASSET_DRAG_TYPE, assetKindDragType } from './dnd'

export default function MediaPool() {
  const assets = useMediaStore((state) => state.assets)
  const visuals = useMediaStore((state) => state.visuals)
  const addAsset = useMediaStore((state) => state.addAsset)
  const removeAsset = useMediaStore((state) => state.removeAsset)

  return (
    <div className="media-pool">
      <div className="media-pool-header">
        <h2 className="media-pool-title">Media</h2>
        <label className="media-import">
          <span aria-hidden="true">+</span>
          <span>Import</span>
          <input
            className="media-import-input"
            aria-label="Import media"
            type="file"
            accept="video/*,.mp4,.mov,.mkv,.webm"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) addAsset(file)
              event.target.value = ''
            }}
          />
        </label>
      </div>

      {assets.size === 0 ? (
        <p className="media-empty">no media yet — import a video file</p>
      ) : (
        <ul className="media-list">
          {[...assets.values()].map((asset) => {
            const filmstrip = visuals.get(asset.id)?.filmstrip ?? null
            const thumbnailStyle = filmstrip
              ? {
                  backgroundImage: `url("${filmstrip.url}")`,
                  // The strip is N tiles wide. Scaling its total width to
                  // N × the thumbnail width makes exactly tile 1 fill the box.
                  backgroundSize: `${filmstrip.tiles * 100}% auto`,
                }
              : undefined

            return (
              <li
                key={asset.id}
                className="media-item"
                title={asset.fileName}
                draggable={asset.durationFrames > 0}
                onDragStart={(event) => {
                  if (asset.durationFrames <= 0) return
                  event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id)
                  event.dataTransfer.setData(
                    assetKindDragType(asset.kind),
                    asset.kind,
                  )
                  event.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <div
                  className="media-thumbnail"
                  data-testid={`media-thumbnail-${asset.id}`}
                  data-state={filmstrip ? 'ready' : 'placeholder'}
                  style={thumbnailStyle}
                  aria-hidden="true"
                >
                  {!filmstrip && (
                    <svg
                      className="media-thumbnail-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <rect x="3" y="5" width="13" height="14" rx="2" />
                      <path d="m16 10 5-3v10l-5-3" />
                    </svg>
                  )}
                </div>

                <div className="media-details">
                  <span className="media-name">{asset.fileName}</span>
                  <span className="media-meta">
                    {asset.frameRate
                      ? `${asset.width}×${asset.height} · ${formatTimecode(
                          asset.durationFrames,
                          asset.frameRate,
                        )}`
                      : 'analyzing…'}
                  </span>
                </div>

                <button
                  className="media-remove"
                  type="button"
                  draggable={false}
                  aria-label={`remove ${asset.fileName}`}
                  onDragStart={(event) => event.stopPropagation()}
                  onClick={() => removeAsset(asset.id)}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Replace only the Media Pool CSS block**

In `src/app/layout.css`, replace the block from `/* Media pool (Phase 3.4) */` through `.media-remove:hover` with:

```css
/* Media pool */

.media-pool {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.media-pool-header {
  position: sticky;
  top: 0;
  z-index: 1;
  min-height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  background: #151515;
  border-bottom: 1px solid #2a2a2a;
}

.media-pool-title {
  margin: 0;
  color: #e7e7e7;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.media-import {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 10px;
  color: #eaf2ff;
  font-size: 11px;
  font-weight: 600;
  background: #315b96;
  border: 1px solid #4777b9;
  border-radius: 5px;
  cursor: pointer;
  user-select: none;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}

.media-import:hover {
  background: #3a68a7;
  border-color: #5a8bc9;
}

.media-import:focus-within {
  outline: 2px solid #76a8ea;
  outline-offset: 2px;
}

.media-import-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.media-empty {
  margin: 32px 16px;
  color: #6f6f6f;
  font-size: 11px;
  line-height: 1.5;
  text-align: center;
}

.media-list {
  list-style: none;
  margin: 0;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.media-item {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) 24px;
  grid-template-areas: 'thumbnail details remove';
  align-items: center;
  gap: 10px;
  min-height: 64px;
  padding: 6px;
  background: #1b1b1b;
  border: 1px solid #2e2e2e;
  border-radius: 6px;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    transform 120ms ease;
}

.media-item:hover {
  background: #202020;
  border-color: #3b3b3b;
}

.media-item[draggable='true'] {
  cursor: grab;
  user-select: none;
}

.media-item[draggable='true']:active {
  cursor: grabbing;
  transform: translateY(1px);
}

.media-thumbnail {
  grid-area: thumbnail;
  width: 88px;
  height: 50px;
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #5d6670;
  background-color: #0c0d0f;
  background-repeat: no-repeat;
  background-position: left center;
  border: 1px solid #30343a;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 2%);
}

.media-thumbnail[data-state='ready'] {
  border-color: #3b424b;
}

.media-thumbnail-icon {
  width: 25px;
  height: 25px;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.media-details {
  grid-area: details;
  min-width: 0;
}

.media-name {
  display: block;
  overflow: hidden;
  color: #d7d7d7;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-meta {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  color: #777f89;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 9px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-remove {
  grid-area: remove;
  align-self: start;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  color: #777f89;
  font-size: 14px;
  line-height: 1;
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}

.media-remove:hover {
  color: #ff9a9a;
  background: rgb(255 96 96 / 10%);
}

.media-remove:focus-visible {
  outline: 2px solid #76a8ea;
  outline-offset: 1px;
}
```

- [ ] **Step 6: Run the focused tests and the existing drag regression tests**

Run:

```powershell
npm test -- src/ui/MediaPool.test.tsx src/ui/mediadrop.test.tsx
```

Expected: both files PASS. `MediaPool.test.tsx` reports 4 passing tests, and the existing drag/drop suite retains all passing tests.

If the style assertion reports browser-normalized quote differences, inspect the actual `style` attribute. Keep the URL containment assertion and assert the exact normalized `background-size`; do not weaken the test to merely check that a style exists.

- [ ] **Step 7: Run the complete automated quality gate**

Run each command separately:

```powershell
npm test
npm run build
npm run lint
```

Expected:

- Full Vitest suite passes with the 4 new tests added to the existing 463-test baseline.
- `tsc -b && vite build` exits 0 with no TypeScript errors.
- Oxlint exits 0 with no warnings promoted to errors.

- [ ] **Step 8: Browser-verify with the real sample video**

Start or reuse the dev server without blocking the implementation session:

```powershell
$listener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  $startArgs = @{
    FilePath = 'npm.cmd'
    ArgumentList = @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173')
    WorkingDirectory = 'E:\ClaudeSpace\WebCut'
    WindowStyle = 'Hidden'
    RedirectStandardOutput = "$env:TEMP\webcut-vite.stdout.log"
    RedirectStandardError = "$env:TEMP\webcut-vite.stderr.log"
  }
  Start-Process @startArgs
}
```

Verify the server separately:

```powershell
(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:5173/').StatusCode
```

Expected: `200`.

Open `http://127.0.0.1:5173/` in the visible in-app browser and use the Windows file picker to import:

```text
C:\Users\Aryel\Videos\2026-06-28 21-09-32.mp4
```

Verify all of the following in the real browser:

1. The panel header reads `Media` and the `Import` control is styled rather than browser-native.
2. The new card fits within the 280-pixel panel without horizontal overflow.
3. The card initially has `data-state="placeholder"`, then changes to `data-state="ready"` after filmstrip generation.
4. The ready card displays one representative frame only; no neighboring filmstrip tile leaks into the thumbnail.
5. Filename truncation, metadata, hover, remove affordance, and focus outline remain legible.
6. Drag the ready card to V1 and confirm the timeline receives the clip without breaking the card layout.
7. Browser console contains no new warnings or errors.

Capture a screenshot for the completion report. Do not mark the Phase 4 manual gate complete; this pass verifies only the Media Pool change.

- [ ] **Step 9: Review the diff and commit the UI module**

Run:

```powershell
git diff --check
git diff -- src/ui/MediaPool.test.tsx src/ui/MediaPool.tsx src/app/layout.css
git status --short
```

Expected: only the three planned UI files are changed; `AGENTS.md` remains untracked and unstaged.

Create `.git/CODEX_MEDIA_POOL_COMMIT_MSG` with:

```text
Media Pool: add thumbnail cards

Polish the media panel with a compact header and horizontal asset cards that
reuse the existing filmstrip's early frame as a representative thumbnail.
Keep import, metadata, removal, and timeline drag behavior intact.
```

Then run:

```powershell
git add -- src/ui/MediaPool.test.tsx src/ui/MediaPool.tsx src/app/layout.css
git -c user.name="Aryel" -c user.email="zyfvhcfh87@privaterelay.appleid.com" commit --author="Aryel <zyfvhcfh87@privaterelay.appleid.com>" -F .git/CODEX_MEDIA_POOL_COMMIT_MSG
git status --short --branch
```

Expected: the commit succeeds with Aryel as sole author/committer and no AI
attribution trailer. The working tree has no tracked changes; the pre-existing
untracked `AGENTS.md` remains untouched.
