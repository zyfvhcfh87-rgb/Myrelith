import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectSavedCaptionAppearance } from './captionAppearance'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { captionIntentProject } from '../test/captionIntentFixtures'
import { resolveCaptionPaint } from '../domain/captionPaint'
import { textCanvasFont } from '../domain/textLayout'

beforeEach(() => {
  useDocumentStore.setState({ retainedCaptionOwners: {} })
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  useDocumentStore.getState().setProject(captionIntentProject())
})
afterEach(() => vi.restoreAllMocks())

it('measures saved text with the shared painter font and reports clipping and opaque contrast', () => {
  const project = structuredClone(captionIntentProject())
  const track = project.sequences[0]!.captionTracks![0]!
  track.style = { version: 1, params: { backgroundEnabled: true, backgroundColor: '#000000ff', color: '#ffffffff', fontFamily: 'serif', italic: true } }
  track.items[0]!.text = 'A\n'.repeat(100) + 'A'
  useDocumentStore.getState().setProject(project)
  const context = { font: '', measureText: (text: string) => ({ width: text.length * 10 }) }
  let canvas: HTMLCanvasElement | null = null
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvas = this
    return context as unknown as CanvasRenderingContext2D
  })
  const result = inspectSavedCaptionAppearance('captions', 'cue-a').join(' ')
  expect(result).toMatch(/contrast 21.00:1/)
  expect(result).toMatch(/Possible clipping: too many lines/)
  expect(context.font).toBe(textCanvasFont(resolveCaptionPaint(project.sequences[0]!, track, track.items[0]!, 0, 1).paint.text))
  expect(canvas).toMatchObject({ width: 0, height: 0 })
})

it('does not measure unsupported appearance or pretend changing video contrast is known', () => {
  const context = { font: '', measureText: () => ({ width: 10 }) }
  const measure = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  expect(inspectSavedCaptionAppearance('captions', 'cue-a').join(' ')).toMatch(/changing video.*unmeasured/)
  measure.mockClear()
  useDocumentStore.getState().switchSequence('dormant')
  expect(inspectSavedCaptionAppearance('dormant-captions', 'dormant-cue').join(' ')).toMatch(/unavailable style/)
  expect(measure).not.toHaveBeenCalled()
})

it('releases the temporary canvas when measurement fails', () => {
  let canvas: HTMLCanvasElement | null = null
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvas = this
    return { font: '', measureText: () => { throw new Error('measurement failed') } } as unknown as CanvasRenderingContext2D
  })
  expect(inspectSavedCaptionAppearance('captions', 'cue-a').join(' ')).toMatch(/measurement is unavailable/)
  expect(canvas).toMatchObject({ width: 0, height: 0 })
})
