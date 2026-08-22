import {
  createContext,
  useContext,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type {
  EditorContextMenuTarget,
  EditorContextMenuUiActions,
} from '../app/editorContextMenuCommands'

export type EditorContextMenuAnchor =
  | {
      readonly kind: 'point'
      readonly x: number
      readonly y: number
    }
  | {
      readonly kind: 'rect'
      readonly left: number
      readonly top: number
      readonly right: number
      readonly bottom: number
    }

export interface EditorContextMenuRequest {
  readonly target: EditorContextMenuTarget
  readonly anchor: EditorContextMenuAnchor
  readonly restoreFocusTo: HTMLElement | null
  readonly uiActions?: EditorContextMenuUiActions
}

export interface EditorContextMenuController {
  readonly open: (request: EditorContextMenuRequest) => boolean
}

export const EditorContextMenuContext = createContext<EditorContextMenuController>({
  open: () => false,
})

export function useEditorContextMenu(): EditorContextMenuController {
  return useContext(EditorContextMenuContext)
}

export function shouldPreserveNativeContextMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(
    'input, textarea, select, option, a[href], [contenteditable]:not([contenteditable="false"])',
  ) !== null
}

function rectAnchor(element: Element): EditorContextMenuAnchor {
  const rect = element.getBoundingClientRect()
  return {
    kind: 'rect',
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  }
}

/**
 * Recognize one supported editor target, then and only then cancel the native
 * menu. Zero-coordinate contextmenu events are keyboard invocations and use
 * the active target's bounding box.
 */
export function openEditorContextMenuFromEvent(
  controller: EditorContextMenuController,
  event: ReactMouseEvent<Element>,
  request: Omit<EditorContextMenuRequest, 'anchor'> & {
    readonly anchorElement?: Element | null
  },
): boolean {
  if (shouldPreserveNativeContextMenu(event.target)) return false
  const keyboardInvocation = event.clientX === 0 && event.clientY === 0
  const anchorElement = request.anchorElement ?? event.currentTarget
  const anchor = keyboardInvocation
    ? rectAnchor(anchorElement)
    : { kind: 'point' as const, x: event.clientX, y: event.clientY }
  const opened = controller.open({
    target: request.target,
    anchor,
    restoreFocusTo: request.restoreFocusTo,
    uiActions: request.uiActions,
  })
  if (!opened) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}
