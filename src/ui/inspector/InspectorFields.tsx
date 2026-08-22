import { useEffect, useState, type ReactNode } from 'react'
import { TEXT_OVERLAY_LIMITS } from '../../domain/textOverlay'

export interface NumberFieldProps {
  label: string
  value: number
  step: number
  testId: string
  onCommit: (value: number) => void
  min?: number
  max?: number
  disabled?: boolean
  clamp?: boolean
}

export function NumberField({
  label,
  value,
  step,
  testId,
  onCommit,
  min,
  max,
  disabled = false,
  clamp = false,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value))
  // Re-sync whenever the committed value changes under us (undo/redo, a
  // gesture on the canvas, switching clips) — but never while typing.
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = (): void => {
    const trimmed = draft.trim()
    const parsed = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(parsed)) {
      setDraft(String(value)) // junk: revert, commit nothing
      return
    }
    const candidate = clamp
      ? Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed))
      : parsed
    if (candidate === value) {
      setDraft(String(value))
      return
    }
    setDraft(String(candidate))
    onCommit(candidate)
  }

  return (
    <label className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        value={draft}
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            setDraft(String(value))
          }
        }}
      />
    </label>
  )
}

interface RangeNumberFieldProps extends Omit<NumberFieldProps, 'onCommit'> {
  onCommit: (value: number) => void
}

/** Slider commits immediately; its paired number field keeps one typed commit. */
export function RangeNumberField(props: RangeNumberFieldProps) {
  const { label, value, min, max, step, testId, disabled = false, onCommit } = props
  const commitKey = (key: string): boolean => {
    const minimum = min ?? 0
    const maximum = max ?? 100
    let next: number
    if (key === 'Home') next = minimum
    else if (key === 'End') next = maximum
    else if (key === 'ArrowLeft' || key === 'ArrowDown') next = value - step
    else if (key === 'ArrowRight' || key === 'ArrowUp') next = value + step
    else if (key === 'PageDown') next = value - step * 10
    else if (key === 'PageUp') next = value + step * 10
    else return false
    const decimals = String(step).split('.')[1]?.length ?? 0
    const bounded = Math.min(maximum, Math.max(minimum, next))
    onCommit(Number(bounded.toFixed(decimals)))
    return true
  }
  return (
    <div className="inspector-range-field">
      <input
        type="range"
        aria-label={`${label} slider`}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        data-testid={`${testId}-slider`}
        onChange={(event) => onCommit(Number(event.target.value))}
        onKeyDown={(event) => {
          if (commitKey(event.key)) event.preventDefault()
        }}
      />
      <NumberField {...props} clamp />
    </div>
  )
}

export function InspectorSection({
  title,
  resetLabel,
  disabled,
  onReset,
  children,
}: {
  title: string
  resetLabel: string
  disabled: boolean
  onReset(): void
  children: ReactNode
}) {
  return (
    <section className="inspector-section" aria-label={title}>
      <div className="inspector-section-bar">
        <h3>{title}</h3>
        <button
          type="button"
          className="inspector-reset"
          disabled={disabled}
          aria-label={resetLabel}
          onClick={onReset}
        >
          Reset
        </button>
      </div>
      {children}
    </section>
  )
}

export function TextAreaField({
  value,
  disabled,
  onCommit,
}: {
  value: string
  disabled: boolean
  onCommit(value: string): void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <label className="inspector-field inspector-field-wide">
      <span className="inspector-field-label">Content</span>
      <textarea
        data-testid="inspector-text-content"
        value={draft}
        rows={4}
        maxLength={TEXT_OVERLAY_LIMITS.maxCharacters}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(value)
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}

export function ToggleField({
  label,
  checked,
  disabled,
  testId,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  testId: string
  onChange(checked: boolean): void
}) {
  return (
    <label className="inspector-toggle inspector-toggle-control">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}
