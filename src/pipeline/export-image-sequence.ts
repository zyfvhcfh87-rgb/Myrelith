/**
 * PNG image-sequence sink. Writes the exact selected integer-frame range with
 * zero-padded names. Cancellation and quota leave any already-written files and
 * report partial completion instead of inventing a finished archive.
 */

import { hasVideoBusEffects, videoBusRenderBudgetError } from '../domain/videoBusStage'
import type { ExportRange } from '../domain/exportRange'
import { validateExportRange } from '../domain/exportRange'
import type { TimelineDoc } from '../domain/schema'
import type { SequenceProject } from '../domain/projectSequences'
import { projectReachableSequences } from '../domain/selectors'
import {
  imageSequenceFileName,
  imageSequencePadWidth,
  validateDeliveryProfile,
  type ImageSequenceProfile,
} from '../domain/deliveryProduct'
import {
  createAlternativeBufferedExportResult,
  createDirectoryExportResult,
  type ExportResult,
  type ExportVideoSink,
} from './export'
import type { Composite2D, TransitionSurfaces } from './render'
import {
  createDocumentLensRemapProvider,
  documentHasSupportedLensCorrection,
  documentHasUnsupportedLensCorrection,
  WebGl2LensRemapBackend,
} from './lensRemapWebgl'
import { LensRemapUnavailableError } from './lensRemap'
import { zipStore, type ZipStoreEntry } from './zipStore'

export interface ImageSequenceDirectoryTarget {
  readonly directoryName: string
  exists(name: string): Promise<boolean>
  write(name: string, bytes: Uint8Array): Promise<void>
}

export interface ImageSequenceSinkOptions {
  readonly sidecarName?: string
  readonly sidecarBytes?: Uint8Array
  readonly convertPng?: (canvas: OffscreenCanvas) => Promise<Uint8Array>
  readonly projectTarget?: Readonly<{
    project: SequenceProject
    sequenceId: string
  }>
}

function isQuotaError(cause: unknown): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'name' in cause
    && (cause.name === 'QuotaExceededError' || cause.name === 'NS_ERROR_DOM_QUOTA_REACHED')
}

async function defaultConvertPng(canvas: OffscreenCanvas): Promise<Uint8Array> {
  if (typeof canvas.convertToBlob !== 'function') {
    throw new Error('This browser cannot encode PNG frames from the export canvas')
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

export async function createImageSequenceSink(
  doc: TimelineDoc,
  profile: ImageSequenceProfile,
  range: ExportRange,
  directory?: ImageSequenceDirectoryTarget,
  options: ImageSequenceSinkOptions = {},
): Promise<ExportVideoSink> {
  const validated = validateDeliveryProfile(profile)
  if (validated.kind !== 'image-sequence') {
    throw new TypeError('Image-sequence sink requires an image-sequence profile')
  }
  const window = validateExportRange(doc, range)
  if (validated.destination === 'directory' && !directory) {
    throw new TypeError('Folder image-sequence export requires a chosen directory')
  }
  if (validated.destination === 'download' && directory) {
    throw new TypeError('Download image-sequence export cannot use a directory target')
  }
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported in this browser')
  }

  const lensDocument = options.projectTarget
    ? {
        ...doc,
        masterVideoEffects: projectReachableSequences(options.projectTarget.project, options.projectTarget.sequenceId).flatMap((sequence) => sequence.masterVideoEffects ?? []),
        tracks: projectReachableSequences(
          options.projectTarget.project,
          options.projectTarget.sequenceId,
        ).flatMap((sequence) => sequence.tracks),
      }
    : doc
  if (hasVideoBusEffects(lensDocument)) {
    const error = videoBusRenderBudgetError(doc.width, doc.height)
    if (error) throw new RangeError(error)
  }
  if (documentHasUnsupportedLensCorrection(lensDocument)) {
    throw new LensRemapUnavailableError(
      'Export is blocked because this project contains a preserved future lens-correction version.',
    )
  }
  let lensBackend: WebGl2LensRemapBackend | null = null
  try {
    if (documentHasSupportedLensCorrection(lensDocument)) {
      lensBackend = new WebGl2LensRemapBackend()
    }
  } catch (cause) {
    throw new LensRemapUnavailableError(
      `Export lens correction is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      true,
      cause,
    )
  }
  let lensRemapProvider
  try {
    lensRemapProvider = createDocumentLensRemapProvider(
      lensDocument,
      lensBackend,
      doc.width,
      doc.height,
      true,
    )
  } catch (cause) {
    lensBackend?.dispose()
    throw cause
  }

  const canvas = new OffscreenCanvas(doc.width, doc.height)
  const context = canvas.getContext('2d', { colorSpace: 'srgb', alpha: true })
  if (!context) {
    lensBackend?.dispose()
    canvas.width = 1
    canvas.height = 1
    throw new Error('Could not create the image-sequence 2D context')
  }

  const padWidth = imageSequencePadWidth(window.endFrame)
  const convertPng = options.convertPng ?? defaultConvertPng
  const zipEntries: ZipStoreEntry[] = []
  const writtenNames: string[] = []
  const expectedFrames = window.endFrame - window.startFrame
  let nextOutputFrame = window.startFrame
  let state: 'open' | 'finalized' | 'canceled' = 'open'
  let transitionSurfaces: TransitionSurfaces | null = null
  let quotaFailure: unknown
  let renderSurfacesReleased = false

  const releaseRenderSurfaces = (): void => {
    if (renderSurfacesReleased) return
    renderSurfacesReleased = true
    lensBackend?.dispose()
    lensBackend = null
    if (transitionSurfaces) {
      for (const surface of [transitionSurfaces.leg.canvas, transitionSurfaces.group.canvas]) {
        const owned = surface as OffscreenCanvas
        owned.width = 1
        owned.height = 1
      }
      transitionSurfaces = null
    }
    canvas.width = 1
    canvas.height = 1
  }

  const appendSidecar = (): void => {
    if (!options.sidecarName || !options.sidecarBytes) return
    if (writtenNames.includes(options.sidecarName)) return
    zipEntries.push({ name: options.sidecarName, data: options.sidecarBytes })
    writtenNames.push(options.sidecarName)
  }

  const resultFor = async (completion: 'complete' | 'partial'): Promise<ExportResult> => {
    if (validated.destination === 'directory') {
      if (completion === 'complete' && options.sidecarName && options.sidecarBytes && directory) {
        if (!validated.overwriteExisting && await directory.exists(options.sidecarName)) {
          throw new Error(`Chapter sidecar ${options.sidecarName} already exists. Enable overwrite to replace it.`)
        }
        await directory.write(options.sidecarName, options.sidecarBytes)
        writtenNames.push(options.sidecarName)
      }
      return createDirectoryExportResult({
        destination: 'directory',
        kind: 'image-sequence',
        directoryName: directory!.directoryName,
        files: [...writtenNames],
        writtenFrames: writtenNames.filter((name) => name.endsWith('.png')).length,
        expectedFrames,
        completion,
        label: completion === 'complete' ? 'PNG image sequence' : 'Partial PNG image sequence',
      })
    }
    if (completion === 'complete') appendSidecar()
    const bytes = zipStore(zipEntries)
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return createAlternativeBufferedExportResult({
      destination: 'download',
      kind: 'image-sequence',
      buffer: copy.buffer,
      mimeType: 'application/zip',
      fileExtension: 'zip',
      label: completion === 'complete' ? 'PNG image sequence' : 'Partial PNG image sequence',
      completion,
      writtenFrames: zipEntries.filter((entry) => entry.name.endsWith('.png')).length,
      expectedFrames,
      files: zipEntries.map((entry) => entry.name),
    })
  }

  const commitPartial = async (): Promise<ExportResult | undefined> => {
    if (state === 'finalized' || state === 'canceled') return undefined
    if (writtenNames.filter((name) => name.endsWith('.png')).length === 0) {
      state = 'canceled'
      releaseRenderSurfaces()
      return undefined
    }
    state = 'finalized'
    try {
      return await resultFor('partial')
    } finally {
      releaseRenderSurfaces()
    }
  }

  return {
    compositeBackground: 'transparent',
    preservePartialOnFailure: true,
    commitPartial,
    ctx: context as Composite2D,
    lensRemapProvider,
    transitionSurfaceProvider: {
      get: () => {
        if (transitionSurfaces) return transitionSurfaces
        const legCanvas = new OffscreenCanvas(doc.width, doc.height)
        const legContext = legCanvas.getContext('2d', { colorSpace: 'srgb', alpha: true, willReadFrequently: true })
        const groupCanvas = new OffscreenCanvas(doc.width, doc.height)
        const groupContext = groupCanvas.getContext('2d', { colorSpace: 'srgb', alpha: true, willReadFrequently: true })
        if (!legContext || !groupContext) {
          legCanvas.width = 1
          legCanvas.height = 1
          groupCanvas.width = 1
          groupCanvas.height = 1
          throw new Error('Could not create image-sequence transition 2D contexts')
        }
        transitionSurfaces = {
          leg: { canvas: legCanvas, ctx: legContext as Composite2D },
          group: { canvas: groupCanvas, ctx: groupContext as Composite2D },
        }
        return transitionSurfaces
      },
    },
    addFrame: async () => {
      if (state !== 'open') throw new Error('Image-sequence sink is closed')
      if (nextOutputFrame >= window.endFrame) {
        throw new Error('Image-sequence sink received more frames than the selected range')
      }
      const name = imageSequenceFileName(validated.fileNamePrefix, nextOutputFrame, padWidth)
      try {
        const bytes = await convertPng(canvas)
        if (directory) {
          if (!validated.overwriteExisting && await directory.exists(name)) {
            throw new Error(`${name} already exists. Enable overwrite to replace existing PNG files.`)
          }
          await directory.write(name, bytes)
        } else {
          zipEntries.push({ name, data: bytes })
        }
        writtenNames.push(name)
        nextOutputFrame++
      } catch (cause) {
        quotaFailure = isQuotaError(cause) ? cause : quotaFailure
        if (quotaFailure) {
          const quota = new Error(
            `Storage exhausted after ${writtenNames.filter((file) => file.endsWith('.png')).length} of ${expectedFrames} PNG frames. Written files were kept.`,
            { cause },
          )
          quota.name = 'QuotaExceededError'
          throw quota
        }
        throw cause
      }
    },
    finalize: async () => {
      if (state !== 'open') throw new Error('Image-sequence sink is closed')
      const pngCount = writtenNames.filter((name) => name.endsWith('.png')).length
      if (pngCount !== expectedFrames) {
        throw new Error(`Image sequence expected ${expectedFrames} frames, wrote ${pngCount}`)
      }
      state = 'finalized'
      try {
        return await resultFor('complete')
      } finally {
        releaseRenderSurfaces()
      }
    },
    cancel: async () => {
      if (state === 'finalized' || state === 'canceled') return
      state = 'canceled'
      releaseRenderSurfaces()
    },
  }
}
