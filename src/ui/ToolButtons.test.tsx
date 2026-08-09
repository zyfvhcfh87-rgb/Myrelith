import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import {
  INITIAL_PREFERENCES_STATE,
  usePreferencesStore,
} from '../state/preferencesStore'
import ToolButtons from './ToolButtons'

beforeEach(() => {
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
  usePreferencesStore.setState({ ...INITIAL_PREFERENCES_STATE })
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

  test('the persistent snap preference is a named pressed control with its Alt override', () => {
    render(<ToolButtons />)
    const snapping = screen.getByRole('button', { name: /Snapping on.*Alt/ })
    expect(snapping).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(snapping)
    expect(usePreferencesStore.getState().snappingEnabled).toBe(false)
    expect(screen.getByRole('button', { name: /Snapping off.*Alt/ }))
      .toHaveAttribute('aria-pressed', 'false')
  })
})
