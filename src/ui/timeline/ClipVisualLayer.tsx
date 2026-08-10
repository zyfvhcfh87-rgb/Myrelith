/** Render ClipView's already-planned decorative filmstrip or waveform. */

import type { ClipGeneratedVisualPresentation } from './clipVisualPlan'

interface ClipVisualLayerProps {
  clipId: string
  visual: ClipGeneratedVisualPresentation
}

export default function ClipVisualLayer({
  clipId,
  visual,
}: ClipVisualLayerProps) {
  if (!visual) return null

  if (visual.kind === 'waveform') {
    if (visual.segments && visual.widthPx !== undefined) {
      return (
        <svg
          className="clip-visual clip-waveform"
          data-testid={`clip-${clipId}-visual`}
          aria-hidden="true"
          focusable="false"
          preserveAspectRatio="none"
          viewBox={`0 0 ${Math.max(1, visual.widthPx)} 1`}
        >
          {visual.segments.map((segment) => (
            <svg
              key={segment.index}
              x={segment.leftPx}
              y="0"
              width={segment.widthPx}
              height="1"
              preserveAspectRatio="none"
              viewBox={segment.viewBox}
            >
              <image
                href={visual.source.url}
                x="0"
                y="0"
                width="1"
                height="1"
                preserveAspectRatio="none"
              />
            </svg>
          ))}
        </svg>
      )
    }
    return (
      <svg
        className="clip-visual clip-waveform"
        data-testid={`clip-${clipId}-visual`}
        aria-hidden="true"
        focusable="false"
        preserveAspectRatio="none"
        viewBox={visual.viewBox ?? '0 0 1 1'}
      >
        <image
          href={visual.source.url}
          x="0"
          y="0"
          width="1"
          height="1"
          preserveAspectRatio="none"
        />
      </svg>
    )
  }

  const { source } = visual
  return (
    <div
      className="clip-visual clip-filmstrip"
      data-testid={`clip-${clipId}-visual`}
    >
      {visual.tiles.map((tile) => {
        const patternId = `${clipId}-filmstrip-pattern-${tile.index}`
        return (
          <svg
            key={tile.index}
            className="clip-filmstrip-tile"
            data-testid={`clip-${clipId}-filmstrip-tile-${tile.index}`}
            aria-hidden="true"
            focusable="false"
            style={{
              left: tile.leftPx,
              width: tile.widthPx,
            }}
          >
            <defs>
              <pattern
                id={patternId}
                patternUnits="userSpaceOnUse"
                x={tile.patternX}
                width={source.tileWidth}
                height={source.tileHeight}
              >
                <image
                  href={source.url}
                  x={tile.spriteX}
                  width={source.tiles * source.tileWidth}
                  height={source.tileHeight}
                />
              </pattern>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill={`url(#${patternId})`}
            />
          </svg>
        )
      })}
    </div>
  )
}
