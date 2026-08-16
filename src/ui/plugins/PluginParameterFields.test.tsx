import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import PluginParameterFields from './PluginParameterFields'
import type { PluginParameterFieldView } from './pluginUiTypes'

const effectType = 'plugin:com.example.sparkle/soft-sparkle'
const fields: readonly PluginParameterFieldView[] = [
  {
    key: 'strength',
    name: 'Strength',
    kind: 'number',
    value: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
    animatable: true,
    state: 'editable',
  },
  {
    key: 'preserve-alpha',
    name: 'Preserve alpha',
    kind: 'boolean',
    value: false,
    state: 'editable',
  },
  {
    key: 'mode',
    name: 'Blend mode',
    kind: 'enum',
    value: 'soft',
    options: [
      { value: 'soft', name: 'Soft' },
      { value: 'hard', name: 'Hard' },
    ],
    state: 'editable',
  },
  {
    key: 'locked-gain',
    name: 'Locked gain',
    kind: 'number',
    value: 1,
    min: 0,
    max: 2,
    step: 0.5,
    animatable: false,
    state: 'locked',
    stateReason: 'Unlock the clip before editing this value.',
  },
  {
    key: 'future-mode',
    name: '<img src=x onerror=alert(1)>',
    kind: 'enum',
    value: 'future',
    options: [{ value: 'future', name: '<script>alert(1)</script>' }],
    state: 'disabled',
    stateReason: 'This parameter is unavailable in the current descriptor version.',
  },
]

describe('PluginParameterFields', () => {
  test('renders exact numeric metadata, animatable labels, and locked or disabled reasons', () => {
    render(
      <PluginParameterFields
        effectType={effectType}
        effectLabel="Soft Sparkle"
        fields={fields}
        onChangeParameter={vi.fn()}
      />,
    )

    const strength = screen.getByRole('spinbutton', { name: 'Strength' })
    expect(strength).toHaveAttribute('min', '0')
    expect(strength).toHaveAttribute('max', '1')
    expect(strength).toHaveAttribute('step', '0.01')
    expect(screen.getByText('0 to 1; step 0.01. Animatable.')).toBeInTheDocument()
    expect(screen.getByText('0 to 2; step 0.5. Static only.')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Locked gain' })).toBeDisabled()
    expect(screen.getByText('Unlock the clip before editing this value.')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '<img src=x onerror=alert(1)>' })).toBeDisabled()
    expect(screen.getByText('This parameter is unavailable in the current descriptor version.')).toBeInTheDocument()
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })

  test('returns only the exact effect type, parameter key, and primitive value', () => {
    const onChangeParameter = vi.fn()
    render(
      <PluginParameterFields
        effectType={effectType}
        effectLabel="Soft Sparkle"
        fields={fields}
        onChangeParameter={onChangeParameter}
      />,
    )

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Strength' }), {
      target: { value: '0.75' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Preserve alpha' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Blend mode' }), {
      target: { value: 'hard' },
    })

    expect(onChangeParameter.mock.calls).toEqual([
      [effectType, 'strength', 0.75],
      [effectType, 'preserve-alpha', true],
      [effectType, 'mode', 'hard'],
    ])
  })

  test('keeps native keyboard focus order and skips locked or disabled controls', async () => {
    const user = userEvent.setup()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const onChangeParameter = vi.fn()
    const { unmount } = render(
      <PluginParameterFields
        effectType={effectType}
        effectLabel="Soft Sparkle"
        fields={fields}
        onChangeParameter={onChangeParameter}
      />,
    )

    await user.tab()
    expect(screen.getByRole('spinbutton', { name: 'Strength' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('checkbox', { name: 'Preserve alpha' })).toHaveFocus()
    await user.keyboard(' ')
    expect(onChangeParameter).toHaveBeenCalledWith(effectType, 'preserve-alpha', true)
    await user.tab()
    expect(screen.getByRole('combobox', { name: 'Blend mode' })).toHaveFocus()

    unmount()
    trigger.remove()
  })

  test('shows an empty parameter state without inventing defaults', () => {
    render(
      <PluginParameterFields
        effectType={effectType}
        effectLabel="No Controls"
        fields={[]}
        onChangeParameter={vi.fn()}
      />,
    )

    expect(screen.getByText('This effect has no configurable parameters.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
