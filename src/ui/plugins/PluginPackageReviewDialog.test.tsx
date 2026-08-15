import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import PluginPackageReviewDialog from './PluginPackageReviewDialog'
import type { PluginPackageReviewView } from './pluginUiTypes'

const packageView: PluginPackageReviewView = {
  id: 'com.example.sparkle',
  name: 'Soft Sparkle',
  version: '1.2.0',
  signerFingerprint: 'sha256:1234abcd',
  packageDigest: 'sha256:fedcba98',
  signatureState: 'valid',
  trustState: 'untrusted',
  compatibilityState: 'compatible',
  compatibilityReasons: [],
  permissions: [
    {
      id: 'myrelith.effect.video-frame.rgba8',
      name: 'Read and change applied video frames',
      detail: 'When enabled, this effect receives the pixels of each frame it is applied to.',
      required: true,
    },
    {
      id: 'example.optional',
      name: 'Optional test permission',
      detail: 'This optional permission is not required for installation.',
      required: false,
    },
  ],
  contributionNames: ['Soft Sparkle'],
  memoryLimitMiB: 32,
  failurePolicy: 'Bypass preview; block export until reviewed.',
}

describe('PluginPackageReviewDialog', () => {
  test('keeps trust and required frame access explicit before installation', () => {
    const onInstall = vi.fn()
    render(
      <PluginPackageReviewDialog
        phase="review"
        packageView={packageView}
        onCancel={vi.fn()}
        onInstall={onInstall}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Review Soft Sparkle')
    expect(screen.getByText(/does not certify the publisher, code quality, privacy, or safety/i)).toBeInTheDocument()
    const install = screen.getByRole('button', { name: 'Install plugin' })
    expect(install).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', {
      name: /Trust this signer for com\.example\.sparkle/i,
    }))
    expect(install).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', {
      name: /Read and change applied video frames/i,
    }))
    expect(install).toBeEnabled()
    fireEvent.click(install)

    expect(onInstall).toHaveBeenCalledWith({
      trustSigner: true,
      grantedPermissionIds: ['myrelith.effect.video-frame.rgba8'],
    })
  })

  test('shows incompatibility as inspectable text and never creates plugin markup', () => {
    render(
      <PluginPackageReviewDialog
        phase="review"
        packageView={{
          ...packageView,
          name: '<img src=x onerror=alert(1)>',
          compatibilityState: 'incompatible',
          compatibilityReasons: ['Required host API version 9 is unavailable.'],
        }}
        onCancel={vi.fn()}
        onInstall={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', {
      name: 'Review <img src=x onerror=alert(1)>',
    })).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('Required host API version 9 is unavailable.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install plugin' })).toBeDisabled()
  })

  test('contains keyboard events, cancels with Escape, and restores prior focus', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const onCancel = vi.fn()
    const leakedShortcut = vi.fn()
    window.addEventListener('keydown', leakedShortcut)

    const { unmount } = render(
      <PluginPackageReviewDialog
        phase="review"
        packageView={packageView}
        onCancel={onCancel}
        onInstall={vi.fn()}
      />,
    )
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 's' })
    expect(leakedShortcut).not.toHaveBeenCalled()
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()

    unmount()
    expect(trigger).toHaveFocus()
    window.removeEventListener('keydown', leakedShortcut)
    trigger.remove()
  })

  test('makes inspection cancellation and error recovery observable', () => {
    const onCancel = vi.fn()
    const onRetry = vi.fn()
    const { rerender } = render(
      <PluginPackageReviewDialog
        phase="inspecting"
        packageView={null}
        onCancel={onCancel}
        onInstall={vi.fn()}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('archive limits')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel inspection' }))
    expect(onCancel).toHaveBeenCalledOnce()

    rerender(
      <PluginPackageReviewDialog
        phase="error"
        packageView={null}
        error="Archive contains an extra entry."
        onCancel={onCancel}
        onRetry={onRetry}
        onInstall={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('extra entry')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
