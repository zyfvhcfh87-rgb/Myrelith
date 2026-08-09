/** Accessible pointer and keyboard separator for one workspace dimension. */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'

export interface WorkspaceResizeHandleProps {
  className?: string
  controls: string
  label: string
  orientation: 'horizontal' | 'vertical'
  value: number
  min: number
  max: number
  direction: 1 | -1
  onPreview(value: number): void
  onCommit(value: number): void
  onCancel(): void
  onAnnounce(message: string): void
  disabled?: boolean
}

interface PointerSession {
  pointerId: number
  startCoordinate: number
  startValue: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export default function WorkspaceResizeHandle({
  className,
  controls,
  label,
  orientation,
  value,
  min,
  max,
  direction,
  onPreview,
  onCommit,
  onCancel,
  onAnnounce,
  disabled = false,
}: WorkspaceResizeHandleProps) {
  const [session, setSession] = useState<PointerSession | null>(null)
  const [previewValue, setPreviewValue] = useState<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef<number | null>(null)
  const previewRef = useRef<number | null>(null)
  const currentValue = previewValue ?? value

  useEffect(() => {
    if (session === null) return
    const coordinate = (event: globalThis.PointerEvent): number =>
      orientation === 'vertical' ? event.clientX : event.clientY
    const flush = (): void => {
      frameRef.current = null
      const pending = pendingRef.current
      if (pending === null) return
      pendingRef.current = null
      previewRef.current = pending
      setPreviewValue(pending)
      onPreview(pending)
    }
    const move = (event: globalThis.PointerEvent): void => {
      if (event.pointerId !== session.pointerId) return
      const delta = (coordinate(event) - session.startCoordinate) * direction
      pendingRef.current = clamp(session.startValue + delta, min, max)
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flush)
      }
    }
    const finish = (event: globalThis.PointerEvent): void => {
      if (event.pointerId !== session.pointerId) return
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      const next = pendingRef.current ?? previewRef.current ?? session.startValue
      pendingRef.current = null
      previewRef.current = null
      setPreviewValue(null)
      setSession(null)
      onCommit(next)
      onAnnounce(`${label} set to ${next} pixels.`)
    }
    const cancel = (event: globalThis.PointerEvent): void => {
      if (event.pointerId !== session.pointerId) return
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      pendingRef.current = null
      previewRef.current = null
      setPreviewValue(null)
      setSession(null)
      onCancel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      pendingRef.current = null
    }
  }, [
    direction,
    label,
    max,
    min,
    onAnnounce,
    onCancel,
    onCommit,
    onPreview,
    orientation,
    session,
  ])

  const beginPointerResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled || event.button !== 0 || session !== null) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Window listeners own the gesture even if pointer capture is unavailable.
    }
    setSession({
      pointerId: event.pointerId,
      startCoordinate:
        orientation === 'vertical' ? event.clientX : event.clientY,
      startValue: value === 0 ? min : value,
    })
  }

  const handleKeyboardResize = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    let next: number
    if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else if (event.key === decrease) next = currentValue - 16 * direction
    else if (event.key === increase) next = currentValue + 16 * direction
    else return
    event.preventDefault()
    next = clamp(value === 0 ? Math.max(min, next) : next, min, max)
    onCommit(next)
    onAnnounce(`${label} set to ${next} pixels.`)
  }

  return (
    <div
      className={`workspace-resize-handle workspace-resize-${orientation}${className ? ` ${className}` : ''}`}
      role="separator"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-controls={controls}
      aria-orientation={orientation}
      aria-valuemin={value === 0 ? 0 : min}
      aria-valuemax={max}
      aria-valuenow={currentValue}
      aria-valuetext={currentValue === 0 ? `${label} collapsed` : `${currentValue} pixels`}
      data-resizing={session === null ? undefined : 'true'}
      onPointerDown={beginPointerResize}
      onKeyDown={handleKeyboardResize}
    />
  )
}
