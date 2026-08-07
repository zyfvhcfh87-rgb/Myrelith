import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import LazyLoadBoundary from './LazyLoadBoundary'
import LazySurfaceBoundary from './LazySurfaceBoundary'

function Surface({ fail }: { fail: boolean }) {
  if (fail) throw new Error('chunk failed')
  return <div>Loaded surface</div>
}

const pendingSurface = new Promise<never>(() => {})

function PendingSurface(): never {
  throw pendingSurface
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('LazyLoadBoundary', () => {
  test('contains a module failure and resets only when its key changes', async () => {
    const view = render(
      <LazyLoadBoundary fallback={<div role="alert">Could not load</div>} resetKey={0}>
        <Surface fail />
      </LazyLoadBoundary>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load')
    view.rerender(
      <LazyLoadBoundary fallback={<div role="alert">Could not load</div>} resetKey={1}>
        <Surface fail={false} />
      </LazyLoadBoundary>,
    )

    expect(await screen.findByText('Loaded surface')).toBeInTheDocument()
  })

  test('contains a secondary-surface failure and exposes close and reload actions', () => {
    const close = vi.fn()
    const reload = vi.fn()
    render(
      <LazySurfaceBoundary
        variant="dialog"
        loadingLabel="Loading export tools…"
        failureTitle="Export tools could not load"
        onClose={close}
        onReload={reload}
      >
        <Surface fail />
      </LazySurfaceBoundary>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Export tools could not load',
    )
    const closeButton = screen.getByRole('button', { name: 'Close' })
    const shortcut = vi.fn()
    window.addEventListener('keydown', shortcut)
    expect(closeButton).toHaveFocus()
    fireEvent.keyDown(closeButton, { key: 's' })
    expect(shortcut).not.toHaveBeenCalled()
    window.removeEventListener('keydown', shortcut)
    fireEvent.click(screen.getByRole('button', { name: 'Reload WebCut' }))
    fireEvent.click(closeButton)
    expect(reload).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  test('moves focus into a loading dialog and contains editor shortcuts', () => {
    const shortcut = vi.fn()
    window.addEventListener('keydown', shortcut)
    const view = render(<button type="button">Editor toolbar</button>)
    const toolbarButton = screen.getByRole('button', { name: 'Editor toolbar' })
    toolbarButton.focus()
    expect(toolbarButton).toHaveFocus()

    view.rerender(
      <>
        <button type="button">Editor toolbar</button>
        <LazySurfaceBoundary
          variant="dialog"
          loadingLabel="Loading export toolsâ€¦"
          failureTitle="Export tools could not load"
        >
          <PendingSurface />
        </LazySurfaceBoundary>
      </>,
    )

    const dialog = screen.getByRole('dialog', {
      name: 'Loading export toolsâ€¦',
    })
    expect(dialog).toHaveFocus()
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
    expect(dialog).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Delete' })
    expect(shortcut).not.toHaveBeenCalled()
    window.removeEventListener('keydown', shortcut)
  })
})
