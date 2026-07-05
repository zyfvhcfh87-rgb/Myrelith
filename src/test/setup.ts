// src/test/setup.ts — Vitest global setup. Extends expect with jest-dom matchers.
import '@testing-library/jest-dom/vitest'

// jsdom implements neither DragEvent nor DataTransfer. A MouseEvent subclass
// is enough for tests that drive dragover/drop handlers directly: it carries
// clientX (which a bare Event would silently drop), and testing-library
// attaches the dataTransfer stub onto the event itself.
if (typeof window !== 'undefined' && typeof window.DragEvent === 'undefined') {
  Object.defineProperty(window, 'DragEvent', {
    value: class DragEvent extends MouseEvent {},
    writable: true,
    configurable: true,
  })
}

// jsdom does not implement pointer capture; polyfill just enough for
// component tests that drive scrub/drag gestures (per-element, ignoring
// pointerId — fine for single-pointer tests).
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  const captured = new Set<Element>()
  Element.prototype.setPointerCapture = function (this: Element) {
    captured.add(this)
  }
  Element.prototype.releasePointerCapture = function (this: Element) {
    captured.delete(this)
  }
  Element.prototype.hasPointerCapture = function (this: Element) {
    return captured.has(this)
  }
}
