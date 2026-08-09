import { act, fireEvent, render, screen } from '@testing-library/react'
import { lazy, type ComponentType } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { EditorSurface } from './App'
import type { EditorShellProps } from './EditorShell'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('editor lazy boundary', () => {
  test('shows a small accessible wait state until the editor module resolves', async () => {
    let resolveEditor!: (module: {
      default: ComponentType<EditorShellProps>
    }) => void
    const DeferredEditor = lazy(() => new Promise<{
      default: ComponentType<EditorShellProps>
    }>((resolve) => {
      resolveEditor = resolve
    }))

    render(<EditorSurface closing={false} editor={DeferredEditor} />)

    expect(screen.getByRole('status')).toHaveTextContent('Opening your studio')
    await act(async () => {
      resolveEditor({
        default: ({ closing }) => (
          <div data-testid="editor-ready">{closing ? 'closing' : 'ready'}</div>
        ),
      })
      await Promise.resolve()
    })
    expect(await screen.findByTestId('editor-ready')).toHaveTextContent('ready')
  })

  test('offers an actionable reload when the editor module fails', () => {
    const reload = vi.fn()
    const BrokenEditor = () => {
      throw new Error('stale chunk')
    }
    render(
      <EditorSurface
        closing={false}
        editor={BrokenEditor}
        onReload={reload}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'We couldn’t load the editing tools',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload Myrelith' }))
    expect(reload).toHaveBeenCalledOnce()
  })
})
