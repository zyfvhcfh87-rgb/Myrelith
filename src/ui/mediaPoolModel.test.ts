import { describe, expect, test } from 'vitest'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { MediaAsset } from '../domain/schema'
import {
  buildMediaPoolItems,
  computeMediaPoolVirtualWindow,
  filterMediaPoolItems,
  planMediaPoolRows,
  type MediaPoolItemModel,
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

  test('isolates every proxy-enabled video card in large mixed and video-only pools', () => {
    const mixed = Array.from({ length: 300 }, (_, index): MediaPoolItemModel => ({
      ...item(`mixed-${index}`),
      kind: index % 3 === 0 ? 'video' : 'audio',
    }))
    const mixedRows = planMediaPoolRows(mixed, 3)
    for (const row of mixedRows) {
      if (row.itemIds.some((id) => mixed.find((candidate) => candidate.id === id)?.kind === 'video')) {
        expect(row.itemIds).toHaveLength(1)
      }
    }
    expect(mixedRows.flatMap((row) => row.itemIds)).toEqual(mixed.map((candidate) => candidate.id))

    const videos = Array.from({ length: 500 }, (_, index): MediaPoolItemModel => ({
      ...item(`video-${index}`),
      kind: 'video',
    }))
    const videoRows = planMediaPoolRows(videos, 3)
    const window = computeMediaPoolVirtualWindow(videoRows, new Map(), 0, 640)

    expect(videoRows).toHaveLength(500)
    expect(videoRows.every((row) => row.itemIds.length === 1)).toBe(true)
    expect(window.totalHeight).toBeGreaterThan(500 * 100)
  })
})
