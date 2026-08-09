import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import ToolButtons from './ToolButtons'

beforeEach(() => {
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
  })
})

describe('ToolButtons command discovery', () => {
  test('shortcut-bearing tooltips expose the same keys to assistive technology', () => {
    render(<ToolButtons />)
    expect(screen.getByRole('button', { name: /Select.*\(A\)/ }))
      .toHaveAttribute('aria-keyshortcuts', 'A')
    expect(screen.getByRole('button', { name: /Razor.*\(B\)/ }))
      .toHaveAttribute('aria-keyshortcuts', 'B')
    expect(screen.getByRole('button', { name: /Ripple trim.*\(T\)/ }))
      .toHaveAttribute('aria-keyshortcuts', 'T')
    expect(screen.getByRole('button', { name: /Slip.*\(Y\)/ }))
      .toHaveAttribute('aria-keyshortcuts', 'Y')
    expect(screen.getByRole('button', { name: /Slide.*\(U\)/ }))
      .toHaveAttribute('aria-keyshortcuts', 'U')
  })

  test('buttons still switch the real transport tool', () => {
    render(<ToolButtons />)
    fireEvent.click(screen.getByRole('button', { name: /Razor.*\(B\)/ }))
    expect(useTransportStore.getState().tool).toBe('razor')
  })
})
