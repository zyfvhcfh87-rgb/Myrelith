import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import PluginExportBlockDialog from './PluginExportBlockDialog'
import PluginInspectorStatus from './PluginInspectorStatus'
import PluginPreviewNotice from './PluginPreviewNotice'
import PluginSafeModeCard from './PluginSafeModeCard'
import type { PluginEffectIssueView } from './pluginUiTypes'

const issues: readonly PluginEffectIssueView[] = [
  {
    effectInstanceId: 'effect-1',
    effectLabel: 'Soft Sparkle',
    pluginId: 'com.example.sparkle',
    pluginName: 'Sparkle Pack',
    status: 'failed',
    reason: 'The plugin exceeded the preview watchdog.',
    blocksExport: true,
  },
  {
    effectInstanceId: 'effect-2',
    effectLabel: 'Quiet Glow',
    pluginId: 'com.example.glow',
    pluginName: 'Glow Pack',
    status: 'missing',
    reason: 'The required local package is not installed.',
    blocksExport: true,
  },
]

describe('Issue 77 runtime UI surfaces', () => {
  test('offers a controlled launcher safe-mode choice with crash recovery context', () => {
    const onChange = vi.fn()
    render(
      <PluginSafeModeCard
        enabled={false}
        recommended
        recommendationReason="A previous plugin activation did not finish."
        installedPluginCount={2}
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('previous plugin activation')
    const toggle = screen.getByRole('checkbox', { name: /Open this editor session in safe mode/i })
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
    expect(screen.getByText(/effect records remain available/i)).toBeInTheDocument()
  })

  test('makes preview bypass and recovery actions visible', () => {
    const onRetryPlugin = vi.fn()
    const onDisablePlugin = vi.fn()
    const onManagePlugins = vi.fn()
    render(
      <PluginPreviewNotice
        issues={issues}
        onRetryPlugin={onRetryPlugin}
        onDisablePlugin={onDisablePlugin}
        onManagePlugins={onManagePlugins}
      />,
    )

    expect(screen.getByRole('heading', { name: '2 plugin effects unavailable' })).toBeInTheDocument()
    expect(screen.getByText(/2 effects block export/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry Sparkle Pack' }))
    expect(onRetryPlugin).toHaveBeenCalledWith('com.example.sparkle')
    fireEvent.click(screen.getByRole('button', { name: 'Manage plugins' }))
    expect(onManagePlugins).toHaveBeenCalledOnce()
  })

  test('keeps Inspector plugin status prop-driven and actionable', () => {
    const onRetryPlugin = vi.fn()
    const onDisablePlugin = vi.fn()
    const onManagePlugin = vi.fn()
    render(
      <PluginInspectorStatus
        effect={issues[0]}
        onRetryPlugin={onRetryPlugin}
        onDisablePlugin={onDisablePlugin}
        onManagePlugin={onManagePlugin}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Soft Sparkle' })).toBeInTheDocument()
    expect(screen.getByText(/descriptor is preserved and preview is bypassed/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disable plugin' }))
    expect(onDisablePlugin).toHaveBeenCalledWith('com.example.sparkle')
    fireEvent.click(screen.getByRole('button', { name: 'Manage plugin' }))
    expect(onManagePlugin).toHaveBeenCalledWith('com.example.sparkle')
  })

  test('requires a second exact-instance confirmation before bypassed export', () => {
    const onCancel = vi.fn()
    const onExportBypassed = vi.fn()
    render(
      <PluginExportBlockDialog
        issues={issues}
        onCancel={onCancel}
        onExportBypassed={onExportBypassed}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Plugin effects block export')
    expect(screen.getByRole('button', { name: 'Back to editor' })).toHaveFocus()
    expect(screen.getByText(/did not acquire an output file or start an encoder/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review bypass…' }))

    const confirmExport = screen.getByRole('button', {
      name: 'Export with listed plugins bypassed',
    })
    expect(confirmExport).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', {
      name: /I understand these exact effects will be omitted/i,
    }))
    expect(confirmExport).toBeEnabled()
    fireEvent.click(confirmExport)

    expect(onExportBypassed).toHaveBeenCalledWith(['effect-1', 'effect-2'])
  })

  test('Escape cancels export preflight without leaking editor shortcuts', () => {
    const onCancel = vi.fn()
    const leakedShortcut = vi.fn()
    window.addEventListener('keydown', leakedShortcut)
    render(
      <PluginExportBlockDialog
        issues={issues}
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
