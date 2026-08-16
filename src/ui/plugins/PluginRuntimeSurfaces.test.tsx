import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  test('keeps clean startup optional and locks one-way safe mode for the session', () => {
    const onEnterSafeMode = vi.fn()
    const { rerender } = render(
      <PluginSafeModeCard
        startupMode="normal"
        installedPluginCount={2}
        enterSafeModeAction={action(true)}
        onEnterSafeMode={onEnterSafeMode}
      />,
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue normally after review' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enter safe mode' }))
    expect(onEnterSafeMode).toHaveBeenCalledOnce()

    rerender(
      <PluginSafeModeCard
        startupMode="safe-mode"
        installedPluginCount={2}
      />,
    )
    const active = screen.getByRole('button', { name: 'Safe mode active' })
    expect(active).toBeDisabled()
    expect(screen.getByText(/Restart the editor or begin a new session without safe mode to leave it/i)).toBeInTheDocument()
    fireEvent.click(active)
    expect(onEnterSafeMode).toHaveBeenCalledOnce()
  })

  test('offers reviewed normal startup beside safe mode with native keyboard focus order', async () => {
    const user = userEvent.setup()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const onEnterSafeMode = vi.fn()
    const onContinueReviewedNormal = vi.fn()
    const { unmount } = render(
      <PluginSafeModeCard
        startupMode="review-required"
        startupReason="A previous plugin activation did not finish cleanly."
        installedPluginCount={2}
        enterSafeModeAction={action(true)}
        continueReviewedNormalAction={action(true)}
        onEnterSafeMode={onEnterSafeMode}
        onContinueReviewedNormal={onContinueReviewedNormal}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('previous plugin activation')
    expect(screen.getByRole('status')).toHaveTextContent('Choose reviewed normal startup or safe mode')
    await user.tab()
    expect(screen.getByRole('button', { name: 'Enter safe mode' })).toHaveFocus()
    await user.tab()
    const continueNormally = screen.getByRole('button', { name: 'Continue normally after review' })
    expect(continueNormally).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onContinueReviewedNormal).toHaveBeenCalledOnce()
    expect(onEnterSafeMode).not.toHaveBeenCalled()

    screen.getByRole('button', { name: 'Enter safe mode' }).focus()
    await user.keyboard(' ')
    expect(onEnterSafeMode).toHaveBeenCalledOnce()

    unmount()
    trigger.remove()
  })

  test('honors projected unavailable, busy, and error actions while safe-only startup stays locked', () => {
    const onEnterSafeMode = vi.fn()
    const onContinueReviewedNormal = vi.fn()
    const { rerender } = render(
      <PluginSafeModeCard
        startupMode="review-required"
        startupReason="Review is required before plugin initialization."
        installedPluginCount={1}
        enterSafeModeAction={action(true, { pending: true })}
        continueReviewedNormalAction={action(false)}
        onEnterSafeMode={onEnterSafeMode}
        onContinueReviewedNormal={onContinueReviewedNormal}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Continue normally after review' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Entering safe modeâ€¦' })).toBeDisabled()
    expect(screen.getAllByRole('status').some((node) => node.textContent === 'Entering safe modeâ€¦')).toBe(true)

    rerender(
      <PluginSafeModeCard
        startupMode="review-required"
        startupReason="Review is required before plugin initialization."
        installedPluginCount={1}
        enterSafeModeAction={action(true, {
          disabledReason: 'Safe-mode preparation is temporarily unavailable.',
          error: 'The last safe-mode request did not complete.',
        })}
        continueReviewedNormalAction={action(false)}
        onEnterSafeMode={onEnterSafeMode}
        onContinueReviewedNormal={onContinueReviewedNormal}
      />,
    )

    expect(screen.getByRole('button', { name: 'Enter safe mode' })).toBeDisabled()
    expect(screen.getByText('Safe-mode preparation is temporarily unavailable.')).toBeInTheDocument()
    expect(screen.getAllByRole('alert').some((node) => (
      node.textContent?.includes('last safe-mode request did not complete') ?? false
    ))).toBe(true)

    rerender(
      <PluginSafeModeCard
        startupMode="safe-mode"
        startupReason="Plugin safety storage is unavailable."
        installedPluginCount={1}
      />,
    )

    expect(screen.getByRole('button', { name: 'Safe mode active' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Enter safe mode' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue normally after review' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Plugin safety storage is unavailable')
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
