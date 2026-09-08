'use strict';

// Build tools may parse and transform WASM bytes, but must never execute them.
// Loaded by the private Node command using the ordinary --require option.
Object.defineProperty(globalThis, 'WebAssembly', {
  configurable: false,
  enumerable: false,
  get() {
    throw new Error('WebAssembly execution is blocked in this build-only process');
  },
  set() {
    throw new Error('WebAssembly execution is blocked in this build-only process');
  },
});
