import {
  DEFAULT_BLEND_MODE,
  type BlendModeName,
  type BlendModeResolution,
} from '../domain/blendModes'

export type BlendCompositeBackend = 'canvas2d' | 'webgl' | 'compatibility'

export interface BlendModeBackendCapabilities {
  supportsCanvas2D(mode: BlendModeName): boolean
  /** Optional seam for a parity-verified WebGL implementation. */
  supportsWebGL?(mode: BlendModeName): boolean
}

export interface BlendModeBackendSelection {
  backend: BlendCompositeBackend
  effective: BlendModeName
}

/** Prefer Canvas2D, then an explicitly registered WebGL parity path, then normal. */
export function selectBlendModeBackend(
  resolution: BlendModeResolution,
  capabilities: BlendModeBackendCapabilities,
): BlendModeBackendSelection {
  if (resolution.status === 'compatibility-fallback') {
    return { backend: 'compatibility', effective: DEFAULT_BLEND_MODE }
  }
  if (capabilities.supportsCanvas2D(resolution.effective)) {
    return { backend: 'canvas2d', effective: resolution.effective }
  }
  if (capabilities.supportsWebGL?.(resolution.effective)) {
    return { backend: 'webgl', effective: resolution.effective }
  }
  return { backend: 'compatibility', effective: DEFAULT_BLEND_MODE }
}

export interface CanvasBlendProbeContext {
  globalCompositeOperation: GlobalCompositeOperation
}

export interface CanvasBlendModeCapability {
  supported: boolean
  operation: GlobalCompositeOperation
}

const CANVAS_OPERATION: Readonly<Record<BlendModeName, GlobalCompositeOperation>> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  difference: 'difference',
  exclusion: 'exclusion',
}

/**
 * Probe the concrete context rather than assuming a browser/GPU capability.
 * The caller's composite operation is restored even when a host setter throws.
 */
export function probeCanvasBlendMode(
  context: CanvasBlendProbeContext,
  mode: BlendModeName,
): CanvasBlendModeCapability {
  const previous = context.globalCompositeOperation
  const operation = CANVAS_OPERATION[mode]
  let supported = false
  try {
    context.globalCompositeOperation = operation
    supported = context.globalCompositeOperation === operation
  } catch {
    supported = false
  } finally {
    try {
      context.globalCompositeOperation = previous
    } catch {
      // A hostile host setter must not turn capability detection into a leak.
    }
  }
  return {
    supported,
    operation: supported ? operation : 'source-over',
  }
}
