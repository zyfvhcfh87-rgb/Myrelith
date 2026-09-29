/**
 * Render surfaces owned by one finite export sink: the output canvas, the
 * optional lens-correction WebGL backend, and the lazily created transition
 * leg/group scratch canvases. The sink releases them exactly once.
 */

import { hasVideoBusEffects, videoBusRenderBudgetError } from '../domain/videoBusStage'
import type { TimelineDoc } from '../domain/schema'
import type { SequenceProject } from '../domain/projectSequences'
import { projectReachableSequences } from '../domain/selectors'
import type {
  Composite2D,
  TransitionSurfaceProvider,
  TransitionSurfaces,
} from './render'
import {
  createDocumentLensRemapProvider,
  documentHasSupportedLensCorrection,
  documentHasUnsupportedLensCorrection,
  WebGl2LensRemapBackend,
} from './lensRemapWebgl'
import { LensRemapUnavailableError, type LensRemapProvider } from './lensRemap'

export interface ExportRenderSurfaces {
  readonly canvas: OffscreenCanvas
  readonly ctx: Composite2D
  readonly lensRemapProvider: LensRemapProvider | null
  readonly transitionSurfaceProvider: TransitionSurfaceProvider
  /** Idempotent: disposes the lens backend and shrinks every owned canvas. */
  release(): void
}

export interface ExportRenderSurfaceOptions {
  /** Keep an alpha channel on the output and transition canvases. */
  readonly alpha: boolean
  /** Names the sink in context-creation errors, e.g. "export". */
  readonly label: string
  readonly projectTarget?: Readonly<{
    project: SequenceProject
    sequenceId: string
  }>
}

function shrinkCanvas(canvas: OffscreenCanvas): void {
  canvas.width = 1
  canvas.height = 1
}

/**
 * Validate the reachable video-bus and lens-correction work, then create the
 * output canvas and its lens backend. Anything created before a failure is
 * released before the error propagates.
 */
export function createExportRenderSurfaces(
  doc: TimelineDoc,
  options: ExportRenderSurfaceOptions,
): ExportRenderSurfaces {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported in this browser')
  }
  const target = options.projectTarget
  const reachable = target
    ? projectReachableSequences(target.project, target.sequenceId)
    : null
  const lensDocument = reachable
    ? {
        ...doc,
        masterVideoEffects: reachable.flatMap((sequence) => sequence.masterVideoEffects ?? []),
        tracks: reachable.flatMap((sequence) => sequence.tracks),
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
  let lensRemapProvider: LensRemapProvider | null
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

  let canvas: OffscreenCanvas
  try {
    canvas = new OffscreenCanvas(doc.width, doc.height)
  } catch (cause) {
    lensBackend?.dispose()
    throw cause
  }
  const context = canvas.getContext('2d', {
    colorSpace: 'srgb',
    ...(options.alpha ? { alpha: true } : {}),
  })
  if (!context) {
    lensBackend?.dispose()
    shrinkCanvas(canvas)
    throw new Error(`Could not create the ${options.label} 2D context`)
  }

  let transitionSurfaces: TransitionSurfaces | null = null
  let released = false
  return {
    canvas,
    ctx: context as Composite2D,
    lensRemapProvider,
    transitionSurfaceProvider: {
      get: () => {
        if (transitionSurfaces) return transitionSurfaces
        const scratchSettings: CanvasRenderingContext2DSettings = {
          colorSpace: 'srgb',
          willReadFrequently: true,
          ...(options.alpha ? { alpha: true } : {}),
        }
        const legCanvas = new OffscreenCanvas(doc.width, doc.height)
        const legContext = legCanvas.getContext('2d', scratchSettings)
        const groupCanvas = new OffscreenCanvas(doc.width, doc.height)
        const groupContext = groupCanvas.getContext('2d', scratchSettings)
        if (!legContext || !groupContext) {
          shrinkCanvas(legCanvas)
          shrinkCanvas(groupCanvas)
          throw new Error(`Could not create ${options.label} transition 2D contexts`)
        }
        transitionSurfaces = {
          leg: { canvas: legCanvas, ctx: legContext as Composite2D },
          group: { canvas: groupCanvas, ctx: groupContext as Composite2D },
        }
        return transitionSurfaces
      },
    },
    release: () => {
      if (released) return
      released = true
      lensBackend?.dispose()
      lensBackend = null
      if (transitionSurfaces) {
        shrinkCanvas(transitionSurfaces.leg.canvas as OffscreenCanvas)
        shrinkCanvas(transitionSurfaces.group.canvas as OffscreenCanvas)
        transitionSurfaces = null
      }
      shrinkCanvas(canvas)
    },
  }
}
