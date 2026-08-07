import {
  Suspense,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import LazyLoadBoundary from './LazyLoadBoundary'

export interface LazySurfaceBoundaryProps {
  children: ReactNode
  loadingLabel: string
  failureTitle: string
  variant?: 'dialog' | 'inline'
  onClose?: () => void
  onReload?: () => void
}

interface SurfaceStateProps {
  variant: 'dialog' | 'inline'
  role: 'alert' | 'status'
  label: string
  children: ReactNode
}

function SurfaceState({ variant, role, label, children }: SurfaceStateProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (variant !== 'dialog') return
    const dialog = dialogRef.current
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus()
  }, [variant])

  const containDialogKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.key !== 'Tab') return

    const dialog = event.currentTarget
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
      event.preventDefault()
      first.focus()
    }
  }

  const content = (
    <section
      className={`lazy-surface-state lazy-surface-state-${variant}`}
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      aria-busy={role === 'status' ? 'true' : undefined}
    >
      {children}
    </section>
  )
  return variant === 'dialog'
    ? (
        <div
          ref={dialogRef}
          className="lazy-surface-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={containDialogKey}
        >
          {content}
        </div>
      )
    : content
}

export default function LazySurfaceBoundary({
  children,
  loadingLabel,
  failureTitle,
  variant = 'inline',
  onClose,
  onReload = () => window.location.reload(),
}: LazySurfaceBoundaryProps) {
  const failure = (
    <SurfaceState variant={variant} role="alert" label={failureTitle}>
      <h2>{failureTitle}</h2>
      <p>
        The requested tools could not be downloaded. Check your connection or
        reload WebCut to fetch the current files.
      </p>
      <div className="lazy-surface-actions">
        {onClose && (
          <button type="button" autoFocus onClick={onClose}>
            Close
          </button>
        )}
        <button type="button" autoFocus={!onClose} onClick={onReload}>
          Reload WebCut
        </button>
      </div>
    </SurfaceState>
  )
  return (
    <LazyLoadBoundary fallback={failure}>
      <Suspense
        fallback={(
          <SurfaceState variant={variant} role="status" label={loadingLabel}>
            <span className="lazy-load-spinner" aria-hidden="true" />
            <span>{loadingLabel}</span>
          </SurfaceState>
        )}
      >
        {children}
      </Suspense>
    </LazyLoadBoundary>
  )
}
