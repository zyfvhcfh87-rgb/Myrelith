import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import PluginManagerPanel from './PluginManagerPanel'
import type { InstalledPluginView } from './pluginUiTypes'

const installed: InstalledPluginView = {
  id: 'com.example.sparkle',
  name: 'Soft Sparkle',
  version: '1.2.0',
  signerFingerprint: 'sha256:1234abcd',
  packageDigest: 'sha256:fedcba98',
  status: 'failed',
  statusDetail: 'The preview call timed out. The effect is preserved and bypassed.',
  permissionNames: ['Video frame pixels'],
  contributionNames: ['Soft Sparkle'],
  diagnostics: [{
    id: 'diagnostic-1',
    level: 'error',
    code: 'timeout',
    message: '<img src=x onerror=alert(1)>',
    occurredAtLabel: 'Just now',
  }],
  operation: null,
  operationError: null,
}

const callbacks = () => ({
  onInspectPackage: vi.fn(),
  onRetryPlugin: vi.fn(),
  onEnablePlugin: vi.fn(),
  onDisablePlugin: vi.fn(),
  onUninstallPlugin: vi.fn(),
})

describe('PluginManagerPanel', () => {
  test('covers loading, registry error, and empty states', () => {
    const actions = callbacks()
    const { rerender } = render(
      <PluginManagerPanel phase="loading" packages={[]} {...actions} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('local plugin registry')
    expect(screen.getByRole('button', { name: 'Inspect package…' })).toBeDisabled()

    rerender(
      <PluginManagerPanel
        phase="error"
        packages={[]}
        error="Origin-local storage is unavailable."
        onRetryLoad={vi.fn()}
        {...actions}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Origin-local storage')

    rerender(<PluginManagerPanel phase="ready" packages={[]} {...actions} />)
    expect(screen.getByText('No plugins installed')).toBeInTheDocument()
  })

  test('routes retry, disable, and explicit uninstall confirmation by plugin id', () => {
    const actions = callbacks()
    render(<PluginManagerPanel phase="ready" packages={[installed]} {...actions} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    expect(actions.onRetryPlugin).toHaveBeenCalledWith(installed.id)
    expect(actions.onDisablePlugin).toHaveBeenCalledWith(installed.id)

    fireEvent.click(screen.getByRole('button', { name: 'Review uninstall' }))
    expect(screen.getByText(/Project effect records stay preserved and bypassed/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm uninstall' }))
    expect(actions.onUninstallPlugin).toHaveBeenCalledWith(installed.id)
  })

  test('renders bounded diagnostic strings as plain text', () => {
    const actions = callbacks()
    render(<PluginManagerPanel phase="ready" packages={[installed]} {...actions} />)

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('timeout')).toBeInTheDocument()
  })

  test('defensively caps diagnostics to the latest 100 bounded messages', () => {
    const actions = callbacks()
    const diagnostics = Array.from({ length: 101 }, (_, index) => ({
      id: `diagnostic-${index}`,
      level: 'info' as const,
      code: `code-${index}`,
      message: index === 100 ? 'x'.repeat(600) : `message-${index}`,
      occurredAtLabel: `${index} minutes ago`,
    }))
    render(
      <PluginManagerPanel
        phase="ready"
        packages={[{ ...installed, diagnostics }]}
        {...actions}
      />,
    )

    const region = screen.getByRole('region', { name: 'Soft Sparkle diagnostics' })
    expect(within(region).getAllByRole('listitem')).toHaveLength(100)
    expect(within(region).queryByText('code-0')).not.toBeInTheDocument()
    expect(within(region).getByText('code-1')).toBeInTheDocument()
    expect(within(region).getByText('x'.repeat(512))).toBeInTheDocument()
    expect(within(region).queryByText('x'.repeat(600))).not.toBeInTheDocument()
  })

  test('shows the current reversible operation in a live status', () => {
    const actions = callbacks()
    render(
      <PluginManagerPanel
        phase="ready"
        packages={[{ ...installed, operation: 'retry' }]}
        {...actions}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Retrying Soft Sparkle')
    for (const button of screen.getAllByRole('button')) {
      if (button.textContent !== 'Inspect package…') expect(button).toBeDisabled()
    }
  })
})
