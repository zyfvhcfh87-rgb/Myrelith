/**
 * PNG image-sequence sink. Writes the exact selected integer-frame range with
 * zero-padded names. Cancellation and quota leave any already-written files and
 * report partial completion instead of inventing a finished archive.
 */

import type { ExportRange } from '../domain/exportRange'
import { validateExportRange } from '../domain/exportRange'
import type { TimelineDoc } from '../domain/schema'
import type { SequenceProject } from '../domain/projectSequences'
import {
  imageSequenceFileName,
  imageSequencePadWidth,
  validateDeliveryProfile,
  type ImageSequenceProfile,
} from '../domain/deliveryProduct'
import {
  createAlternativeBufferedExportResult,
  createDirectoryExportResult,
  isQuotaExceededCause,
  type ExportResult,
  type ExportVideoSink,
} from './export'
import { createExportRenderSurfaces } from './export-render-surfaces'
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
  const surfaces = createExportRenderSurfaces(doc, {
    alpha: true,
    label: 'image-sequence',
    projectTarget: options.projectTarget,
  })
  const { canvas } = surfaces

  const padWidth = imageSequencePadWidth(window.endFrame)
  const convertPng = options.convertPng ?? defaultConvertPng
  const zipEntries: ZipStoreEntry[] = []
  const writtenNames: string[] = []
  const expectedFrames = window.endFrame - window.startFrame
  let nextOutputFrame = window.startFrame
  let state: 'open' | 'finalized' | 'canceled' = 'open'
  let quotaFailure: unknown

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
    return createAlternativeBufferedExportResult({
      destination: 'download',
      kind: 'image-sequence',
      buffer: zipStore(zipEntries).buffer,
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
      surfaces.release()
      return undefined
    }
    state = 'finalized'
    try {
      return await resultFor('partial')
    } finally {
      surfaces.release()
    }
  }

  return {
    compositeBackground: 'transparent',
    preservePartialOnFailure: true,
    commitPartial,
    ctx: surfaces.ctx,
    lensRemapProvider: surfaces.lensRemapProvider,
    transitionSurfaceProvider: surfaces.transitionSurfaceProvider,
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
        quotaFailure = isQuotaExceededCause(cause) ? cause : quotaFailure
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
        surfaces.release()
      }
    },
    cancel: async () => {
      if (state === 'finalized' || state === 'canceled') return
      state = 'canceled'
      surfaces.release()
    },
  }
}
