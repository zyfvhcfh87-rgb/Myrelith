import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { animationKeyGlyphs, animationLowerBound, animationLaneKey, ANIMATION_VIEW_LIMITS, type AnimationLaneIndex, type AnimationLaneRow, type AnimationKeyAddress } from '../../state/animationEditor'
import { useTransportStore } from '../../state/transportStore'
import { calculateTimelineViewport, planTimelineAnchor, planTimelineEdgeRebase, MAX_TIMELINE_SURFACE_PX } from '../timeline/timelineViewport'
import { timelineRunwayFrames } from '../timeline/timelineZoom'
import { useAnimationPointer } from './useAnimationPointer'
import AnimationCurve from './AnimationCurve'

const GUTTER = 248, ROW = ANIMATION_VIEW_LIMITS.rowHeight
export default memo(function AnimationGrid({ index, rows, focused, frame, mode, selection, onSelect, onLane, reveal, requestedFrame }: {
  index: AnimationLaneIndex; rows: readonly AnimationLaneRow[]; focused?: AnimationLaneRow; frame: number | null; mode: 'sheet' | 'curve'
  selection: readonly AnimationKeyAddress[]; onSelect: (row: AnimationLaneRow, offset: number, extend: boolean, toggle: boolean) => void
  onLane: (row: AnimationLaneRow) => void; reveal: number; requestedFrame: number | null
}) {
  const root = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 600, height: 200 }), [scroll, setScroll] = useState({ left: 0, top: 0 })
  const zoom = useTransportStore((state) => state.zoom), origin = useTransportStore((state) => state.timelineOriginFrame)
  const preview = useTransportStore((state) => state.animationPreview)
  const drag = useAnimationPointer(index, zoom, onSelect)
  const extent = useMemo(() => {
    let last = 1
    for (const row of index.lanes) last = Math.max(last, row.owner.item.timelineRange.startFrame + row.owner.item.timelineRange.durationFrames, row.globalFrames.at(-1) ?? 0)
    return Math.min(Number.MAX_SAFE_INTEGER, last + 1)
  }, [index])
  const totalFrames = timelineRunwayFrames(extent, index.document.frameRate), geometry = calculateTimelineViewport(totalFrames, zoom, origin)
  const width = Math.max(1, size.width - GUTTER), start = geometry.originFrame + scroll.left / zoom, end = Math.min(totalFrames, start + width / zoom)
  const logicalHeight = Math.max(size.height, rows.length * ROW), physicalHeight = Math.min(MAX_TIMELINE_SURFACE_PX, logicalHeight)
  const logicalTop = physicalHeight <= size.height ? 0 : scroll.top / (physicalHeight - size.height) * (logicalHeight - size.height)
  const first = Math.max(0, Math.floor(logicalTop / ROW) - 3), count = Math.min(39, Math.ceil(size.height / ROW) + 6)
  const mounted = rows.slice(first, first + count).map((row, offset) => ({ row, position: first + offset }))
  const focusedPosition = focused ? rows.indexOf(focused) : -1
  if (focused && focusedPosition >= 0 && !mounted.some(({ row }) => row.id === focused.id)) mounted.push({ row: focused, position: focusedPosition })
  const budget = Math.max(1, Math.floor(ANIMATION_VIEW_LIMITS.glyphs / Math.max(1, mounted.length) / (preview ? 2 : 1)))
  const selected = useMemo(() => {
    const result = new Map<string, number[]>()
    for (const key of selection) { const id = animationLaneKey(key.lane), frames = result.get(id) ?? []; frames.push(key.frame); result.set(id, frames) }
    for (const frames of result.values()) frames.sort((a, b) => a - b)
    return result
  }, [selection])
  const ghosts = useMemo(() => {
    const result = new Map<string, number[]>()
    for (const key of preview?.selection ?? []) { const id = animationLaneKey(key.lane), frames = result.get(id) ?? []; frames.push(key.frame); result.set(id, frames) }
    for (const frames of result.values()) frames.sort((a, b) => a - b)
    return result
  }, [preview])
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => { const width = element.clientWidth || 600, height = element.clientHeight || 200; setSize((current) => current.width === width && current.height === height ? current : { width, height }) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect()
  }, [])
  useEffect(() => { useTransportStore.getState().setAnimationVisibleRange({ startFrame: Math.floor(start), endFrame: Math.ceil(end) }) }, [start, end])
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    if (focusedPosition >= 0 && mode === 'sheet' && requestedFrame === null) {
      const target = Math.max(0, focusedPosition * ROW - size.height / 2)
      element.scrollTop = logicalHeight <= size.height ? 0 : target / (logicalHeight - size.height) * (physicalHeight - size.height)
    }
    if (mode === 'curve') element.scrollTop = 0
    const global = requestedFrame ?? (focused ? focused.owner.item.timelineRange.startFrame + (frame ?? focused.frames[0] ?? 0) : 0)
    const plan = planTimelineAnchor(totalFrames, zoom, width, Math.max(0, global), requestedFrame === null ? width / 2 : 0)
    useTransportStore.getState().setTimelineOriginFrame(plan.originFrame)
    element.scrollLeft = plan.scrollLeft
    setScroll({ left: element.scrollLeft, top: element.scrollTop })
    // Reveal is an explicit navigation command; previews/playhead ticks do not scroll this view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, index.document.id])
  return <div className="animation-grid-wrap">
    <div className="animation-ruler"><span style={{ width: GUTTER }}>Track / item / property</span><svg width={width} height={22} aria-hidden="true">
      {Array.from({ length: 7 }, (_, index) => { const frame = Math.round(start + (end - start) * index / 6); return <text key={index} x={width * index / 6 + 2} y={15}>{frame}</text> })}</svg></div>
    <div ref={root} className="animation-grid" data-timeline-scroll role="grid" aria-label="Animation keys" aria-rowcount={rows.length} tabIndex={0}
      aria-activedescendant={focused ? 'animation-focused-description' : undefined}
      onScroll={() => {
        const element = root.current!
        drag.cancel()
        const rebase = planTimelineEdgeRebase(geometry, zoom, width, element.scrollLeft)
        if (rebase) { flushSync(() => useTransportStore.getState().setTimelineOriginFrame(rebase.originFrame)); element.scrollLeft = rebase.scrollLeft }
        setScroll({ left: element.scrollLeft, top: element.scrollTop })
      }}>
      <div data-timeline-headers style={{ width: GUTTER, height: 0 }} />
      <div className="animation-grid-surface" style={{ width: GUTTER + geometry.surfaceWidth, height: mode === 'curve' ? size.height : physicalHeight }}>
        {mode === 'curve' ? <div style={{ position: 'absolute', left: scroll.left + GUTTER, top: 0, width, height: size.height }}>
          <AnimationCurve row={focused} frame={frame} start={start} end={end} width={width} height={size.height} />
        </div> : mounted.map(({ row, position }) => {
          const outside = position < first || position >= first + count
          const y = outside ? -ROW * 2 : scroll.top + position * ROW - logicalTop
          const glyphs = animationKeyGlyphs(row, Math.floor(start), Math.ceil(end), budget)
          const ghostFrames = ghosts.get(row.id) ?? []
          const ghostRow = { ...row, frames: ghostFrames, globalFrames: ghostFrames.map((frame) => row.owner.item.timelineRange.startFrame + frame) }
          return <div key={row.id} className={`animation-lane${focused?.id === row.id ? ' is-focused' : ''}`} role="row" aria-rowindex={position + 1} style={{ top: y, height: ROW }} data-animation-lane>
            <button type="button" tabIndex={-1} role="rowheader" aria-label={`${row.group}, ${row.label}, ${row.frames.length} keys${row.reason ? `, ${row.reason}` : ''}`} onClick={() => { onLane(row); root.current?.focus() }}
              className="animation-lane-label" style={{ left: scroll.left, width: GUTTER }}><span>{row.group}</span><strong>{row.label} <small>{row.status === 'hold' ? 'HOLD' : row.status === 'unavailable' ? 'Unavailable' : ''}{row.owner.track.locked ? ' · Locked' : ''}</small></strong></button>
            <svg width={width} height={ROW} className="animation-key-lane" style={{ left: scroll.left + GUTTER }} aria-label={`${row.label} key positions`}>
              {glyphs.map((glyph) => {
                const offset = glyph.first, keyFrame = row.frames[offset], selectedFrames = selected.get(row.id) ?? []
                const selectedCount = animationLowerBound(selectedFrames, row.frames[glyph.end - 1] + 1) - animationLowerBound(selectedFrames, keyFrame)
                const pressed = selectedCount > 0
                return <g key={offset} transform={`translate(${(glyph.globalFrame - start) * zoom} ${ROW / 2})`} data-animation-glyph
                  role="gridcell" aria-selected={pressed} aria-label={`${row.label}, local frame ${keyFrame}${glyph.count > 1 ? `, ${glyph.count} keys in this bucket, ${selectedCount} selected; use arrow keys for exact selection` : ''}`}
                  className={pressed ? 'animation-key is-selected' : 'animation-key'}
                  onPointerDown={(event) => { const local = event.clientX - event.currentTarget.ownerSVGElement!.getBoundingClientRect().left; const nearest = animationLowerBound(row.globalFrames, start + local / zoom); drag.down(event, row, Math.max(glyph.first, Math.min(glyph.end - 1, nearest))); root.current?.focus() }}
                  onPointerMove={drag.move} onPointerUp={drag.up} onPointerCancel={drag.cancel} onLostPointerCapture={drag.cancel}>
                  {glyph.count > 1 ? <><rect x={-10} y={-9} width={20} height={18} rx={3} /><text textAnchor="middle" y={4}>{glyph.count}</text></> : <path d="M 0 -6 L 6 0 L 0 6 L -6 0 Z" />}
                </g>
              })}
              {preview && animationKeyGlyphs(ghostRow, Math.floor(start), Math.ceil(end), budget).map((glyph) => <path key={`ghost-${glyph.first}`} data-animation-glyph className="animation-key-ghost" transform={`translate(${(glyph.globalFrame - start) * zoom} ${ROW / 2})`} d="M 0 -7 L 7 0 L 0 7 L -7 0 Z" />)}
            </svg>
          </div>
        })}
        <AnimationPlayhead start={start} end={end} zoom={zoom} left={scroll.left + GUTTER} height={size.height} top={scroll.top} />
      </div>
      {focused && <span id="animation-focused-description" className="visually-hidden" role="gridcell">{focused.group}, {focused.label}, {frame === null ? 'no selected key' : `local frame ${frame}`}, {focused.reason ?? 'scalar editing available'}</span>}
    </div>
  </div>
})
function AnimationPlayhead({ start, end, zoom, left, height, top }: { start: number; end: number; zoom: number; left: number; height: number; top: number }) {
  const frame = useTransportStore((state) => state.playheadFrame), guide = useTransportStore((state) => state.snapGuide)
  return <>{frame >= start && frame <= end && <div className="animation-playhead" style={{ left: left + (frame - start) * zoom, height, top }} />}
    {guide && guide.frame >= start && guide.frame <= end && <div className="animation-snap-guide" style={{ left: left + (guide.frame - start) * zoom, height, top }} />}</>
}
