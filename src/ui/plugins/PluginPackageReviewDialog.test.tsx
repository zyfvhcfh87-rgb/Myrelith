import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import PluginPackageReviewDialog from './PluginPackageReviewDialog'
import type { PluginPackageReviewView } from './pluginUiTypes'

const packageView: PluginPackageReviewView = {
  id: 'com.example.sparkle',
  name: 'Soft Sparkle',
  version: '1.2.0',
  installedVersion: null,
  versionChange: 'new-install',
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
      selectedVersion: '1',
      detail: 'When enabled, this effect receives the pixels of each frame it is applied to.',
      required: true,
      available: true,
      grantable: true,
      grantState: 'new',
    },
    {
      id: 'example.optional',
      name: 'Optional test permission',
      selectedVersion: '2',
      detail: 'This optional permission is not required for installation.',
      required: false,
      available: true,
      grantable: true,
      grantState: 'new',
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
    expect(screen.getByText('myrelith.effect.video-frame.rgba8@1')).toBeInTheDocument()
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
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })
  })

  test('shows installed update facts from the app projection', () => {
    render(
      <PluginPackageReviewDialog
        phase="review"
        packageView={{
          ...packageView,
          version: '1.3.0',
          installedVersion: '1.2.0',
          versionChange: 'update',
          packageDigest: 'sha256:update',
        }}
        onCancel={vi.fn()}
        onInstall={vi.fn()}
      />,
    )

    expect(screen.getByText('1.2.0')).toBeInTheDocument()
    expect(screen.getByText('Update from 1.2.0')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Replace this installed same-version package/i })).not.toBeInTheDocument()
  })

  test('keeps an ordinary same-package reinstall distinct from replacement', () => {
    render(
      <PluginPackageReviewDialog
        phase="review"
        packageView={{
          ...packageView,
          installedVersion: '1.2.0',
          versionChange: 'reinstall',
          trustState: 'user-trusted',
        }}
        onCancel={vi.fn()}
        onInstall={vi.fn()}
      />,
    )

    expect(screen.getByText('Reinstall 1.2.0')).toBeInTheDocument()
    expect(screen.queryByText(/Same-version package replacement requires/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Replace this installed same-version package/i })).not.toBeInTheDocument()
  })

  test('requires a distinct same-version replacement decision and emits only that confirmation', () => {
    const onInstall = vi.fn()
    render(
      <PluginPackageReviewDialog
        phase="review"
        packageView={{
          ...packageView,
          installedVersion: '1.2.0',
          versionChange: 'same-version-replacement',
          packageDigest: 'sha256:replacement',
          trustState: 'user-trusted',
          permissions: packageView.permissions.map((permission) => ({
            ...permission,
            grantState: 'preserved',
          })),
        }}
        onCancel={vi.fn()}
        onInstall={onInstall}
      />,
    )

    expect(screen.getByText('Same-version replacement of 1.2.0')).toBeInTheDocument()
    expect(screen.getByText(/package identity differs/i)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Install this older package version/i })).not.toBeInTheDocument()
    const install = screen.getByRole('button', { name: 'Install plugin' })
    expect(install).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Confirm the exact same-version package replacement')

    fireEvent.click(screen.getByRole('checkbox', {
      name: /Replace this installed same-version package/i,
    }))
    expect(install).toBeEnabled()
    fireEvent.click(install)

    expect(onInstall).toHaveBeenCalledWith({
      trustSigner: false,
      grantedPermissionIds: [
        'myrelith.effect.video-frame.rgba8',
        'example.optional',
      ],
      confirmDowngrade: false,
      confirmSameVersionReplacement: true,
    })
  })

  test('preserves prior grants, identifies widened grants, blocks unavailable options, and requires downgrade confirmation', () => {
    const onInstall = vi.fn()
    const downgradeView: PluginPackageReviewView = {
      ...packageView,
      version: '1.1.0',
      installedVersion: '1.2.0',
      versionChange: 'downgrade',
      packageDigest: 'sha256:downgrade',
      trustState: 'user-trusted',
      permissions: [
        {
          ...packageView.permissions[0],
          grantState: 'preserved',
        },
        {
          ...packageView.permissions[1],
          grantState: 'widened',
        },
        {
          id: 'example.unavailable',
          name: 'Unavailable optional capability',
          selectedVersion: null,
          detail: 'The current host cannot provide this optional capability.',
          required: false,
          available: false,
          grantable: true,
          grantState: 'unavailable',
          unavailableReason: 'This browser does not expose the required primitive.',
        },
        {
          id: 'example.changed',
          name: 'Changed optional capability',
          selectedVersion: '1',
          detail: 'The requested range changed without widening access.',
          required: false,
          available: true,
          grantable: true,
          grantState: 'changed',
        },
      ],
    }
    render(
      <PluginPackageReviewDialog
        phase="review"
        packageView={downgradeView}
        onCancel={vi.fn()}
        onInstall={onInstall}
      />,
    )

    expect(screen.getByText('Downgrade from 1.2.0')).toBeInTheDocument()
    expect(screen.getByText('Previously granted and preserved')).toBeInTheDocument()
    expect(screen.getByText('Widened grant request')).toBeInTheDocument()
    expect(screen.getByText('Changed grant request')).toBeInTheDocument()
    expect(screen.getByText('Grant unavailable')).toBeInTheDocument()
    const priorGrant = screen.getByRole('checkbox', { name: /Read and change applied video frames/i })
    expect(priorGrant).toBeChecked()
    const unavailable = screen.getByRole('checkbox', { name: /Unavailable optional capability/i })
    expect(unavailable).toBeDisabled()
    expect(unavailable).not.toBeChecked()
    expect(screen.getByText('No compatible version selected')).toBeInTheDocument()
    expect(screen.getByText('Not grantable')).toBeInTheDocument()

    const install = screen.getByRole('button', { name: 'Install plugin' })
    expect(install).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Install this older package version/i }))
    expect(install).toBeEnabled()
    fireEvent.click(install)

    expect(onInstall).toHaveBeenCalledWith({
      trustSigner: false,
      grantedPermissionIds: ['myrelith.effect.video-frame.rgba8'],
      confirmDowngrade: true,
      confirmSameVersionReplacement: false,
    })
    expect(screen.getByText(/Plugin access stops while the plugin is disabled/i)).toBeInTheDocument()
    expect(screen.getByText(/uninstalling removes the local package and grants/i)).toBeInTheDocument()
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
