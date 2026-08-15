import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

const FOCUSABLE_SELECTOR = [
  '[data-plugin-dialog-initial-focus]:not([disabled])',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

interface PluginDialogFrameProps {
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly children: ReactNode
  readonly actions: ReactNode
  readonly busy?: boolean
  readonly dismissDisabled?: boolean
  readonly onDismiss: () => void
}

export default function PluginDialogFrame({
  eyebrow,
  title,
  description,
  children,
  actions,
  busy = false,
  dismissDisabled = false,
  onDismiss,
}: PluginDialogFrameProps) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const restoreTarget = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const dialog = dialogRef.current
    const initialFocus = dialog?.querySelector<HTMLElement>(
      '[data-plugin-dialog-initial-focus]:not([disabled])',
    ) ?? dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    ;(initialFocus ?? dialog)?.focus()

    return () => {
      if (restoreTarget?.isConnected) restoreTarget.focus()
    }
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    event.stopPropagation()
    if (event.key === 'Escape' && !dismissDisabled) {
      event.preventDefault()
      onDismiss()
      return
    }
    if (event.key !== 'Tab') return

    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .filter((element) => !element.hasAttribute('disabled') && !element.hidden)
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="plugin-dialog-backdrop">
      <section
        ref={dialogRef}
        className="plugin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="plugin-dialog-header">
          <span className="plugin-eyebrow">{eyebrow}</span>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
        </header>
        <div className="plugin-dialog-body">{children}</div>
        <footer className="plugin-dialog-actions">{actions}</footer>
      </section>
    </div>
  )
}
