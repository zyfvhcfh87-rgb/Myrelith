import { describe, expect, test } from 'vitest'
import { CURRENT_TIMELINE_SCHEMA_VERSION } from './projectFile'
import type { SequenceProject } from './projectSequences'
import {
  COLLECT_MEDIA_INCOMPLETE_MARKER,
  COLLECT_MEDIA_MANIFEST_FILE,
  assertCollectedRelativePath,
  assignCollectedRelativePath,
  collectArchiveDestinationKind,
  collectArchiveIsComplete,
  collectMediaPathSegments,
  isSafeCollectPathSegment,
  manifestItemFromPreflight,
  parseCollectMediaManifest,
  planCollectMediaPreflight,
  referencedFontFacts,
  sanitizeCollectFileName,
  serializeCollectMediaManifest,
  type CollectMediaManifest,
  type CollectMediaSourceFact,
} from './collectMedia'

function assetFact(
  id: string,
  fileName: string,
  available = true,
): CollectMediaSourceFact {
  return {
    id,
    kind: 'asset',
    displayName: fileName,
    originalFileName: fileName,
    size: 1024,
    lastModified: 1_700_000_000_000,
    mimeType: 'video/mp4',
    available,
    referenced: true,
  }
}

function validManifest(
  overrides: Partial<CollectMediaManifest> = {},
): CollectMediaManifest {
  return {
    format: 'myrelith-collect-media',
    formatVersion: 1,
    status: 'complete',
    createdAt: 1_700_000_000_000,
    projectFileName: 'Edit.myrelith',
    inclusionPolicy: { includeProxies: false, includeTitleTemplates: false },
    items: [{
      id: 'asset-1',
      kind: 'asset',
      disposition: 'included',
      originalFileName: 'clip.mp4',
      collectedRelativePath: 'media/clip.mp4',
      size: 12,
      lastModified: 1,
      mimeType: 'video/mp4',
      fingerprint: {
        algorithm: 'sha256-sampled-v1',
        digest: 'a'.repeat(64),
      },
      reason: 'Original source will be copied into the archive.',
      error: null,
    }],
    errors: [],
    ...overrides,
  }
}

describe('collect-media path safety', () => {
  test('rejects traversal, separators, reserved names, and control characters', () => {
    expect(isSafeCollectPathSegment('clip.mp4')).toBe(true)
    expect(isSafeCollectPathSegment('..')).toBe(false)
    expect(isSafeCollectPathSegment('.')).toBe(false)
    expect(isSafeCollectPathSegment('a/b')).toBe(false)
    expect(isSafeCollectPathSegment('a\\b')).toBe(false)
    expect(isSafeCollectPathSegment('CON')).toBe(false)
    expect(isSafeCollectPathSegment('clip.mp4.')).toBe(false)
    expect(isSafeCollectPathSegment('clip\n.mp4')).toBe(false)
  })

  test('sanitizes hostile names into a single archive segment', () => {
    expect(sanitizeCollectFileName('../secret.mp4')).toBe('secret.mp4')
    expect(sanitizeCollectFileName('CON.mp4')).toBe('media.mp4')
    expect(isSafeCollectPathSegment(sanitizeCollectFileName('My Clip?.mov'))).toBe(true)
  })

  test('assigns case-insensitive collision-safe paths without escaping the folder', () => {
    const used = new Set<string>()
    const first = assignCollectedRelativePath('Clip.mp4', 'asset-aaaa', 'media', used)
    const second = assignCollectedRelativePath('clip.mp4', 'asset-bbbb', 'media', used)
    const third = assignCollectedRelativePath('clip.mp4', 'asset-cccc', 'media', used)
    expect(first).toBe('media/Clip.mp4')
    expect(second).toBe('media/clip-bbbb.mp4')
    expect(third.startsWith('media/')).toBe(true)
    expect(third.toLowerCase()).not.toBe(first.toLowerCase())
    expect(third.toLowerCase()).not.toBe(second.toLowerCase())
    for (const path of [first, second, third]) {
      expect(collectMediaPathSegments(path)).toHaveLength(2)
    }
  })

  test('rejects paths that would escape the destination', () => {
    expect(() => collectMediaPathSegments('../media/clip.mp4')).toThrow(/relative POSIX/)
    expect(() => collectMediaPathSegments('/media/clip.mp4')).toThrow(/relative POSIX/)
    expect(() => collectMediaPathSegments('media/../clip.mp4')).toThrow(/relative POSIX/)
    expect(() => collectMediaPathSegments('other/clip.mp4')).toThrow(/collect-media directory/)
    expect(() => assertCollectedRelativePath('media/clip.mp4')).not.toThrow()
  })
})

describe('collect-media preflight', () => {
  test('classifies included, excluded, offline, and unresolved items before copy', () => {
    const preflight = planCollectMediaPreflight([
      assetFact('online', 'A.mp4', true),
      assetFact('offline', 'B.mp4', false),
      {
        id: 'proxy-online',
        kind: 'proxy',
        displayName: 'A proxy',
        originalFileName: 'proxy.mp4',
        size: 10,
        lastModified: 2,
        mimeType: 'video/mp4',
        available: true,
        referenced: true,
      },
      {
        id: 'font:sans-serif',
        kind: 'font',
        displayName: 'sans-serif',
        originalFileName: null,
        size: null,
        lastModified: null,
        mimeType: null,
        available: true,
        referenced: true,
      },
      {
        id: 'font:Comic Neue',
        kind: 'font',
        displayName: 'Comic Neue',
        originalFileName: null,
        size: null,
        lastModified: null,
        mimeType: null,
        available: false,
        referenced: true,
      },
    ], { includeProxies: false, includeTitleTemplates: false })

    expect(preflight.includedCount).toBe(1)
    expect(preflight.offlineCount).toBe(1)
    expect(preflight.excludedCount).toBe(2)
    expect(preflight.unresolvedCount).toBe(1)
    expect(preflight.items.find((item) => item.id === 'online')?.plannedRelativePath)
      .toBe('media/A.mp4')
    expect(preflight.items.find((item) => item.id === 'proxy-online')?.disposition)
      .toBe('excluded')
    expect(preflight.items.find((item) => item.id === 'font:Comic Neue')?.disposition)
      .toBe('unresolved')
  })

  test('includes proxies and templates only when the policy asks for them', () => {
    const facts: CollectMediaSourceFact[] = [
      {
        id: 'proxy-1',
        kind: 'proxy',
        displayName: 'proxy',
        originalFileName: 'cache.mp4',
        size: 8,
        lastModified: 3,
        mimeType: 'video/mp4',
        available: true,
        referenced: true,
      },
      {
        id: 'template-1',
        kind: 'template',
        displayName: 'Lower third',
        originalFileName: 'Lower third.json',
        size: 40,
        lastModified: null,
        mimeType: 'application/json',
        available: true,
        referenced: false,
      },
    ]
    const omitted = planCollectMediaPreflight(facts, {
      includeProxies: false,
      includeTitleTemplates: false,
    })
    const included = planCollectMediaPreflight(facts, {
      includeProxies: true,
      includeTitleTemplates: true,
    })
    expect(omitted.includedCount).toBe(0)
    expect(included.includedCount).toBe(2)
    expect(included.items[0]?.plannedRelativePath).toBe('proxies/cache.mp4')
    expect(included.items[1]?.plannedRelativePath?.startsWith('templates/')).toBe(true)
  })

  test('lists referenced generic and named fonts from titles and captions', () => {
    const project: SequenceProject = {
      id: 'doc',
      name: 'Fonts',
      rootSequenceId: 'seq',
      sequences: [{
        schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
        id: 'seq',
        name: 'Seq',
        frameRate: { num: 30, den: 1 },
        width: 1920,
        height: 1080,
        audioSampleRate: 48000,
        tracks: [{
          id: 'V1',
          kind: 'video',
          name: 'V1',
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
          clips: [{
            id: 'title',
            assetId: '__myrelith_text__:title',
            name: 'Title',
            sourceMode: 'timed',
            sourceRange: { startFrame: 0, durationFrames: 30 },
            timelineRange: { startFrame: 0, durationFrames: 30 },
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
            opacity: 1,
            volume: 1,
            effects: [],
            title: {
              version: 1,
              elements: [{
                id: 'el',
                version: 1,
                kind: 'text',
                name: 'Text',
                enabled: true,
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
                visual: {
                  crop: { top: 0, right: 0, bottom: 0, left: 0 },
                  flipHorizontal: false,
                  flipVertical: false,
                  scaleLocked: true,
                },
                opacity: 1,
                text: {
                  content: 'Hi',
                  fontSizePx: 24,
                  color: '#ffffffff',
                  align: 'center',
                  bold: false,
                  italic: false,
                  boxWidthPx: 200,
                  boxHeightPx: 80,
                  paddingPx: 8,
                  backgroundEnabled: false,
                  backgroundColor: '#00000000',
                  outlineEnabled: false,
                  outlineColor: '#000000ff',
                  outlineWidthPx: 0,
                  shadowEnabled: false,
                  shadowColor: '#00000000',
                  shadowBlurPx: 0,
                  shadowOffsetXPx: 0,
                  shadowOffsetYPx: 0,
                },
                font: { family: 'Unknown Display', fallbackFamily: 'sans-serif' },
              }],
            },
          }],
          transitions: [],
        }],
        markers: [],
        captionTracks: [{
          id: 'caps',
          name: 'Caps',
          language: 'en',
          role: 'subtitles',
          stylePreset: 'classic',
          hidden: false,
          items: [],
          style: { version: 1, params: { fontFamily: 'serif' } },
        }],
      }],
    }
    const fonts = referencedFontFacts(project)
    expect(fonts.map((fact) => fact.displayName).sort()).toEqual([
      'Unknown Display',
      'serif',
    ])
  })
})

describe('collect-media manifest', () => {
  test('round-trips a valid complete manifest and rejects unknown fields', () => {
    const serialized = serializeCollectMediaManifest(validManifest())
    expect(parseCollectMediaManifest(JSON.parse(serialized)).status).toBe('complete')
    expect(() => parseCollectMediaManifest({
      ...validManifest(),
      extra: true,
    })).toThrow(/unknown field/)
  })

  test('never treats a marked or errored archive as complete', () => {
    const complete = parseCollectMediaManifest(validManifest())
    expect(collectArchiveIsComplete(complete, false)).toBe(true)
    expect(collectArchiveIsComplete(complete, true)).toBe(false)
    const partial = parseCollectMediaManifest(validManifest({
      status: 'partial',
      errors: ['The copy was cancelled.'],
    }))
    expect(collectArchiveIsComplete(partial, false)).toBe(false)
  })

  test('classifies destination folders deterministically', () => {
    expect(collectArchiveDestinationKind([], null, false)).toBe('empty')
    expect(collectArchiveDestinationKind(
      [COLLECT_MEDIA_INCOMPLETE_MARKER, COLLECT_MEDIA_MANIFEST_FILE, 'media'],
      'partial',
      true,
    )).toBe('incomplete')
    expect(collectArchiveDestinationKind(
      [COLLECT_MEDIA_MANIFEST_FILE, 'Edit.myrelith', 'media'],
      'complete',
      false,
    )).toBe('complete')
    expect(collectArchiveDestinationKind(['photos'], null, false)).toBe('occupied')
    expect(collectArchiveDestinationKind(['.DS_Store', 'Thumbs.db'], null, false))
      .toBe('empty')
    expect(collectArchiveDestinationKind(
      ['.DS_Store', COLLECT_MEDIA_INCOMPLETE_MARKER, 'media'],
      'partial',
      true,
    )).toBe('incomplete')
    expect(collectArchiveDestinationKind(['.DS_Store', 'photos'], null, false))
      .toBe('occupied')
  })

  test('omitted preflight rows cannot keep a collected path', () => {
    const item = manifestItemFromPreflight({
      id: 'offline',
      kind: 'asset',
      disposition: 'offline',
      reason: 'offline',
      originalFileName: 'gone.mp4',
      plannedRelativePath: 'media/gone.mp4',
      size: 1,
      lastModified: 1,
      mimeType: 'video/mp4',
    })
    expect(item.collectedRelativePath).toBeNull()
    expect(() => parseCollectMediaManifest(validManifest({
      items: [{ ...item, collectedRelativePath: 'media/gone.mp4' }],
    }))).toThrow(/cannot claim/)
  })
})
