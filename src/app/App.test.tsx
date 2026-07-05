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
    // Real panels (3.2–3.4), not placeholders:
    expect(container.querySelector('.media-pool')).not.toBeNull()
    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument()
    expect(screen.getByText('Inspector')).toBeInTheDocument() // Phase 4
    expect(screen.getByTestId('timeline-root')).toBeInTheDocument()

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
