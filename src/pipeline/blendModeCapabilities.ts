import type { BlendModeName } from '../domain/blendModes'

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
