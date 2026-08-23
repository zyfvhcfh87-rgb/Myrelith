import { describe, expect, test } from 'vitest'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { MediaAsset } from '../domain/schema'
import {
  buildMediaPoolItems,
  computeMediaPoolVirtualWindow,
  filterMediaPoolItems,
  mediaPoolColumnCount,
  mediaPoolShowsThumbnails,
  planMediaPoolRows,
  sortMediaPoolItems,
  type MediaPoolItemModel,
  type MediaPoolRowLayout,
  type MediaPoolStatus,
} from './mediaPoolModel'

function descriptor(
  id: string,
  fileName: string,
  kind: PortableAssetDescriptor['kind'],
): PortableAssetDescriptor {
  return {
    id,
    fileName,
    mimeType: kind === 'video'
      ? 'video/mp4'
      : kind === 'audio' ? 'audio/wav' : 'image/webp',
    size: 1_024,
    lastModified: 1,
    kind,
    durationMicroseconds: 4_000_000,
    sourceBounds: {
      video: { status: 'unknown' },
      audio: { status: 'unknown' },
    },
    nativeFrameRate: kind === 'video' ? { num: 30, den: 1 } : null,
    width: kind === 'audio' ? null : 1_920,
    height: kind === 'audio' ? null : 1_080,
    hasAudio: kind !== 'image',
    audioSampleRate: kind !== 'image' ? 48_000 : null,
    audioChannels: kind !== 'image' ? 2 : null,
  }
}

function connectedAsset(source: PortableAssetDescriptor): MediaAsset {
  return {
    ...source,
    objectUrl: `blob:${source.id}`,
    durationFrames: 120,
    frameRate: source.nativeFrameRate,
    decoderConfigB64: null,
  }
}

function item(id: string, expanded = false): MediaPoolItemModel {
  return {
    id,
    fileName: `${id}.mp4`,
    kind: 'audio',
    statuses: new Set<MediaPoolStatus>(['ready']),
    searchText: `${id}.mp4 video ready`,
    expanded,
    catalogIndex: 0,
    durationMicroseconds: 4_000_000,
    lastModified: 1,
    size: 1_024,
  }
}

describe('mediaPoolModel', () => {
  test('filters deterministically without mutating catalog maps or source order', () => {
    const beach = descriptor('beach', 'Beach Take 01.MP4', 'video')
    const interview = descriptor('interview', 'Interview.wav', 'audio')
    const poster = descriptor('poster', 'Launch Poster.webp', 'image')
    const descriptors = new Map([
      [beach.id, beach],
      [interview.id, interview],
      [poster.id, poster],
    ])
    const assets = new Map([
      [beach.id, connectedAsset(beach)],
      [interview.id, connectedAsset(interview)],
    ])
    const compatibility = new Map()
    const descriptorOrder = [...descriptors.keys()]
    const assetOrder = [...assets.keys()]

    const items = buildMediaPoolItems(descriptors, assets, compatibility)

    expect(filterMediaPoolItems(items, {
      query: 'take 01',
      kind: 'video',
      status: 'ready',
    }).map((candidate) => candidate.id)).toEqual(['beach'])
    expect(filterMediaPoolItems(items, {
      query: 'launch',
      kind: 'image',
      status: 'offline',
    }).map((candidate) => candidate.id)).toEqual(['poster'])
    expect(filterMediaPoolItems(items, {
      query: '',
      kind: 'all',
      status: 'all',
    }).map((candidate) => candidate.id)).toEqual(descriptorOrder)
    expect([...descriptors.keys()]).toEqual(descriptorOrder)
    expect([...assets.keys()]).toEqual(assetOrder)
    expect(items.find((candidate) => candidate.id === 'beach')?.expanded).toBe(false)
    expect(items.find((candidate) => candidate.id === 'poster')?.expanded).toBe(true)
  })

  test('bounds a 500-item render window while preserving stable item identity', () => {
    const items = Array.from({ length: 500 }, (_, index) => (
      item(`asset-${String(index).padStart(3, '0')}`)
    ))
    const rows = planMediaPoolRows(items, 3)
    const firstWindow = computeMediaPoolVirtualWindow(rows, new Map(), 0, 640)
    const lastWindow = computeMediaPoolVirtualWindow(
      rows,
      new Map(),
      firstWindow.totalHeight - 640,
      firstWindow.totalHeight,
    )
    const firstRendered = rows
      .slice(firstWindow.renderStartRow, firstWindow.renderEndRow)
      .flatMap((row) => row.itemIds)
    const lastRendered = rows
      .slice(lastWindow.renderStartRow, lastWindow.renderEndRow)
      .flatMap((row) => row.itemIds)

    expect(rows).toHaveLength(167)
    expect(firstRendered.length).toBeLessThan(40)
    expect(lastRendered.length).toBeLessThan(40)
    expect(firstRendered[0]).toBe('asset-000')
    expect(lastRendered.at(-1)).toBe('asset-499')
    expect(lastWindow.bottomSpacerHeight).toBe(0)
  })

  test('combines a 500-item collection with search, type, and status filters', () => {
    const items = Array.from({ length: 500 }, (_, index): MediaPoolItemModel => ({
      ...item(`asset-${String(index).padStart(3, '0')}`),
      kind: index % 2 === 0 ? 'video' : 'audio',
      statuses: new Set<MediaPoolStatus>([
        index % 4 === 0 ? 'offline' : 'ready',
      ]),
      searchText: `asset-${String(index).padStart(3, '0')} ${index % 2 === 0 ? 'video' : 'audio'}`,
    }))
    const collectionAssetIds = new Set(
      items.filter((_, index) => index % 5 === 0).map((candidate) => candidate.id),
    )

    const filtered = filterMediaPoolItems(items, {
      query: 'asset-0',
      kind: 'video',
      status: 'offline',
    }, collectionAssetIds)

    expect(filtered.map((candidate) => candidate.id)).toEqual([
      'asset-000',
      'asset-020',
      'asset-040',
      'asset-060',
      'asset-080',
    ])
    expect(planMediaPoolRows(filtered, 3).flatMap((row) => row.itemIds))
      .toEqual(filtered.map((candidate) => candidate.id))
  })

  test('keeps expanded diagnostics on isolated measured rows', () => {
    const rows = planMediaPoolRows([
      item('a'),
      item('b'),
      item('diagnostic', true),
      item('c'),
    ], 3)
    const measurements = new Map([[rows[1]!.key, 310]])
    const window = computeMediaPoolVirtualWindow(
      rows,
      measurements,
      100,
      400,
      0,
    )

    expect(rows.map((row) => row.itemIds)).toEqual([
      ['a', 'b'],
      ['diagnostic'],
      ['c'],
    ])
    expect(rows.map((row) => row.itemStartIndex)).toEqual([0, 2, 3])
    expect(window.rowHeights).toEqual([112, 310, 112])
    expect(window.totalHeight).toBe(558)
  })

  test('packs Ready videos into the selected grid instead of isolating every clip', () => {
    const mixed = Array.from({ length: 300 }, (_, index): MediaPoolItemModel => ({
      ...item(`mixed-${index}`),
      kind: index % 3 === 0 ? 'video' : 'audio',
    }))
    const mixedRows = planMediaPoolRows(mixed, 3)
    expect(mixedRows.some((row) => row.itemIds.length > 1)).toBe(true)
    expect(mixedRows.flatMap((row) => row.itemIds)).toEqual(mixed.map((candidate) => candidate.id))

    const videos = Array.from({ length: 500 }, (_, index): MediaPoolItemModel => ({
      ...item(`video-${index}`),
      kind: 'video',
    }))
    const videoRows = planMediaPoolRows(videos, 3)
    const window = computeMediaPoolVirtualWindow(videoRows, new Map(), 0, 640)

    expect(videoRows).toHaveLength(167)
    expect(videoRows[0]?.itemIds).toHaveLength(3)
    expect(
      videoRows
        .slice(window.renderStartRow, window.renderEndRow)
        .flatMap((row) => row.itemIds).length,
    ).toBeLessThan(40)
    expect(window.totalHeight).toBeLessThan(500 * 100)
    expect(window.totalHeight).toBeGreaterThan(160 * 100)
  })

  test('isolates exceptional or explicitly opened items in every view', () => {
    const rows = planMediaPoolRows([
      { ...item('ready-a'), kind: 'video' },
      { ...item('ready-b'), kind: 'video' },
      { ...item('offline'), kind: 'video', expanded: true },
      { ...item('ready-c'), kind: 'video' },
    ], 3, {
      viewMode: 'thumbnail',
      thumbnailSize: 'medium',
      expandedItemId: 'ready-c',
    })

    expect(rows.map((row) => row.itemIds)).toEqual([
      ['ready-a', 'ready-b'],
      ['offline'],
      ['ready-c'],
    ])
    expect(rows[1]?.estimatedHeight).toBe(230)
    expect(rows[2]?.key).toContain('full-width:ready-c')
  })

  test('derives thumbnail columns from panel width and tile size, and one column for lists', () => {
    expect(mediaPoolColumnCount(180, 'thumbnail', 'medium')).toBe(1)
    expect(mediaPoolColumnCount(340, 'thumbnail', 'medium')).toBe(2)
    expect(mediaPoolColumnCount(520, 'thumbnail', 'medium')).toBe(3)
    expect(mediaPoolColumnCount(520, 'thumbnail', 'small')).toBeGreaterThan(
      mediaPoolColumnCount(520, 'thumbnail', 'large'),
    )
    expect(mediaPoolColumnCount(520, 'details', 'large')).toBe(1)
    expect(mediaPoolColumnCount(520, 'compact-list', 'large')).toBe(1)
    expect(mediaPoolShowsThumbnails('thumbnail')).toBe(true)
    expect(mediaPoolShowsThumbnails('details')).toBe(true)
    expect(mediaPoolShowsThumbnails('compact-list')).toBe(false)
  })

  test('changes estimated height and row keys when view or size changes', () => {
    const items = [item('a'), item('b')]
    const thumbnail: MediaPoolRowLayout = {
      viewMode: 'thumbnail',
      thumbnailSize: 'medium',
      expandedItemId: null,
    }
    const compact: MediaPoolRowLayout = {
      viewMode: 'compact-list',
      thumbnailSize: 'large',
      expandedItemId: null,
    }
    const thumbnailRows = planMediaPoolRows(items, 3, thumbnail)
    const compactRows = planMediaPoolRows(items, 3, compact)

    expect(thumbnailRows[0]?.estimatedHeight).toBe(112)
    expect(compactRows[0]?.estimatedHeight).toBe(36)
    expect(thumbnailRows[0]?.key).not.toBe(compactRows[0]?.key)
  })

  test('copies catalog sort keys from descriptors without mutating source maps', () => {
    const beach = descriptor('beach', 'Beach Take 01.MP4', 'video')
    const late = {
      ...descriptor('late', 'clip10.mp4', 'audio'),
      size: 9_000,
      lastModified: 80,
      durationMicroseconds: 1_000_000,
    }
    const descriptors = new Map([
      [beach.id, beach],
      [late.id, late],
    ])
    const descriptorOrder = [...descriptors.keys()]

    const items = buildMediaPoolItems(descriptors, new Map(), new Map())

    expect(items.map((candidate) => ({
      id: candidate.id,
      catalogIndex: candidate.catalogIndex,
      durationMicroseconds: candidate.durationMicroseconds,
      lastModified: candidate.lastModified,
      size: candidate.size,
    }))).toEqual([
      {
        id: 'beach',
        catalogIndex: 0,
        durationMicroseconds: 4_000_000,
        lastModified: 1,
        size: 1_024,
      },
      {
        id: 'late',
        catalogIndex: 1,
        durationMicroseconds: 1_000_000,
        lastModified: 80,
        size: 9_000,
      },
    ])
    expect([...descriptors.keys()]).toEqual(descriptorOrder)
  })

  test('sorts by project order without mutating the filtered catalog array', () => {
    const items = [
      { ...item('first'), catalogIndex: 0 },
      { ...item('second'), catalogIndex: 1 },
      { ...item('third'), catalogIndex: 2 },
    ]
    const original = items.map((candidate) => candidate.id)

    expect(sortMediaPoolItems(items, 'project-order', 'ascending').map(
      (candidate) => candidate.id,
    )).toEqual(['first', 'second', 'third'])
    expect(sortMediaPoolItems(items, 'project-order', 'descending').map(
      (candidate) => candidate.id,
    )).toEqual(['third', 'second', 'first'])
    expect(items.map((candidate) => candidate.id)).toEqual(original)
  })

  test('sorts filenames naturally and case-insensitively', () => {
    const items = [
      { ...item('clip-10'), fileName: 'Clip 10.mp4', catalogIndex: 0 },
      { ...item('clip-2'), fileName: 'clip 2.mp4', catalogIndex: 1 },
      { ...item('clip-2b'), fileName: 'Clip 2B.mp4', catalogIndex: 2 },
    ]

    expect(sortMediaPoolItems(items, 'name', 'ascending').map(
      (candidate) => candidate.id,
    )).toEqual(['clip-2', 'clip-2b', 'clip-10'])
    expect(sortMediaPoolItems(items, 'name', 'descending').map(
      (candidate) => candidate.id,
    )).toEqual(['clip-10', 'clip-2b', 'clip-2'])
  })

  test('sorts known duration, modified, and size values before missing ones in both directions', () => {
    const items = [
      {
        ...item('missing'),
        catalogIndex: 0,
        durationMicroseconds: null,
        lastModified: null,
        size: null,
      },
      {
        ...item('short'),
        catalogIndex: 1,
        durationMicroseconds: 1_000_000,
        lastModified: 10,
        size: 100,
      },
      {
        ...item('long'),
        catalogIndex: 2,
        durationMicroseconds: 9_000_000,
        lastModified: 90,
        size: 900,
      },
    ]

    expect(sortMediaPoolItems(items, 'duration', 'ascending').map(
      (candidate) => candidate.id,
    )).toEqual(['short', 'long', 'missing'])
    expect(sortMediaPoolItems(items, 'duration', 'descending').map(
      (candidate) => candidate.id,
    )).toEqual(['long', 'short', 'missing'])
    expect(sortMediaPoolItems(items, 'last-modified', 'ascending').map(
      (candidate) => candidate.id,
    )).toEqual(['short', 'long', 'missing'])
    expect(sortMediaPoolItems(items, 'size', 'descending').map(
      (candidate) => candidate.id,
    )).toEqual(['long', 'short', 'missing'])
  })

  test('sorts media kinds by a stable video, audio, image, unknown rank', () => {
    const items = [
      { ...item('still'), kind: 'image' as const, catalogIndex: 0 },
      { ...item('voice'), kind: 'audio' as const, catalogIndex: 1 },
      { ...item('mystery'), kind: 'unknown' as const, catalogIndex: 2 },
      { ...item('camera'), kind: 'video' as const, catalogIndex: 3 },
    ]

    expect(sortMediaPoolItems(items, 'kind', 'ascending').map(
      (candidate) => candidate.id,
    )).toEqual(['camera', 'voice', 'still', 'mystery'])
    expect(sortMediaPoolItems(items, 'kind', 'descending').map(
      (candidate) => candidate.id,
    )).toEqual(['mystery', 'still', 'voice', 'camera'])
  })

  test('breaks remaining sort ties by catalog index then stable asset id', () => {
    const items = [
      {
        ...item('beta'),
        fileName: 'Same.mp4',
        catalogIndex: 4,
        durationMicroseconds: 2_000_000,
      },
      {
        ...item('alpha'),
        fileName: 'Same.mp4',
        catalogIndex: 4,
        durationMicroseconds: 2_000_000,
      },
      {
        ...item('early'),
        fileName: 'Same.mp4',
        catalogIndex: 1,
        durationMicroseconds: 2_000_000,
      },
    ]

    expect(sortMediaPoolItems(items, 'duration', 'descending').map(
      (candidate) => candidate.id,
    )).toEqual(['early', 'alpha', 'beta'])
    expect(sortMediaPoolItems(items, 'name', 'ascending').map(
      (candidate) => candidate.id,
    )).toEqual(['early', 'alpha', 'beta'])
  })
})
