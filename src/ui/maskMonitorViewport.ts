import type { MaskMonitorViewport } from '../domain/maskGeometry'

export interface MaskEditorViewport { canvas: MaskMonitorViewport; panelLeft: number; panelTop: number }

/** Read live CSS geometry: resize/scroll observer delivery can lag pointer-up. */
export function readMaskEditorViewport(canvas: HTMLCanvasElement | null, panel: HTMLDivElement | null): MaskEditorViewport | null {
  const bounds = canvas?.getBoundingClientRect(), parent = panel?.getBoundingClientRect()
  return bounds && parent && bounds.width > 0 && bounds.height > 0
    ? { canvas: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }, panelLeft: parent.left, panelTop: parent.top }
    : null
}

export function sameMaskEditorViewport(left: MaskEditorViewport | null, right: MaskEditorViewport | null): boolean {
  if (!left || !right) return left === right
  return left.panelLeft === right.panelLeft && left.panelTop === right.panelTop
    && left.canvas.left === right.canvas.left && left.canvas.top === right.canvas.top
    && left.canvas.width === right.canvas.width && left.canvas.height === right.canvas.height
}
