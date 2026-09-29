import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { TimelineDoc } from '../domain/schema'
import { createExportRenderSurfaces } from './export-render-surfaces'

const canvases: FakeCanvas[] = []
let contextAvailable = true

class FakeCanvas {
  width: number
  height: number
  getContext = vi.fn(() => (contextAvailable ? { canvas: this } : null))
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    canvases.push(this)
  }
}

function doc(): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'surfaces',
    name: 'surfaces',
    frameRate: { num: 30, den: 1 },
    width: 16,
    height: 9,
    audioSampleRate: 48_000,
    tracks: [],
  }
}

afterEach(() => {
  canvases.length = 0
  contextAvailable = true
  vi.unstubAllGlobals()
})

describe('export render surfaces', () => {
  test.each([false, true])('creates sRGB surfaces with alpha=%s and releases them once', (alpha) => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas)
    const surfaces = createExportRenderSurfaces(doc(), { alpha, label: 'export' })
    const alphaSettings = alpha ? { alpha: true } : {}
    expect(canvases[0]!.getContext).toHaveBeenCalledWith('2d', {
      colorSpace: 'srgb',
      ...alphaSettings,
    })
    expect(surfaces.lensRemapProvider).toBeNull()
    const transition = surfaces.transitionSurfaceProvider.get()
    expect(surfaces.transitionSurfaceProvider.get()).toBe(transition)
    expect(canvases).toHaveLength(3)
    for (const scratch of canvases.slice(1)) {
      expect(scratch.getContext).toHaveBeenCalledWith('2d', {
        colorSpace: 'srgb',
        willReadFrequently: true,
        ...alphaSettings,
      })
    }

    surfaces.release()
    expect(canvases.map((canvas) => [canvas.width, canvas.height]))
      .toEqual([[1, 1], [1, 1], [1, 1]])
    canvases[0]!.width = 16
    surfaces.release()
    expect(canvases[0]!.width).toBe(16)
  })

  test('names the owning sink when a context cannot be created', () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas)
    contextAvailable = false
    expect(() => createExportRenderSurfaces(doc(), {
      alpha: true,
      label: 'image-sequence',
    })).toThrow('Could not create the image-sequence 2D context')
    expect(canvases[0]).toMatchObject({ width: 1, height: 1 })
  })

  test('requires OffscreenCanvas', () => {
    vi.stubGlobal('OffscreenCanvas', undefined)
    expect(() => createExportRenderSurfaces(doc(), { alpha: false, label: 'export' }))
      .toThrow(/OffscreenCanvas is not supported/)
  })
})
