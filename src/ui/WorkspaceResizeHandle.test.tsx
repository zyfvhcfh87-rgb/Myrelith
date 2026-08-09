import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import WorkspaceResizeHandle from './WorkspaceResizeHandle'

function renderHandle(update: Partial<ComponentProps<
  typeof WorkspaceResizeHandle
>> = {}) {
  const props: ComponentProps<typeof WorkspaceResizeHandle> = {
    label: 'Resize Media panel',
    controls: 'workspace-media-panel',
    orientation: 'vertical',
    value: 300,
    min: 180,
    max: 520,
    direction: 1,
    onPreview: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    onAnnounce: vi.fn(),
    ...update,
  }
  return { props, ...render(<WorkspaceResizeHandle {...props} />) }
}

describe('WorkspaceResizeHandle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('exposes separator values and keyboard resizing', () => {
    const { props } = renderHandle()
    const handle = screen.getByRole('separator', { name: 'Resize Media panel' })
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('aria-controls', 'workspace-media-panel')
    expect(handle).toHaveAttribute('aria-valuenow', '300')
    expect(handle).toHaveAttribute('aria-valuetext', '300 pixels')

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(props.onCommit).toHaveBeenCalledWith(316)
    expect(props.onAnnounce).toHaveBeenCalledWith(
      'Resize Media panel set to 316 pixels.',
    )
    fireEvent.keyDown(handle, { key: 'End' })
    expect(props.onCommit).toHaveBeenLastCalledWith(520)
  })

  test('uses physical direction for the right and horizontal handles', () => {
    const right = renderHandle({ direction: -1 })
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
    expect(right.props.onCommit).toHaveBeenCalledWith(316)
    right.unmount()

    const timeline = renderHandle({
      label: 'Resize Timeline panel',
      orientation: 'horizontal',
      direction: -1,
    })
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
    expect(timeline.props.onCommit).toHaveBeenCalledWith(316)
  })

  test('restores a collapsed panel from its minimum with the keyboard', () => {
    const { props } = renderHandle({ value: 0 })
    const handle = screen.getByRole('separator')
    expect(handle).toHaveAttribute('aria-valuetext', 'Resize Media panel collapsed')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(props.onCommit).toHaveBeenCalledWith(180)
  })

  test('previews pointer movement and commits once on release', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const { props } = renderHandle()
    const handle = screen.getByRole('separator')

    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 100 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 140 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 140 })

    expect(props.onPreview).toHaveBeenCalledWith(340)
    expect(props.onCommit).toHaveBeenCalledTimes(1)
    expect(props.onCommit).toHaveBeenCalledWith(340)
  })

  test('cancels a pointer gesture without committing it', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const { props } = renderHandle()
    const handle = screen.getByRole('separator')

    fireEvent.pointerDown(handle, { button: 0, pointerId: 9, clientX: 100 })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 140 })
    fireEvent.pointerCancel(window, { pointerId: 9 })

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onCommit).not.toHaveBeenCalled()
  })

  test('removes a disabled handle from the tab order', () => {
    renderHandle({ disabled: true })
    const handle = screen.getByRole('separator')
    expect(handle).toHaveAttribute('aria-disabled', 'true')
    expect(handle).toHaveAttribute('tabindex', '-1')
  })
})
