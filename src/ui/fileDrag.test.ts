import { afterEach, describe, expect, test } from 'vitest'
import {
  extractDroppedFiles,
  FILES_DRAG_TYPE,
  isEditorFileDropTarget,
  isFileDrag,
} from './fileDrag'
import { ASSET_DRAG_TYPE, assetKindDragType } from './dnd'

function file(name: string, type = 'video/mp4'): File {
  return new File(['payload'], name, { type })
}

describe('isFileDrag', () => {
  test('detects file items without treating Myrelith asset drags as files', () => {
    expect(isFileDrag({
      items: [{ kind: 'file', type: 'video/mp4' }],
      types: [FILES_DRAG_TYPE],
    })).toBe(true)
    expect(isFileDrag({
      types: [FILES_DRAG_TYPE],
    })).toBe(true)
    expect(isFileDrag({
      items: [{ kind: 'string', type: 'text/uri-list' }],
      types: ['text/uri-list'],
    })).toBe(false)
    expect(isFileDrag({
      types: [ASSET_DRAG_TYPE, assetKindDragType('video')],
    })).toBe(false)
    expect(isFileDrag(null)).toBe(false)
  })
})

describe('extractDroppedFiles', () => {
  test('copies files in source order and skips directories', () => {
    const video = file('a.mp4')
    const image = file('b.png', 'image/png')
    expect(extractDroppedFiles({
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => file('ignore.txt', 'text/plain') },
        { kind: 'file', type: video.type, getAsFile: () => video },
        {
          kind: 'file',
          type: '',
          getAsFile: () => file('folder'),
          webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }),
        },
        { kind: 'file', type: image.type, getAsFile: () => image },
      ],
    })).toEqual([video, image])
  })

  test('falls back to files when items are unavailable', () => {
    const only = file('voice.wav', 'audio/wav')
    expect(extractDroppedFiles({ files: [only], types: [FILES_DRAG_TYPE] }))
      .toEqual([only])
    expect(extractDroppedFiles(null)).toEqual([])
  })
})

describe('isEditorFileDropTarget', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('accepts the Media Pool and unlocked lanes only', () => {
    document.body.innerHTML = `
      <div class="media-pool"><span id="pool-child">Media</span></div>
      <div class="timeline-track" data-track-locked="false"><span id="open-lane"></span></div>
      <div class="timeline-track track-locked" data-track-locked="true"><span id="locked-lane"></span></div>
      <div class="area-preview" id="preview"></div>
    `
    expect(isEditorFileDropTarget(document.getElementById('pool-child'))).toBe(true)
    expect(isEditorFileDropTarget(document.getElementById('open-lane'))).toBe(true)
    expect(isEditorFileDropTarget(document.getElementById('locked-lane'))).toBe(false)
    expect(isEditorFileDropTarget(document.getElementById('preview'))).toBe(false)
    expect(isEditorFileDropTarget(null)).toBe(false)
  })
})
