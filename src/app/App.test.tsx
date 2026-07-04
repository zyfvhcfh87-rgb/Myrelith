/**
 * app/App.test.tsx — Phase 3.1: the shell mounts and every grid area
 * renders its panel. Layout geometry is verified visually (jsdom does not
 * do real layout); this guards wiring, not pixels.
 */

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App shell', () => {
  test('renders all five panel areas', () => {
    const { container } = render(<App />)

    expect(screen.getByText('WebCut')).toBeInTheDocument()
    expect(screen.getByText('Media Pool')).toBeInTheDocument()
    expect(screen.getByText('Preview')).toBeInTheDocument()
    expect(screen.getByText('Inspector')).toBeInTheDocument()
    expect(screen.getByText('Timeline')).toBeInTheDocument()

    const shell = container.querySelector('.app-shell')
    expect(shell).not.toBeNull()
    for (const area of [
      'area-toolbar',
      'area-media-pool',
      'area-preview',
      'area-inspector',
      'area-timeline',
    ]) {
      expect(shell?.querySelector(`.${area}`)).not.toBeNull()
    }
  })
})
