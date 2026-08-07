import { Suspense, type ReactNode } from 'react'
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
  children: ReactNode
}

function SurfaceState({ variant, role, children }: SurfaceStateProps) {
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
    ? <div className="lazy-surface-backdrop">{content}</div>
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
    <SurfaceState variant={variant} role="alert">
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
          <SurfaceState variant={variant} role="status">
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
