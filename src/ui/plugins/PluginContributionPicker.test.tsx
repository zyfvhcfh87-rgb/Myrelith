import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import PluginContributionPicker from './PluginContributionPicker'
import type {
  PluginActionView,
  PluginContributionView,
} from './pluginUiTypes'

function action(
  available: boolean,
  overrides: Partial<PluginActionView> = {},
): PluginActionView {
  return { available, pending: false, ...overrides }
}

const readyContribution: PluginContributionView = {
  effectType: 'plugin:com.example.sparkle/soft-sparkle',
  pluginId: 'com.example.sparkle',
  pluginName: 'Sparkle Pack',
  pluginVersion: '1.2.0',
  contributionName: 'Soft Sparkle',
  status: 'ready',
  detail: 'Ready to add to the selected clip.',
  selectAction: action(true),
}

describe('PluginContributionPicker', () => {
  test('selects a ready contribution by its exact stable effect type', () => {
    const onSelectContribution = vi.fn()
    render(
      <PluginContributionPicker
        contributions={[readyContribution]}
        onSelectContribution={onSelectContribution}
      />,
    )

    expect(screen.getByText(readyContribution.effectType)).toBeInTheDocument()
    expect(screen.getByText('Ready')).toHaveAttribute('data-status', 'ready')
    fireEvent.click(screen.getByRole('button', { name: 'Add Soft Sparkle' }))
    expect(onSelectContribution).toHaveBeenCalledWith(readyContribution.effectType)
    expect(onSelectContribution).toHaveBeenCalledTimes(1)
  })

  test('keeps unavailable contributions inspectable and explains app-projected blocking state', () => {
    const onSelectContribution = vi.fn()
    render(
      <PluginContributionPicker
        contributions={[
          {
            ...readyContribution,
            effectType: 'plugin:com.example.sparkle/quarantined',
            contributionName: '<img src=x onerror=alert(1)>',
            status: 'quarantined',
            detail: 'Quarantined after repeated runtime failures.',
            selectAction: action(false),
          },
          {
            ...readyContribution,
            effectType: 'plugin:com.example.sparkle/locked',
            contributionName: 'Locked Glow',
            selectAction: action(true, {
              disabledReason: 'Effect insertion is locked while recovery is open.',
            }),
          },
        ]}
        onSelectContribution={onSelectContribution}
      />,
    )

    expect(screen.getByText('Quarantined after repeated runtime failures.')).toBeInTheDocument()
    expect(screen.getByText('Quarantined')).toHaveAttribute('data-status', 'quarantined')
    expect(screen.queryByRole('button', { name: 'Add <img src=x onerror=alert(1)>' })).not.toBeInTheDocument()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add Locked Glow' })).toBeDisabled()
    expect(screen.getByText('Effect insertion is locked while recovery is open.')).toBeInTheDocument()
    expect(onSelectContribution).not.toHaveBeenCalled()
  })

  test('uses native keyboard focus and activation for the ready selection action', async () => {
    const user = userEvent.setup()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const onSelectContribution = vi.fn()
    const { unmount } = render(
      <PluginContributionPicker
        contributions={[readyContribution]}
        onSelectContribution={onSelectContribution}
      />,
    )

    await user.tab()
    expect(screen.getByRole('button', { name: 'Add Soft Sparkle' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onSelectContribution).toHaveBeenCalledWith(readyContribution.effectType)

    unmount()
    trigger.remove()
  })

  test('shows an honest empty state without an inert picker control', () => {
    render(
      <PluginContributionPicker
        contributions={[]}
        onSelectContribution={vi.fn()}
      />,
    )

    expect(screen.getByText('No plugin effects available')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
