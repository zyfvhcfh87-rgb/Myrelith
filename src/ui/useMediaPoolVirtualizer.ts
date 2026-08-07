import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import {
  computeMediaPoolVirtualWindow,
  planMediaPoolRows,
  type MediaPoolItemModel,
  type MediaPoolVirtualRow,
  type MediaPoolVirtualWindow,
} from './mediaPoolModel'

const FALLBACK_VIEWPORT_HEIGHT = 640
const FALLBACK_LIST_WIDTH = 360
const MEDIA_POOL_SINGLE_COLUMN_WIDTH = 210
const MEDIA_POOL_COMPACT_WIDTH = 300

interface ViewportMeasurement {
  readonly start: number
  readonly end: number
  readonly columnCount: number
}

export interface MediaPoolVirtualizer {
  readonly listRef: RefObject<HTMLUListElement | null>
  readonly columnCount: number
  readonly rows: readonly MediaPoolVirtualRow[]
  readonly virtualWindow: MediaPoolVirtualWindow
  readonly renderedItemIds: readonly string[]
  readonly visibleItemIds: readonly string[]
  readonly rowIndexByItemId: ReadonlyMap<string, number>
  readonly measureRenderedRows: () => void
  readonly ensureRowVisible: (rowIndex: number) => void
  readonly scrollToStart: () => void
}

function scrollRootFor(list: HTMLUListElement): HTMLElement {
  return list.closest<HTMLElement>('[data-media-pool-scroll]')
    ?? list.parentElement
    ?? list
}

function stickyHeaderHeight(root: HTMLElement): number {
  return root.querySelector<HTMLElement>('.media-pool-header')?.offsetHeight ?? 0
}

function listPaddingTop(list: HTMLUListElement): number {
  const parsed = Number.parseFloat(getComputedStyle(list).paddingTop)
  return Number.isFinite(parsed) ? parsed : 0
}

function listOffsetWithinRoot(
  list: HTMLUListElement,
  root: HTMLElement,
): number {
  const listRect = list.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  // jsdom has no layout and reports zero rectangles; offsetTop keeps component
  // tests deterministic while real browsers use the scroll-root coordinate space.
  if (listRect.height === 0 && rootRect.height === 0) return list.offsetTop
  return root.scrollTop + listRect.top - rootRect.top
}

function rowsInRange(
  rows: readonly MediaPoolVirtualRow[],
  start: number,
  end: number,
): string[] {
  return rows.slice(start, end).flatMap((row) => [...row.itemIds])
}

/**
 * Variable-height grid virtualization over the Media Pool's existing scroll
 * owner. Measured row sizes replace conservative estimates after first paint.
 */
export function useMediaPoolVirtualizer(
  items: readonly MediaPoolItemModel[],
): MediaPoolVirtualizer {
  const listRef = useRef<HTMLUListElement>(null)
  const measuredHeightsRef = useRef<Map<string, number>>(new Map())
  const [measurementVersion, setMeasurementVersion] = useState(0)
  const [viewport, setViewport] = useState<ViewportMeasurement>({
    start: 0,
    end: FALLBACK_VIEWPORT_HEIGHT,
    columnCount: 3,
  })

  const measureViewport = useCallback((): void => {
    const list = listRef.current
    if (!list) return
    const root = scrollRootFor(list)
    const rootHeight = root.clientHeight || FALLBACK_VIEWPORT_HEIGHT
    const listWidth = list.clientWidth
      || root.clientWidth
      || FALLBACK_LIST_WIDTH
    const relativeScroll = root.scrollTop
      - listOffsetWithinRoot(list, root)
      - listPaddingTop(list)
    const coveredByStickyHeader = relativeScroll >= 0
      ? stickyHeaderHeight(root)
      : 0
    const start = Math.max(0, relativeScroll + coveredByStickyHeader)
    const end = Math.max(start + 1, relativeScroll + rootHeight)
    const columnCount = listWidth <= MEDIA_POOL_SINGLE_COLUMN_WIDTH
      ? 1
      : listWidth <= MEDIA_POOL_COMPACT_WIDTH ? 2 : 3
    setViewport((current) => (
      current.start === start
      && current.end === end
      && current.columnCount === columnCount
        ? current
        : { start, end, columnCount }
    ))
  }, [])

  const rows = useMemo(
    () => planMediaPoolRows(items, viewport.columnCount),
    [items, viewport.columnCount],
  )

  const virtualWindow = useMemo(
    () => {
      // The version is the invalidation signal for the mutable measurement map.
      void measurementVersion
      return computeMediaPoolVirtualWindow(
        rows,
        measuredHeightsRef.current,
        viewport.start,
        viewport.end,
      )
    },
    [measurementVersion, rows, viewport.end, viewport.start],
  )

  const measureRenderedRows = useCallback((): void => {
    const list = listRef.current
    if (!list) return
    const nextByKey = new Map<string, number>()
    for (const item of list.querySelectorAll<HTMLElement>('[data-media-virtual-row]')) {
      const key = item.dataset.mediaVirtualRow
      const height = item.getBoundingClientRect().height
      if (!key || !Number.isFinite(height) || height <= 0) continue
      nextByKey.set(key, Math.max(nextByKey.get(key) ?? 0, height))
    }
    let changed = false
    for (const [key, height] of nextByKey) {
      const previous = measuredHeightsRef.current.get(key)
      if (previous === undefined || Math.abs(previous - height) >= 0.5) {
        measuredHeightsRef.current.set(key, height)
        changed = true
      }
    }
    if (changed) setMeasurementVersion((version) => version + 1)
  }, [])

  useLayoutEffect(() => {
    const currentKeys = new Set(rows.map((row) => row.key))
    for (const key of measuredHeightsRef.current.keys()) {
      if (!currentKeys.has(key)) measuredHeightsRef.current.delete(key)
    }
  }, [rows])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const root = scrollRootFor(list)
    let frame = 0
    const scheduleMeasure = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measureViewport()
        measureRenderedRows()
      })
    }
    root.addEventListener('scroll', scheduleMeasure, { passive: true })
    window.addEventListener('resize', scheduleMeasure)
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(scheduleMeasure)
      : null
    observer?.observe(root)
    observer?.observe(list)
    const header = root.querySelector<HTMLElement>('.media-pool-header')
    if (header) observer?.observe(header)
    measureViewport()
    measureRenderedRows()
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      root.removeEventListener('scroll', scheduleMeasure)
      window.removeEventListener('resize', scheduleMeasure)
      observer?.disconnect()
    }
  }, [measureRenderedRows, measureViewport])

  useLayoutEffect(() => {
    measureRenderedRows()
  }, [measureRenderedRows, virtualWindow.renderEndRow, virtualWindow.renderStartRow])

  const ensureRowVisible = useCallback((rowIndex: number): void => {
    const list = listRef.current
    const rowOffset = virtualWindow.rowOffsets[rowIndex]
    const rowHeight = virtualWindow.rowHeights[rowIndex]
    if (!list || rowOffset === undefined || rowHeight === undefined) return
    const root = scrollRootFor(list)
    const rootHeight = root.clientHeight || FALLBACK_VIEWPORT_HEIGHT
    const headerHeight = stickyHeaderHeight(root)
    const rowStart = listOffsetWithinRoot(list, root)
      + listPaddingTop(list)
      + rowOffset
    const rowEnd = rowStart + rowHeight
    const visibleStart = root.scrollTop + headerHeight
    const visibleEnd = root.scrollTop + rootHeight
    if (rowStart < visibleStart) {
      root.scrollTop = Math.max(0, rowStart - headerHeight)
    } else if (rowEnd > visibleEnd) {
      root.scrollTop = Math.max(0, rowEnd - rootHeight)
    }
    measureViewport()
  }, [measureViewport, virtualWindow.rowHeights, virtualWindow.rowOffsets])

  const scrollToStart = useCallback((): void => {
    const list = listRef.current
    if (!list) return
    const root = scrollRootFor(list)
    root.scrollTop = Math.max(
      0,
      listOffsetWithinRoot(list, root) - stickyHeaderHeight(root),
    )
    measureViewport()
  }, [measureViewport])

  const renderedItemIds = useMemo(
    () => rowsInRange(
      rows,
      virtualWindow.renderStartRow,
      virtualWindow.renderEndRow,
    ),
    [rows, virtualWindow.renderEndRow, virtualWindow.renderStartRow],
  )
  const visibleItemIds = useMemo(
    () => rowsInRange(
      rows,
      virtualWindow.visibleStartRow,
      virtualWindow.visibleEndRow,
    ),
    [rows, virtualWindow.visibleEndRow, virtualWindow.visibleStartRow],
  )
  const rowIndexByItemId = useMemo(() => {
    const result = new Map<string, number>()
    rows.forEach((row, rowIndex) => {
      for (const id of row.itemIds) result.set(id, rowIndex)
    })
    return result
  }, [rows])

  return {
    listRef,
    columnCount: viewport.columnCount,
    rows,
    virtualWindow,
    renderedItemIds,
    visibleItemIds,
    rowIndexByItemId,
    measureRenderedRows,
    ensureRowVisible,
    scrollToStart,
  }
}
