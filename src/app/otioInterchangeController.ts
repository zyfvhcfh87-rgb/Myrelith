/**
 * app/otioInterchangeController.ts — staged OTIO JSON import/export.
 *
 * Domain planning stays pure. This composition root owns the file picker,
 * one undoable sequence append, offline descriptor attach, and downloads.
 * UI may import this module; it never reaches pipeline/ or workers/.
 */

import {
  planOtioImport,
  serializeOtioExport,
  type OtioExportResult,
  type OtioIdFactory,
  type OtioImportPlan,
  type OtioImportPreview,
} from '../domain/otioInterchange'
import {
  createProjectFileSnapshot,
  serializeProjectFile,
} from '../domain/projectFile'
import {
  appendProjectSequences,
  rootSequence,
  sequenceProjectReservedIds,
  type SequenceIdFactory,
} from '../domain/projectSequences'
import type { ProjectSettings } from '../domain/projectSettings'
import type { TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'

export type OtioInterchangePhase =
  | 'idle'
  | 'preview'
  | 'committing'
  | 'export-preview'
  | 'exporting'
  | 'error'

export interface OtioInterchangeSnapshot {
  readonly phase: OtioInterchangePhase
  readonly error: string | null
  readonly importPreview: OtioImportPreview | null
  readonly exportPreview: OtioImportPreview | null
}

export type OtioDownloadHandler = (
  fileName: string,
  mediaType: string,
  content: string,
) => void

type Listener = () => void

let phase: OtioInterchangePhase = 'idle'
let error: string | null = null
let heldPlan: OtioImportPlan | null = null
let heldExport: OtioExportResult | null = null
let importPreview: OtioImportPreview | null = null
let exportPreview: OtioImportPreview | null = null
let boundGeneration = 0
let downloadHandler: OtioDownloadHandler = defaultDownloadOtio
const listeners = new Set<Listener>()
let stopWatching: (() => void) | null = null
let currentSnapshot: OtioInterchangeSnapshot = {
  phase: 'idle',
  error: null,
  importPreview: null,
  exportPreview: null,
}

function snapshot(): OtioInterchangeSnapshot {
  return currentSnapshot
}

function emit(): void {
  currentSnapshot = { phase, error, importPreview, exportPreview }
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  ensureProjectWatch()
  return () => {
    listeners.delete(listener)
  }
}

function settingsOf(document: TimelineDoc): ProjectSettings {
  return {
    width: document.width,
    height: document.height,
    frameRate: { num: document.frameRate.num, den: document.frameRate.den },
    audioSampleRate: document.audioSampleRate,
  }
}

function uniqueId(kind: string, reserved: Set<string>): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = `${kind}_${crypto.randomUUID()}`
    if (!reserved.has(id)) {
      reserved.add(id)
      return id
    }
  }
  throw new Error('Could not allocate a unique OTIO identity.')
}

function reservedIdsForImport(): Set<string> {
  const reserved = new Set(sequenceProjectReservedIds(useDocumentStore.getState().project))
  for (const id of useMediaStore.getState().descriptors.keys()) reserved.add(id)
  for (const id of useMediaStore.getState().assets.keys()) reserved.add(id)
  return reserved
}

function otioFactory(reserved: Set<string>): OtioIdFactory {
  return (kind) => uniqueId(kind, reserved)
}

function sequenceFactory(reserved: Set<string>): SequenceIdFactory {
  return (kind) => uniqueId(kind, reserved)
}

function appendFailureMessage(failure: string): string {
  if (failure === 'sequence-limit') {
    return 'The project already has the maximum number of sequences.'
  }
  if (failure === 'project-budget') {
    return 'The imported timeline does not fit this project’s canvas, frame rate, or size budget.'
  }
  if (failure === 'id-generation-failed') {
    return 'Could not allocate unique ids for the imported timeline.'
  }
  return 'The OTIO file could not be added to this project.'
}

function defaultDownloadOtio(
  fileName: string,
  mediaType: string,
  content: string,
): void {
  const blob = new Blob([content], { type: mediaType })
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

function resetHeld(): void {
  heldPlan = null
  heldExport = null
  importPreview = null
  exportPreview = null
}

function setIdle(): void {
  phase = 'idle'
  error = null
  resetHeld()
  emit()
}

function fail(message: string): void {
  phase = 'error'
  error = message
  resetHeld()
  emit()
}

function ensureProjectWatch(): void {
  if (stopWatching) return
  stopWatching = useDocumentStore.subscribe((next) => {
    if (phase !== 'preview') return
    if (next.projectGeneration !== boundGeneration) {
      fail('The project changed while the OTIO import was staged. Choose the file again.')
    }
  })
}

export function getOtioInterchangeSnapshot(): OtioInterchangeSnapshot {
  return snapshot()
}

export function subscribeOtioInterchange(listener: Listener): () => void {
  return subscribe(listener)
}

export function cancelOtioInterchange(): void {
  setIdle()
}

export async function stageOtioImport(file: File): Promise<void> {
  ensureProjectWatch()
  if (file.name.toLowerCase().endsWith('.otioz')) {
    fail('OTIO packages (.otioz) are not supported. Export JSON (.otio) instead.')
    return
  }
  const document = useDocumentStore.getState()
  boundGeneration = document.projectGeneration
  let text: string
  try {
    text = await file.text()
  } catch (caught) {
    fail(caught instanceof Error ? caught.message : 'Could not read the OTIO file.')
    return
  }
  try {
    const plan = planOtioImport(
      text,
      settingsOf(rootSequence(document.project)),
      otioFactory(reservedIdsForImport()),
    )
    heldPlan = plan
    heldExport = null
    importPreview = plan.preview
    exportPreview = null
    phase = 'preview'
    error = null
    emit()
  } catch (caught) {
    fail(caught instanceof Error ? caught.message : 'Could not parse the OTIO file.')
  }
}

export function commitOtioImport(): void {
  if (heldPlan === null || phase !== 'preview') {
    fail('No OTIO import is staged.')
    return
  }
  const document = useDocumentStore.getState()
  if (document.projectGeneration !== boundGeneration) {
    fail('The project changed while the OTIO import was staged. Choose the file again.')
    return
  }
  const plan = heldPlan
  const expected = document.project
  const generation = document.projectGeneration
  const addedIds = plan.descriptors.map((descriptor) => descriptor.id)
  phase = 'committing'
  error = null
  emit()
  try {
    const appended = appendProjectSequences(
      expected,
      plan.sequences,
      sequenceFactory(reservedIdsForImport()),
    )
    if (appended.failure !== null) {
      fail(appendFailureMessage(appended.failure))
      return
    }
    const mediaState = useMediaStore.getState()
    const existingIds = new Set(mediaState.descriptors.keys())
    const newDescriptors = plan.descriptors.filter(
      (descriptor) => !existingIds.has(descriptor.id),
    )
    const mergedDescriptors = [...mediaState.descriptors.values(), ...newDescriptors]
    serializeProjectFile(
      createProjectFileSnapshot(appended.project, mergedDescriptors, mediaState.collections),
    )
    if (newDescriptors.length > 0) {
      mediaState.addOfflineDescriptors(newDescriptors)
    }
    const commitError = useDocumentStore.getState().commitProjectEdit(
      expected,
      generation,
      appended.project,
    )
    if (commitError) {
      for (const id of addedIds) useMediaStore.getState().removeAsset(id)
      fail(commitError)
      return
    }
    if (appended.sequenceId) {
      useDocumentStore.getState().switchSequence(appended.sequenceId)
    }
    setIdle()
  } catch (caught) {
    for (const id of addedIds) useMediaStore.getState().removeAsset(id)
    fail(caught instanceof Error ? caught.message : 'Could not import OTIO.')
  }
}

export function stageOtioExport(): void {
  ensureProjectWatch()
  const document = useDocumentStore.getState()
  const descriptors = [...useMediaStore.getState().descriptors.values()]
  try {
    const result = serializeOtioExport(document.project, descriptors)
    heldPlan = null
    heldExport = result
    importPreview = null
    exportPreview = result.preview
    phase = 'export-preview'
    error = null
    emit()
  } catch (caught) {
    fail(caught instanceof Error ? caught.message : 'Could not export OTIO.')
  }
}

export function downloadStagedOtioExport(): void {
  if (heldExport === null || phase !== 'export-preview') {
    fail('No OTIO export is staged.')
    return
  }
  const staged = heldExport
  phase = 'exporting'
  error = null
  emit()
  try {
    downloadHandler(staged.fileName, staged.mediaType, staged.content)
    setIdle()
  } catch (caught) {
    fail(caught instanceof Error ? caught.message : 'Could not download OTIO.')
  }
}

export function setOtioDownloadHandlerForTests(handler: OtioDownloadHandler | null): void {
  downloadHandler = handler ?? defaultDownloadOtio
}

export function resetOtioInterchangeForTests(): void {
  downloadHandler = defaultDownloadOtio
  boundGeneration = 0
  setIdle()
}
