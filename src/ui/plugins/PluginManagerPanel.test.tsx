import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import PluginManagerPanel from './PluginManagerPanel'
import type {
  InstalledPluginView,
  PluginActionView,
} from './pluginUiTypes'

function action(
  available: boolean,
  overrides: Partial<PluginActionView> = {},
): PluginActionView {
  return { available, pending: false, ...overrides }
}

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
  actions: {
    retry: action(true),
    enable: action(false),
    disable: action(true),
    uninstall: action(true),
    clearDiagnostics: action(true),
  },
}

const callbacks = () => ({
  onInspectPackage: vi.fn(),
  onRetryPlugin: vi.fn(),
  onEnablePlugin: vi.fn(),
  onDisablePlugin: vi.fn(),
  onUninstallPlugin: vi.fn(),
  onClearDiagnostics: vi.fn(),
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

  test('routes app-projected retry, disable, and explicit uninstall actions by plugin id', () => {
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

  test('obeys projected availability and bounded disabled/error details instead of package status', () => {
    const actions = callbacks()
    const longError = 'x'.repeat(600)
    render(
      <PluginManagerPanel
        phase="ready"
        packages={[{
          ...installed,
          status: 'ready',
          actions: {
            ...installed.actions,
            retry: action(true, { error: longError }),
            enable: action(true, { disabledReason: 'Enable is locked by the current trust policy.' }),
            disable: action(false),
          },
        }]}
        {...actions}
      />,
    )

    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled()
    expect(screen.getByText('Enable is locked by the current trust policy.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('x'.repeat(512))
    expect(screen.getByRole('alert')).not.toHaveTextContent('x'.repeat(513))
  })

  test('renders bounded diagnostic strings as plain text', () => {
    const actions = callbacks()
    render(<PluginManagerPanel phase="ready" packages={[installed]} {...actions} />)

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('timeout')).toBeInTheDocument()
  })

  test('highlights only the app-selected plugin without creating local selection state', () => {
    const actions = callbacks()
    const second = {
      ...installed,
      id: 'com.example.second',
      name: 'Second Plugin',
      packageDigest: 'sha256:second',
    }
    const { rerender } = render(
      <PluginManagerPanel
        phase="ready"
        packages={[installed, second]}
        selectedPluginId={second.id}
        {...actions}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Second Plugin', level: 3 }).closest('li')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByRole('heading', { name: 'Soft Sparkle', level: 3 }).closest('li')).not.toHaveAttribute(
      'aria-current',
    )

    rerender(
      <PluginManagerPanel
        phase="ready"
        packages={[installed, second]}
        selectedPluginId={installed.id}
        {...actions}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Soft Sparkle', level: 3 }).closest('li')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByRole('heading', { name: 'Second Plugin', level: 3 }).closest('li')).not.toHaveAttribute(
      'aria-current',
    )
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

  test('shows projected pending state and supports repeated clear failure recovery', () => {
    const actions = callbacks()
    const { rerender } = render(
      <PluginManagerPanel phase="ready" packages={[installed]} {...actions} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear diagnostics' }))
    expect(actions.onClearDiagnostics).toHaveBeenCalledTimes(1)

    rerender(
      <PluginManagerPanel
        phase="ready"
        packages={[{
          ...installed,
          actions: {
            ...installed.actions,
            clearDiagnostics: action(true, { pending: true }),
          },
        }]}
        {...actions}
      />,
    )
    expect(screen.getByRole('button', { name: 'Clearing Soft Sparkle diagnostics…' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Clearing Soft Sparkle diagnostics')

    rerender(
      <PluginManagerPanel
        phase="ready"
        packages={[{
          ...installed,
          actions: {
            ...installed.actions,
            clearDiagnostics: action(true, { error: 'First clear failed.' }),
          },
        }]}
        {...actions}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('First clear failed')
    fireEvent.click(screen.getByRole('button', { name: 'Clear diagnostics' }))
    expect(actions.onClearDiagnostics).toHaveBeenCalledTimes(2)

    rerender(
      <PluginManagerPanel
        phase="ready"
        packages={[{
          ...installed,
          actions: {
            ...installed.actions,
            clearDiagnostics: action(true, { error: 'Second clear failed.' }),
          },
        }]}
        {...actions}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Second clear failed')
  })
})
