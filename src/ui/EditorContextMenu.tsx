import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  editorContextMenuTargetExists,
  executeEditorContextMenuItem,
  resolveEditorContextMenu,
  type EditorContextMenuTarget,
  type ResolvedEditorContextMenuItem,
} from '../app/editorContextMenuCommands'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { useProxyStore } from '../state/proxyStore'
import { useTransportStore } from '../state/transportStore'
import {
  EditorContextMenuContext,
  type EditorContextMenuAnchor,
  type EditorContextMenuController,
  type EditorContextMenuRequest,
} from './editorContextMenuController'

const VIEWPORT_MARGIN_PX = 8
const TYPEAHEAD_RESET_MS = 650

interface ActiveEditorContextMenu extends EditorContextMenuRequest {
  readonly requestId: number
}

function menuButtons(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
}

function positionMenu(menu: HTMLElement, anchor: EditorContextMenuAnchor): void {
  const viewport = window.visualViewport
  const viewportLeft = viewport?.offsetLeft ?? 0
  const viewportTop = viewport?.offsetTop ?? 0
  const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth)
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
  menu.style.maxWidth = `${Math.max(0, viewportRight - viewportLeft - VIEWPORT_MARGIN_PX * 2)}px`
  menu.style.maxHeight = `${Math.max(0, viewportBottom - viewportTop - VIEWPORT_MARGIN_PX * 2)}px`
  const bounds = menu.getBoundingClientRect()
  const width = Math.max(bounds.width, menu.offsetWidth)
  const height = Math.max(bounds.height, menu.offsetHeight)
  let left: number
  let top: number
  if (anchor.kind === 'point') {
    left = anchor.x + width > viewportRight - VIEWPORT_MARGIN_PX
      ? anchor.x - width
      : anchor.x
    top = anchor.y + height > viewportBottom - VIEWPORT_MARGIN_PX
      ? anchor.y - height
      : anchor.y
  } else {
    left = anchor.left + width > viewportRight - VIEWPORT_MARGIN_PX
      ? anchor.right - width
      : anchor.left
    top = anchor.bottom + height > viewportBottom - VIEWPORT_MARGIN_PX
      ? anchor.top - height
      : anchor.bottom
  }
  left = Math.min(
    viewportRight - VIEWPORT_MARGIN_PX - width,
    Math.max(viewportLeft + VIEWPORT_MARGIN_PX, left),
  )
  top = Math.min(
    viewportBottom - VIEWPORT_MARGIN_PX - height,
    Math.max(viewportTop + VIEWPORT_MARGIN_PX, top),
  )
  menu.style.left = `${Math.round(left)}px`
  menu.style.top = `${Math.round(top)}px`
  menu.style.visibility = 'visible'
}

function showPopover(menu: HTMLElement): void {
  const popover = menu as HTMLElement & { showPopover?: () => void }
  if (typeof popover.showPopover !== 'function') {
    menu.removeAttribute('popover')
    menu.dataset.fallbackOpen = 'true'
    return
  }
  try {
    popover.showPopover()
  } catch {
    // StrictMode or a browser-closing race can leave it already open.
  }
}

export function EditorContextMenuHost({
  children,
  closing = false,
}: {
  readonly children: ReactNode
  readonly closing?: boolean
}) {
  const [active, setActive] = useState<ActiveEditorContextMenu | null>(null)
  const [revision, setRevision] = useState(0)
  const [feedback, setFeedback] = useState('')
  const menuRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<ActiveEditorContextMenu | null>(null)
  const nextRequestId = useRef(0)
  const focusedRequestId = useRef(0)
  const typeahead = useRef({ value: '', at: 0 })

  activeRef.current = active

  const close = useCallback((restoreFocus: boolean): void => {
    const request = activeRef.current
    activeRef.current = null
    setActive(null)
    setFeedback('')
    typeahead.current = { value: '', at: 0 }
    if (!restoreFocus) return
    requestAnimationFrame(() => {
      const target = request?.restoreFocusTo
      if (target?.isConnected) target.focus({ preventScroll: true })
    })
  }, [])

  const controller = useMemo<EditorContextMenuController>(() => ({
    open: (request) => {
      if (closing) return false
      const next: ActiveEditorContextMenu = {
        ...request,
        target: Object.freeze({ ...request.target }) as EditorContextMenuTarget,
        anchor: Object.freeze({ ...request.anchor }),
        uiActions: request.uiActions
          ? Object.freeze({ ...request.uiActions })
          : undefined,
        requestId: ++nextRequestId.current,
      }
      activeRef.current = next
      setFeedback('')
      setActive(next)
      return true
    },
  }), [closing])

  useEffect(() => {
    if (closing && activeRef.current) close(false)
  }, [close, closing])

  useEffect(() => {
    if (!active) return
    const refresh = (): void => {
      if (!editorContextMenuTargetExists(active.target)) {
        close(false)
        return
      }
      setRevision((current) => current + 1)
    }
    const unsubscribers = [
      useDocumentStore.subscribe(refresh),
      useMediaStore.subscribe(refresh),
      useProxyStore.subscribe(refresh),
      useProjectSessionStore.subscribe(refresh),
      useTransportStore.subscribe(refresh),
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [active, close])

  const resolved = active
    ? resolveEditorContextMenu(active.target, active.uiActions)
    : null
  void revision

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu || !active) return
    menu.style.visibility = 'hidden'
    showPopover(menu)
    positionMenu(menu, active.anchor)
    if (focusedRequestId.current !== active.requestId) {
      focusedRequestId.current = active.requestId
      menuButtons(menu)[0]?.focus({ preventScroll: true })
    }
  }, [active, resolved])

  useEffect(() => {
    const menu = menuRef.current
    if (!menu || !active) return
    const outsidePointer = (event: PointerEvent): void => {
      if (!menu.contains(event.target as Node)) close(true)
    }
    const secondContext = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node)) close(false)
    }
    const viewportChanged = (): void => close(true)
    const onToggle = (event: Event): void => {
      const toggle = event as ToggleEvent
      if (toggle.newState === 'closed' && activeRef.current) close(true)
    }
    document.addEventListener('pointerdown', outsidePointer, true)
    document.addEventListener('contextmenu', secondContext, true)
    document.addEventListener('scroll', viewportChanged, true)
    window.addEventListener('resize', viewportChanged)
    window.visualViewport?.addEventListener('resize', viewportChanged)
    window.visualViewport?.addEventListener('scroll', viewportChanged)
    menu.addEventListener('toggle', onToggle)
    return () => {
      document.removeEventListener('pointerdown', outsidePointer, true)
      document.removeEventListener('contextmenu', secondContext, true)
      document.removeEventListener('scroll', viewportChanged, true)
      window.removeEventListener('resize', viewportChanged)
      window.visualViewport?.removeEventListener('resize', viewportChanged)
      window.visualViewport?.removeEventListener('scroll', viewportChanged)
      menu.removeEventListener('toggle', onToggle)
    }
  }, [active, close])

  const activate = (
    command: ResolvedEditorContextMenuItem,
  ): void => {
    const request = activeRef.current
    if (!request) return
    const result = executeEditorContextMenuItem(
      request.target,
      command.id,
      request.uiActions,
    )
    if (!result.executed) {
      setFeedback(result.reason ?? 'That command is no longer available.')
      setRevision((current) => current + 1)
      return
    }
    close(command.restoreFocusAfterActivation !== false)
  }

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const menu = menuRef.current
    if (!menu) return
    const buttons = menuButtons(menu)
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1 + buttons.length) % buttons.length
    else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = buttons.length - 1
    else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    } else if (event.key === 'Tab') {
      close(false)
      return
    } else if (event.key === 'Enter' || event.key === ' ') {
      const command = resolved?.items[currentIndex]
      if (!command) return
      event.preventDefault()
      event.stopPropagation()
      activate(command)
      return
    } else if (
      event.key.length === 1
      && !event.ctrlKey
      && !event.metaKey
      && !event.altKey
    ) {
      const now = performance.now()
      const previous = typeahead.current
      const value = now - previous.at > TYPEAHEAD_RESET_MS
        ? event.key.toLocaleLowerCase()
        : `${previous.value}${event.key.toLocaleLowerCase()}`
      typeahead.current = { value, at: now }
      const start = currentIndex < 0 ? 0 : currentIndex + 1
      for (let offset = 0; offset < buttons.length; offset++) {
        const candidate = buttons[(start + offset) % buttons.length]
        if (candidate?.dataset.menuLabel?.toLocaleLowerCase().startsWith(value)) {
          event.preventDefault()
          candidate.focus({ preventScroll: true })
          return
        }
      }
      return
    } else return
    event.preventDefault()
    event.stopPropagation()
    buttons[nextIndex]?.focus({ preventScroll: true })
  }

  return (
    <EditorContextMenuContext.Provider value={controller}>
      {children}
      {active && resolved ? (
        <div
          ref={menuRef}
          className="editor-context-menu"
          popover="auto"
          role="menu"
          aria-label={resolved.label}
          onKeyDown={handleMenuKeyDown}
        >
          {resolved.items.map((command) => (
            <div key={command.id} className="editor-context-menu-row">
              {command.separatorBefore ? (
                <div className="editor-context-menu-separator" role="separator" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="editor-context-menu-item"
                data-danger={command.danger || undefined}
                data-menu-label={command.label}
                aria-disabled={command.disabledReason ? 'true' : undefined}
                onClick={() => activate(command)}
              >
                <span>{command.label}</span>
                {command.disabledReason ? (
                  <small>{command.disabledReason}</small>
                ) : null}
              </button>
            </div>
          ))}
          <span className="visually-hidden" role="status" aria-live="polite">
            {feedback}
          </span>
        </div>
      ) : null}
    </EditorContextMenuContext.Provider>
  )
}
