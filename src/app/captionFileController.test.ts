import { describe, expect, it } from 'vitest'
import { CaptionFileController } from './captionFileController'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { createCaptionTrack } from '../domain/captions'
import type { TimelineDoc } from '../domain/schema'

function textFile(name: string, source: string): File {
  return {
    name,
    size: source.length,
    text: async () => source,
  } as File
}

function harness() {
  let doc = createTimelineDoc('Captions', DEFAULT_PROJECT_SETTINGS, 'doc') as TimelineDoc
  doc = { ...doc, captionTracks: [createCaptionTrack('track-1', 'English', 'en')] }
  let nextId = 0
  const downloads: Array<{ fileName: string; mimeType: string; content: string }> = []
  const controller = new CaptionFileController(
    {
      getDoc: () => doc,
      commitDoc: (expected, next) => {
        if (doc !== expected) return false
        doc = next
        return true
      },
    },
    {
      createId: (prefix) => `${prefix}-${++nextId}`,
      download: (fileName, mimeType, content) => downloads.push({ fileName, mimeType, content }),
    },
  )
  return {
    controller,
    downloads,
    getDoc: () => doc,
    replaceDoc: (next: TimelineDoc) => { doc = next },
  }
}

describe('CaptionFileController', () => {
  it('commits a fully parsed SRT as one document replacement', async () => {
    const test = harness()
    const before = test.getDoc()

    await expect(test.controller.importIntoTrack(
      textFile('captions.srt', '1\n00:00:00,000 --> 00:00:01,000\nHello\n'),
      'srt',
      'track-1',
    )).resolves.toBe(1)

    expect(test.getDoc()).not.toBe(before)
    expect(test.getDoc().captionTracks?.[0]?.items[0]?.text).toBe('Hello')
  })

  it('leaves the document byte-identical for malformed input', async () => {
    const test = harness()
    const before = test.getDoc()

    await expect(test.controller.importIntoTrack(
      textFile('bad.vtt', 'WEBVTT\n\n00:01.000 --> 00:00.000\nNope\n'),
      'vtt',
      'track-1',
    )).rejects.toThrow(/end must be after/u)

    expect(test.getDoc()).toBe(before)
  })

  it('rejects a stale async import instead of overwriting concurrent edits', async () => {
    const test = harness()
    let resolveText: (value: string) => void = () => undefined
    const file = {
      name: 'captions.srt',
      size: 100,
      text: () => new Promise<string>((resolve) => { resolveText = resolve }),
    } as File
    const pending = test.controller.importIntoTrack(file, 'srt', 'track-1')
    test.replaceDoc({ ...test.getDoc(), name: 'Changed' })
    resolveText('1\n00:00:00,000 --> 00:00:01,000\nHello\n')

    await expect(pending).rejects.toThrow(/project changed/u)
    expect(test.getDoc().name).toBe('Changed')
  })

  it('downloads validated SRT and VTT content with safe names', async () => {
    const test = harness()
    await test.controller.importIntoTrack(
      textFile('captions.srt', '1\n00:00:00,000 --> 00:00:01,000\nHello\n'),
      'srt',
      'track-1',
    )

    const content = test.controller.exportTrack('track-1', 'vtt')

    expect(content).toMatch(/^WEBVTT/u)
    expect(test.downloads).toEqual([expect.objectContaining({
      fileName: 'English.vtt',
      mimeType: 'text/vtt',
    })])
  })
})
