import { useId } from 'react'
import { boundedPluginUiText } from './pluginUiCopy'
import type {
  PluginParameterFieldView,
  PluginParameterValue,
} from './pluginUiTypes'

export interface PluginParameterFieldsProps {
  readonly effectType: string
  readonly effectLabel: string
  readonly fields: readonly PluginParameterFieldView[]
  readonly onChangeParameter: (
    effectType: string,
    parameterKey: string,
    value: PluginParameterValue,
  ) => void
}

interface ParameterInputProps {
  readonly effectType: string
  readonly field: PluginParameterFieldView
  readonly inputId: string
  readonly descriptionId: string
  readonly onChangeParameter: PluginParameterFieldsProps['onChangeParameter']
}

function ParameterInput({
  effectType,
  field,
  inputId,
  descriptionId,
  onChangeParameter,
}: ParameterInputProps) {
  const disabled = field.state !== 'editable'
  const change = (value: PluginParameterValue): void => {
    if (disabled) return
    onChangeParameter(effectType, field.key, value)
  }

  if (field.kind === 'number') {
    return (
      <input
        id={inputId}
        type="number"
        value={field.value}
        min={field.min}
        max={field.max}
        step={field.step}
        disabled={disabled}
        aria-describedby={descriptionId}
        onChange={(event) => {
          const nextValue = event.currentTarget.valueAsNumber
          if (Number.isFinite(nextValue)) change(nextValue)
        }}
      />
    )
  }

  if (field.kind === 'boolean') {
    return (
      <input
        id={inputId}
        type="checkbox"
        checked={field.value}
        disabled={disabled}
        aria-describedby={descriptionId}
        onChange={(event) => change(event.currentTarget.checked)}
      />
    )
  }

  return (
    <select
      id={inputId}
      value={field.value}
      disabled={disabled}
      aria-describedby={descriptionId}
      onChange={(event) => change(event.currentTarget.value)}
    >
      {field.options.map((option) => (
        <option key={option.value} value={option.value}>{option.name}</option>
      ))}
    </select>
  )
}

function parameterDescription(field: PluginParameterFieldView): string {
  if (field.kind === 'number') {
    return `${field.min} to ${field.max}; step ${field.step}. ${field.animatable ? 'Animatable.' : 'Static only.'}`
  }
  if (field.kind === 'boolean') return 'On or off.'
  return `${field.options.length} available choice${field.options.length === 1 ? '' : 's'}.`
}

export default function PluginParameterFields({
  effectType,
  effectLabel,
  fields,
  onChangeParameter,
}: PluginParameterFieldsProps) {
  const headingId = useId()
  const idPrefix = useId()

  return (
    <section
      className="plugin-parameter-editor plugin-surface"
      aria-labelledby={headingId}
    >
      <header className="plugin-surface-header">
        <div>
          <span className="plugin-eyebrow">Plugin parameters</span>
          <h2 id={headingId}>{effectLabel}</h2>
          <p>Values are supplied by the editor and returned without applying plugin policy or synthesizing defaults.</p>
        </div>
      </header>

      {fields.length === 0 ? (
        <p className="plugin-empty-copy">This effect has no configurable parameters.</p>
      ) : (
        <div className="plugin-parameter-list">
          {fields.map((field, index) => {
            const inputId = `${idPrefix}-parameter-${index}`
            const descriptionId = `${inputId}-description`
            const stateReason = field.stateReason
              ? boundedPluginUiText(field.stateReason)
              : null
            return (
              <div
                key={field.key}
                className="plugin-parameter-field"
                data-state={field.state}
              >
                <div className="plugin-parameter-label-row">
                  <label htmlFor={inputId}>{field.name}</label>
                  {field.state === 'locked' ? <span>Locked</span> : null}
                  {field.state === 'disabled' ? <span>Disabled</span> : null}
                </div>
                <ParameterInput
                  effectType={effectType}
                  field={field}
                  inputId={inputId}
                  descriptionId={descriptionId}
                  onChangeParameter={onChangeParameter}
                />
                <p id={descriptionId}>
                  <span>{parameterDescription(field)}</span>
                  {stateReason ? <span>{stateReason}</span> : null}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
