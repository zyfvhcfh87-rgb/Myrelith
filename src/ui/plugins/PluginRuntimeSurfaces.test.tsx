import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import PluginExportBlockDialog, { PluginExportBlockBody } from './PluginExportBlockDialog'
import PluginInspectorStatus from './PluginInspectorStatus'
import PluginPreviewNotice from './PluginPreviewNotice'
import PluginSafeModeCard from './PluginSafeModeCard'
import type {
  PluginActionView,
  PluginEffectIssueView,
  PluginPreviewIssueView,
  PluginRecoveryActionsView,
} from './pluginUiTypes'

function action(
  available: boolean,
  overrides: Partial<PluginActionView> = {},
): PluginActionView {
  return { available, pending: false, ...overrides }
}

const issues: readonly PluginEffectIssueView[] = [
  {
    effectInstanceId: 'effect-1',
    effectLabel: 'Soft Sparkle',
    pluginId: 'com.example.sparkle',
    pluginName: 'Sparkle Pack',
    pluginVersion: '1.2.0',
    packageDigest: 'sha256:sparkle',
    status: 'failed',
    reason: 'The plugin exceeded the preview watchdog.',
    blocksExport: true,
  },
  {
    effectInstanceId: 'effect-2',
    effectLabel: 'Quiet Glow',
    pluginId: 'com.example.glow',
    pluginName: 'Glow Pack',
    pluginVersion: '2.0.0',
    packageDigest: 'sha256:glow',
    status: 'missing',
    reason: 'The required local package is not installed.',
    blocksExport: true,
  },
]

const recoveryActions: PluginRecoveryActionsView = {
  retry: action(true),
  disable: action(true),
  manage: action(true),
}

describe('Issue 77 runtime UI surfaces', () => {
  test('enters launcher safe mode once and locks the enabled session', () => {
    const onEnterSafeMode = vi.fn()
    const { rerender } = render(
      <PluginSafeModeCard
        enabled={false}
        recommended
        recommendationReason="A previous plugin activation did not finish."
        installedPluginCount={2}
        onEnterSafeMode={onEnterSafeMode}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('previous plugin activation')
    fireEvent.click(screen.getByRole('button', { name: 'Enter safe mode' }))
    expect(onEnterSafeMode).toHaveBeenCalledOnce()

    rerender(
      <PluginSafeModeCard
        enabled
        recommended={false}
        installedPluginCount={2}
        onEnterSafeMode={onEnterSafeMode}
      />,
    )
    const active = screen.getByRole('button', { name: 'Safe mode active' })
    expect(active).toBeDisabled()
    expect(screen.getByText(/Restart the editor or begin a new session without safe mode to leave it/i)).toBeInTheDocument()
    fireEvent.click(active)
    expect(onEnterSafeMode).toHaveBeenCalledOnce()
  })

  test('uses projected preview actions and announces only a compact atomic summary', () => {
    const onRetryPlugin = vi.fn()
    const onDisablePlugin = vi.fn()
    const onManagePlugins = vi.fn()
    const previewIssues: readonly PluginPreviewIssueView[] = [
      {
        ...issues[0],
        actions: {
          retry: action(false),
          disable: action(true, { disabledReason: 'Disable is locked during recovery.' }),
        },
      },
      {
        ...issues[1],
        actions: {
          retry: action(true),
          disable: action(false),
        },
      },
    ]
    render(
      <PluginPreviewNotice
        issues={previewIssues}
        manageAction={action(true)}
        onRetryPlugin={onRetryPlugin}
        onDisablePlugin={onDisablePlugin}
        onManagePlugins={onManagePlugins}
      />,
    )

    expect(screen.getByRole('heading', { name: '2 plugin effects unavailable' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('2 plugin effects bypassed. Export blockers: 2.')
    expect(screen.queryByRole('button', { name: 'Retry Sparkle Pack' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disable Sparkle Pack' })).toBeDisabled()
    expect(screen.getByText('Disable is locked during recovery.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry Glow Pack' }))
    expect(onRetryPlugin).toHaveBeenCalledWith('com.example.glow')
    fireEvent.click(screen.getByRole('button', { name: 'Manage plugins' }))
    expect(onManagePlugins).toHaveBeenCalledOnce()
    expect(document.querySelector('.plugin-preview-notice')).not.toHaveAttribute('aria-live')
  })

  test('keeps Inspector action policy entirely app-projected', () => {
    const onRetryPlugin = vi.fn()
    const onDisablePlugin = vi.fn()
    const onManagePlugin = vi.fn()
    render(
      <PluginInspectorStatus
        effect={issues[0]}
        actions={{
          ...recoveryActions,
          retry: action(false),
          disable: action(true, { disabledReason: 'The package is already being revoked.' }),
          manage: action(true, { pending: true }),
        }}
        onRetryPlugin={onRetryPlugin}
        onDisablePlugin={onDisablePlugin}
        onManagePlugin={onManagePlugin}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Soft Sparkle' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disable plugin' })).toBeDisabled()
    expect(screen.getByText('The package is already being revoked.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Opening Sparkle Pack management…' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Opening Sparkle Pack management')
  })

  test('displays exact package identity and returns the opaque app-minted review token', () => {
    const onExportBypassed = vi.fn()
    render(
      <PluginExportBlockDialog
        issues={issues}
        reviewToken="opaque-review-token-1"
        documentRevision="document-revision-1"
        onCancel={vi.fn()}
        onExportBypassed={onExportBypassed}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Plugin effects block export')
    expect(screen.getByText(
      'No decoder, encoder, or media pipeline started. Fix the listed effects, or explicitly review a one-time bypass.',
    )).toBeInTheDocument()
    expect(screen.getByText('com.example.sparkle')).toBeInTheDocument()
    expect(screen.getByText('sha256:sparkle')).toBeInTheDocument()
    expect(screen.getByText('1.2.0')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review bypass…' }))
    expect(screen.getByRole('button', { name: 'Back to blocked effects' })).toHaveFocus()
    fireEvent.click(screen.getByRole('checkbox', {
      name: /I understand these exact effects and packages will be omitted/i,
    }))
    fireEvent.click(screen.getByRole('button', {
      name: 'Export with listed plugins bypassed',
    }))

    expect(onExportBypassed).toHaveBeenCalledWith('opaque-review-token-1')
  })

  test('provides a semantic inline body without a nested modal or fixed backdrop', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = render(
      <PluginExportBlockBody
        issues={issues}
        reviewToken="opaque-inline-token"
        documentRevision="document-revision-inline"
        onCancel={vi.fn()}
        onExportBypassed={vi.fn()}
      />,
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Plugin effects block export' })).toBeInTheDocument()
    expect(document.querySelector('.plugin-dialog-backdrop')).toBeNull()
    expect(document.querySelector('.plugin-export-inline')).toBeInTheDocument()
    expect(trigger).toHaveFocus()
    unmount()
    trigger.remove()
  })

  test('invalidates local confirmation when document, status, reason, or digest inputs change', () => {
    const onExportBypassed = vi.fn()
    const baseProps = {
      reviewToken: 'opaque-stale-token',
      documentRevision: 'document-revision-1',
      onCancel: vi.fn(),
      onExportBypassed,
    }
    const { rerender } = render(<PluginExportBlockDialog issues={issues} {...baseProps} />)

    const enterAndConfirm = (): void => {
      fireEvent.click(screen.getByRole('button', { name: 'Review bypass…' }))
      fireEvent.click(screen.getByRole('checkbox', {
        name: /I understand these exact effects and packages will be omitted/i,
      }))
      expect(screen.getByRole('button', { name: 'Export with listed plugins bypassed' })).toBeEnabled()
    }
    const expectReset = (): void => {
      expect(screen.getByRole('button', { name: 'Review bypass…' })).toBeInTheDocument()
      expect(screen.queryByRole('checkbox', {
        name: /I understand these exact effects and packages will be omitted/i,
      })).not.toBeInTheDocument()
    }

    enterAndConfirm()
    rerender(
      <PluginExportBlockDialog
        issues={issues}
        {...baseProps}
        documentRevision="document-revision-2"
      />,
    )
    expectReset()

    enterAndConfirm()
    const statusChanged = [{ ...issues[0], status: 'incompatible' as const }, issues[1]]
    rerender(<PluginExportBlockDialog issues={statusChanged} {...baseProps} documentRevision="document-revision-2" />)
    expectReset()

    enterAndConfirm()
    const reasonChanged = [{ ...statusChanged[0], reason: 'A different bounded failure reason.' }, issues[1]]
    rerender(<PluginExportBlockDialog issues={reasonChanged} {...baseProps} documentRevision="document-revision-2" />)
    expectReset()

    enterAndConfirm()
    const digestChanged = [{ ...reasonChanged[0], packageDigest: 'sha256:replacement' }, issues[1]]
    rerender(
      <PluginExportBlockDialog
        issues={digestChanged}
        {...baseProps}
        reviewToken="opaque-current-token"
        documentRevision="document-revision-2"
      />,
    )
    expectReset()

    enterAndConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Export with listed plugins bypassed' }))
    expect(onExportBypassed).toHaveBeenCalledWith('opaque-current-token')
    expect(onExportBypassed).not.toHaveBeenCalledWith('opaque-stale-token')
  })

  test('Escape cancels export preflight without leaking editor shortcuts', () => {
    const onCancel = vi.fn()
    const leakedShortcut = vi.fn()
    window.addEventListener('keydown', leakedShortcut)
    render(
      <PluginExportBlockDialog
        issues={issues}
        reviewToken="opaque-escape-token"
        documentRevision="document-revision-escape"
        onCancel={onCancel}
        onExportBypassed={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 's' })
    expect(leakedShortcut).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
    window.removeEventListener('keydown', leakedShortcut)
  })
})
