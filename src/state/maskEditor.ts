/** Pure facts exposed to React through the state boundary. */
export { maskEditingTarget, type MaskEditTarget, type MaskEditPatch } from '../domain/maskEditing'
export { maskPointToProject, projectPointToMask, monitorPointToProject, projectPointToMonitor, moveMaskBox, resizeMaskBox, type MaskMonitorViewport, type MaskBoxCorner } from '../domain/maskGeometry'
export { editMaskBezierPath, maskPathPartPoint, appendMaskBezierDraftPoint, removeLastMaskBezierDraftPoint, closeMaskBezierDraft, type MaskPathPart } from '../domain/maskPathEdit'
export { parseMaskBezierPath, MAX_MASK_BEZIER_SEGMENTS, type ParsedMaskPath, type MaskPoint } from '../domain/maskPath'
