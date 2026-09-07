// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createColorLutController } from './colorLutController'
import type { ColorLutImportReply, ColorLutImportRequest } from '../domain/colorLutImport'
import { parseCube, portableColorLut } from '../domain/colorLut'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useColorLutImportStore } from '../state/colorLutImportStore'
import { useMediaStore } from '../state/mediaStore'

class FakeWorker {
  onmessage: ((event: MessageEvent<ColorLutImportReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  request: ColorLutImportRequest | null = null
  terminated = 0
  postMessage(request: ColorLutImportRequest) { this.request = request }
  terminate() { this.terminated++ }
  ready() { this.onmessage?.({ data: { table: portableColorLut(this.request!.id, 'Local', parseCube('LUT_1D_SIZE 2\n0 0 0\n1 1 1')) } } as MessageEvent<ColorLutImportReply>) }
}
let workers: FakeWorker[] = []
let controller: ReturnType<typeof createColorLutController>
let dispose: () => void
const target = { kind: 'master', sequenceId: 'root' } as const
const file = () => new File(['local'], 'look.cube')
beforeEach(() => {
  vi.useFakeTimers(); workers = []
  useDocumentStore.getState().setProject(sequenceProjectFromTimeline(createTimelineDoc('Grade', DEFAULT_PROJECT_SETTINGS, 'root')))
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  useTransportStore.setState({ selectedClipIds: [] })
  controller = createColorLutController(() => { const worker = new FakeWorker(); workers.push(worker); return worker })
  dispose = controller.init()
})
afterEach(() => { dispose(); vi.useRealTimers() })
test('one worker, bounded summary, no mutation before Apply and one undoable commit afterwards', () => {
  const original = useDocumentStore.getState().project
  controller.begin(file(), target); workers[0].ready()
  expect(workers[0].terminated).toBe(1)
  expect(useColorLutImportStore.getState().phase).toBe('ready')
  expect(useDocumentStore.getState().project).toBe(original)
  expect(controller.apply()).toBeNull()
  expect(useDocumentStore.getState().past).toEqual([original])
  expect(useDocumentStore.getState().project.colorLuts).toHaveLength(1)
  expect(controller.apply()).toMatch(/no longer current/)
})
test.each(['deadline', 'cancel', 'replacement', 'selection', 'project'] as const)('%s releases before any late result can mutate state', (action) => {
  controller.begin(file(), target)
  if (action === 'deadline') vi.advanceTimersByTime(5000)
  if (action === 'cancel') controller.cancel()
  if (action === 'replacement') controller.begin(file(), target)
  if (action === 'selection') useTransportStore.setState({ selectedClipIds: ['other'] })
  if (action === 'project') useDocumentStore.getState().setProject(sequenceProjectFromTimeline(createTimelineDoc('New', DEFAULT_PROJECT_SETTINGS, 'new')))
  expect(workers[0].terminated).toBe(1)
  workers[0].ready()
  expect(useDocumentStore.getState().past).toEqual([])
  expect(useDocumentStore.getState().project.colorLuts).toEqual([])
  if (action === 'replacement') expect(useColorLutImportStore.getState().phase).toBe('reading')
  else expect(useColorLutImportStore.getState().phase).not.toBe('ready')
})
test('worker errors, malformed results and oversize files leave redo unchanged', () => {
  const original = useDocumentStore.getState().project
  useDocumentStore.setState({ future: [original] })
  controller.begin(file(), target)
  workers[0].onmessage?.({ data: { error: 'Unknown LUT header.' } } as MessageEvent<ColorLutImportReply>)
  expect(workers[0].terminated).toBe(1)
  expect(useColorLutImportStore.getState().detail).toMatch(/Unknown/)
  const oversized = file(); Object.defineProperty(oversized, 'size', { value: 4 * 1024 * 1024 + 1 })
  controller.begin(oversized, target)
  expect(workers).toHaveLength(1)
  expect(useDocumentStore.getState().future).toEqual([original])
})
