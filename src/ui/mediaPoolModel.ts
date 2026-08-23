/**
 * Pure Media Pool indexing, filtering, sorting, and virtual-row planning.
 *
 * The functions in this file preserve catalog insertion order and never mutate
 * project or session state. Keeping this work outside React also makes the
 * 500-asset acceptance fixture deterministic and cheap to exercise in Node.
 */

import type { MediaCompatibilityItem } from '../domain/mediaCompatibility'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { MediaAsset } from '../domain/schema'
import type {
  MediaPoolSortDirection,
  MediaPoolSortField,
  MediaPoolThumbnailSize,
  MediaPoolViewMode,
} from '../state/preferencesStore'

export type {
  MediaPoolSortDirection,
  MediaPoolSortField,
  MediaPoolThumbnailSize,
  MediaPoolViewMode,
} from '../state/preferencesStore'

export type MediaPoolKind = 'video' | 'audio' | 'image' | 'unknown'
export type MediaPoolKindFilter = 'all' | Exclude<MediaPoolKind, 'unknown'>
export type MediaPoolStatus =
  | 'ready'
  | 'offline'
  | 'checking'
  | 'limited'
  | 'unsupported'
  | 'error'
export type MediaPoolStatusFilter = 'all' | MediaPoolStatus

export const MEDIA_POOL_KIND_SORT_RANK: Readonly<Record<MediaPoolKind, number>> = {
  video: 0,
  audio: 1,
  image: 2,
  unknown: 3,
}

export interface MediaPoolRowLayout {
  readonly viewMode: MediaPoolViewMode
  readonly thumbnailSize: MediaPoolThumbnailSize
  readonly expandedItemId: string | null
}

export const DEFAULT_MEDIA_POOL_ROW_LAYOUT: MediaPoolRowLayout = {
  viewMode: 'thumbnail',
  thumbnailSize: 'medium',
  expandedItemId: null,
}

export const MEDIA_POOL_THUMBNAIL_TILE_WIDTH_PX = {
  small: 100,
  medium: 140,
  large: 180,
} as const

export const MEDIA_POOL_COMPACT_ROW_ESTIMATE_PX = 36
export const MEDIA_POOL_DETAILS_ROW_ESTIMATE_PX = {
  small: 56,
  medium: 72,
  large: 88,
} as const
export const MEDIA_POOL_THUMBNAIL_ROW_ESTIMATE_PX = {
  small: 96,
  medium: 112,
  large: 176,
} as const

export interface MediaPoolFilter {
  readonly query: string
  readonly kind: MediaPoolKindFilter
  readonly status: MediaPoolStatusFilter
}

export interface MediaPoolItemModel {
  readonly id: string
  readonly fileName: string
  readonly kind: MediaPoolKind
  readonly statuses: ReadonlySet<MediaPoolStatus>
  readonly searchText: string
  /** Exceptional statuses occupy a full-width row; Ready items follow the view. */
  readonly expanded: boolean
  readonly catalogIndex: number
  readonly durationMicroseconds: number | null
  readonly lastModified: number | null
  readonly size: number | null
}

export interface MediaPoolVirtualRow {
  readonly key: string
  readonly itemIds: readonly string[]
  readonly itemStartIndex: number
  readonly estimatedHeight: number
}

export interface MediaPoolVirtualWindow {
  readonly renderStartRow: number
  readonly renderEndRow: number
  readonly visibleStartRow: number
  readonly visibleEndRow: number
  readonly topSpacerHeight: number
  readonly bottomSpacerHeight: number
  readonly totalHeight: number
  readonly rowOffsets: readonly number[]
  readonly rowHeights: readonly number[]
}

export const MEDIA_POOL_GRID_GAP_PX = 12
export const MEDIA_POOL_NORMAL_ROW_ESTIMATE_PX = 112
export const MEDIA_POOL_EXPANDED_ROW_ESTIMATE_PX = 230
export const MEDIA_POOL_OVERSCAN_PX = 260

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function inferredKind(
  descriptor: PortableAssetDescriptor | undefined,
  compatibility: MediaCompatibilityItem | undefined,
): MediaPoolKind {
  if (descriptor) return descriptor.kind
  const report = compatibility?.report
  if (report?.image) return 'image'
  if (report?.tracks.some((track) => track.kind === 'video' && track.primary)) {
    return 'video'
  }
  if (report?.tracks.some((track) => track.kind === 'audio' && track.primary)) {
    return 'audio'
  }
  if (report?.tracks.some((track) => track.kind === 'video')) return 'video'
  if (report?.tracks.some((track) => track.kind === 'audio')) return 'audio'
  return 'unknown'
}

function searchableCompatibility(item: MediaCompatibilityItem | undefined): string[] {
  if (!item) return []
  const report = item.report
  if (!report) return [item.status, item.declaredMimeType]
  return [
    item.status,
    item.declaredMimeType,
    report.container?.name ?? '',
    report.container?.fullMimeType ?? '',
    report.image?.format ?? '',
    report.image?.decodePath ?? '',
    report.detail ?? '',
    ...report.tracks.flatMap((track) => [
      track.kind,
      track.codec ?? '',
      track.codecParameter ?? '',
      track.decoderConfig?.codec ?? '',
      track.decoderPath ?? '',
      track.detail ?? '',
    ]),
    ...(report.runtimeFailures ?? []).flatMap((failure) => [
      failure.surface,
      failure.trackKind ?? '',
      failure.reason,
      failure.detail ?? '',
    ]),
  ]
}

function itemStatuses(
  descriptor: PortableAssetDescriptor | undefined,
  asset: MediaAsset | undefined,
  compatibility: MediaCompatibilityItem | undefined,
): ReadonlySet<MediaPoolStatus> {
  const statuses = new Set<MediaPoolStatus>()
  if (descriptor && !asset) statuses.add('offline')
  if (asset && (!compatibility || compatibility.status === 'ready')) {
    statuses.add('ready')
  }
  if (compatibility && compatibility.status !== 'ready') {
    statuses.add(compatibility.status)
  }
  return statuses
}

/** Build one stable, search-ready model per durable or provisional row. */
export function buildMediaPoolItems(
  descriptors: ReadonlyMap<string, PortableAssetDescriptor>,
  assets: ReadonlyMap<string, MediaAsset>,
  compatibility: ReadonlyMap<string, MediaCompatibilityItem>,
): readonly MediaPoolItemModel[] {
  const ids = [
    ...descriptors.keys(),
    ...[...compatibility.keys()].filter((id) => !descriptors.has(id)),
  ]
  return ids.flatMap((id, catalogIndex) => {
    const descriptor = descriptors.get(id)
    const compatibilityItem = compatibility.get(id)
    const fileName = descriptor?.fileName ?? compatibilityItem?.fileName
    if (!fileName) return []
    const kind = inferredKind(descriptor, compatibilityItem)
    const statuses = itemStatuses(
      descriptor,
      assets.get(id),
      compatibilityItem,
    )
    const searchText = normalizeSearchText([
      fileName,
      kind,
      ...statuses,
      descriptor?.mimeType ?? '',
      ...searchableCompatibility(compatibilityItem),
    ].join('\n'))
    return [{
      id,
      fileName,
      kind,
      statuses,
      searchText,
      expanded: [...statuses].some((status) => status !== 'ready'),
      catalogIndex,
      durationMicroseconds: descriptor?.durationMicroseconds ?? null,
      lastModified: descriptor?.lastModified ?? null,
      size: descriptor?.size ?? null,
    }]
  })
}

/** Preserve source order while applying ANDed text tokens plus exact facets. */
export function filterMediaPoolItems(
  items: readonly MediaPoolItemModel[],
  filter: MediaPoolFilter,
  allowedAssetIds: ReadonlySet<string> | null = null,
): readonly MediaPoolItemModel[] {
  const tokens = normalizeSearchText(filter.query).split(/\s+/).filter(Boolean)
  return items.filter((item) => (
    (allowedAssetIds === null || allowedAssetIds.has(item.id))
    && (filter.kind === 'all' || item.kind === filter.kind)
    && (filter.status === 'all' || item.statuses.has(filter.status))
    && tokens.every((token) => item.searchText.includes(token))
  ))
}

function compareNaturalFileName(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
}

function compareKnownNumbersLast(
  left: number | null,
  right: number | null,
  direction: MediaPoolSortDirection,
): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  const delta = left - right
  return direction === 'ascending' ? delta : -delta
}

function compareSortField(
  left: MediaPoolItemModel,
  right: MediaPoolItemModel,
  field: MediaPoolSortField,
  direction: MediaPoolSortDirection,
): number {
  const sign = direction === 'ascending' ? 1 : -1
  switch (field) {
    case 'project-order':
      return (left.catalogIndex - right.catalogIndex) * sign
    case 'name':
      return compareNaturalFileName(left.fileName, right.fileName) * sign
    case 'kind':
      return (
        (MEDIA_POOL_KIND_SORT_RANK[left.kind] - MEDIA_POOL_KIND_SORT_RANK[right.kind])
        * sign
      )
    case 'duration':
      return compareKnownNumbersLast(
        left.durationMicroseconds,
        right.durationMicroseconds,
        direction,
      )
    case 'last-modified':
      return compareKnownNumbersLast(left.lastModified, right.lastModified, direction)
    case 'size':
      return compareKnownNumbersLast(left.size, right.size, direction)
  }
}

/**
 * Return a new ordered copy after collection/filter selection. Catalog maps and
 * the input array stay untouched. Missing numeric metadata always sorts last.
 */
export function sortMediaPoolItems(
  items: readonly MediaPoolItemModel[],
  field: MediaPoolSortField,
  direction: MediaPoolSortDirection,
): readonly MediaPoolItemModel[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const primary = compareSortField(left.item, right.item, field, direction)
      if (primary !== 0) return primary
      if (left.item.catalogIndex !== right.item.catalogIndex) {
        return left.item.catalogIndex - right.item.catalogIndex
      }
      if (left.item.id !== right.item.id) {
        return left.item.id < right.item.id ? -1 : 1
      }
      return left.index - right.index
    })
    .map((entry) => entry.item)
}

export function mediaPoolShowsThumbnails(viewMode: MediaPoolViewMode): boolean {
  return viewMode !== 'compact-list'
}

export function mediaPoolColumnCount(
  listWidth: number,
  viewMode: MediaPoolViewMode,
  thumbnailSize: MediaPoolThumbnailSize,
): number {
  if (viewMode !== 'thumbnail') return 1
  const tile = MEDIA_POOL_THUMBNAIL_TILE_WIDTH_PX[thumbnailSize]
  const width = Math.max(0, listWidth)
  return Math.max(1, Math.floor((width + MEDIA_POOL_GRID_GAP_PX) / (tile + MEDIA_POOL_GRID_GAP_PX)))
}

function estimatedRowHeight(
  isolated: boolean,
  layout: MediaPoolRowLayout,
): number {
  if (isolated) return MEDIA_POOL_EXPANDED_ROW_ESTIMATE_PX
  if (layout.viewMode === 'compact-list') return MEDIA_POOL_COMPACT_ROW_ESTIMATE_PX
  if (layout.viewMode === 'details') {
    return MEDIA_POOL_DETAILS_ROW_ESTIMATE_PX[layout.thumbnailSize]
  }
  return MEDIA_POOL_THUMBNAIL_ROW_ESTIMATE_PX[layout.thumbnailSize]
}

function isolateMediaPoolItem(
  item: MediaPoolItemModel,
  layout: MediaPoolRowLayout,
): boolean {
  return item.expanded || item.id === layout.expandedItemId
}

/**
 * Pack ordinary cards by visual grid row while keeping expanded diagnostics on
 * their own row. The item order is identical to the filtered catalog order.
 */
export function planMediaPoolRows(
  items: readonly MediaPoolItemModel[],
  columnCount: number,
  layout: MediaPoolRowLayout = DEFAULT_MEDIA_POOL_ROW_LAYOUT,
): readonly MediaPoolVirtualRow[] {
  const columns = Math.max(1, Math.floor(columnCount))
  const rows: MediaPoolVirtualRow[] = []
  let pending: MediaPoolItemModel[] = []
  const layoutKey = `${layout.viewMode}:${layout.thumbnailSize}`

  const flushPending = (): void => {
    if (pending.length === 0) return
    const itemIds = pending.map((item) => item.id)
    rows.push({
      key: `${layoutKey}:cards:${itemIds.join('|')}`,
      itemIds,
      itemStartIndex: 0,
      estimatedHeight: estimatedRowHeight(false, layout),
    })
    pending = []
  }

  for (const item of items) {
    if (isolateMediaPoolItem(item, layout)) {
      flushPending()
      rows.push({
        key: `${layoutKey}:full-width:${item.id}`,
        itemIds: [item.id],
        itemStartIndex: 0,
        estimatedHeight: estimatedRowHeight(true, layout),
      })
      continue
    }
    pending.push(item)
    if (pending.length === columns) flushPending()
  }
  flushPending()

  // flushPending computes its own index so mixed expanded/card rows stay exact.
  let consumed = 0
  return rows.map((row) => {
    const planned = { ...row, itemStartIndex: consumed }
    consumed += row.itemIds.length
    return planned
  })
}

function firstRowEndingAfter(
  rowOffsets: readonly number[],
  rowHeights: readonly number[],
  position: number,
): number {
  for (let index = 0; index < rowOffsets.length; index++) {
    if (rowOffsets[index] + rowHeights[index] > position) return index
  }
  return Math.max(0, rowOffsets.length - 1)
}

function firstRowStartingAtOrAfter(
  rowOffsets: readonly number[],
  position: number,
): number {
  for (let index = 0; index < rowOffsets.length; index++) {
    if (rowOffsets[index] >= position) return index
  }
  return rowOffsets.length
}

/** Compute one contiguous overscanned window and exact spacer geometry. */
export function computeMediaPoolVirtualWindow(
  rows: readonly MediaPoolVirtualRow[],
  measuredHeights: ReadonlyMap<string, number>,
  viewportStart: number,
  viewportEnd: number,
  overscanPx = MEDIA_POOL_OVERSCAN_PX,
): MediaPoolVirtualWindow {
  if (rows.length === 0) {
    return {
      renderStartRow: 0,
      renderEndRow: 0,
      visibleStartRow: 0,
      visibleEndRow: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalHeight: 0,
      rowOffsets: [],
      rowHeights: [],
    }
  }

  const rowOffsets: number[] = []
  const rowHeights: number[] = []
  let cursor = 0
  for (const row of rows) {
    rowOffsets.push(cursor)
    const measured = measuredHeights.get(row.key)
    const height = measured && measured > 0
      ? measured
      : row.estimatedHeight
    rowHeights.push(height)
    cursor += height + MEDIA_POOL_GRID_GAP_PX
  }
  const totalHeight = Math.max(0, cursor - MEDIA_POOL_GRID_GAP_PX)
  const start = Math.max(0, Math.min(viewportStart, totalHeight))
  const end = Math.max(start + 1, Math.min(viewportEnd, totalHeight))
  const visibleStartRow = firstRowEndingAfter(rowOffsets, rowHeights, start)
  const visibleEndRow = Math.max(
    visibleStartRow + 1,
    firstRowStartingAtOrAfter(rowOffsets, end),
  )
  const renderStartRow = firstRowEndingAfter(
    rowOffsets,
    rowHeights,
    Math.max(0, start - overscanPx),
  )
  const renderEndRow = Math.max(
    renderStartRow + 1,
    firstRowStartingAtOrAfter(rowOffsets, Math.min(totalHeight, end + overscanPx)),
  )
  const topSpacerHeight = renderStartRow === 0
    ? 0
    : Math.max(0, rowOffsets[renderStartRow] - MEDIA_POOL_GRID_GAP_PX)
  const bottomSpacerHeight = renderEndRow >= rows.length
    ? 0
    : Math.max(
        0,
        totalHeight - rowOffsets[renderEndRow],
      )

  return {
    renderStartRow,
    renderEndRow: Math.min(rows.length, renderEndRow),
    visibleStartRow,
    visibleEndRow: Math.min(rows.length, visibleEndRow),
    topSpacerHeight,
    bottomSpacerHeight,
    totalHeight,
    rowOffsets,
    rowHeights,
  }
}
