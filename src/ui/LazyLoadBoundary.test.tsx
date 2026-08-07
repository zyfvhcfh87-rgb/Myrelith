import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import LazyLoadBoundary from './LazyLoadBoundary'
import LazySurfaceBoundary from './LazySurfaceBoundary'

function Surface({ fail }: { fail: boolean }) {
  if (fail) throw new Error('chunk failed')
  return <div>Loaded surface</div>
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
    fireEvent.click(screen.getByRole('button', { name: 'Reload WebCut' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(reload).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
