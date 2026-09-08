import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const guard = readFileSync(new URL('./deny-wasm.cjs', import.meta.url), 'utf8');
const driver = readFileSync(new URL('./private-build.py', import.meta.url), 'utf8');

function guardedContext() {
  const context = vm.createContext({ WebAssembly: undefined }, {
    codeGeneration: { strings: false, wasm: false },
  });
  new vm.Script(guard).runInContext(context);
  return context;
}

test('private build guard rejects all WebAssembly access before any API call', () => {
  const context = guardedContext();
  for (const source of [
    'WebAssembly', 'typeof WebAssembly', 'WebAssembly.instantiate()',
    'new WebAssembly.Module()', 'new WebAssembly.Memory()',
  ]) {
    assert.throws(() => new vm.Script(source).runInContext(context), /execution is blocked/);
  }
  assert.equal(new vm.Script('2 + 3').runInContext(context), 5);
});

test('private build guard cannot be replaced, deleted or reconfigured', () => {
  const context = guardedContext();
  for (const source of [
    'globalThis.WebAssembly = {}',
    'Object.defineProperty(globalThis, "WebAssembly", { value: {} })',
    '"use strict"; delete globalThis.WebAssembly',
  ]) {
    assert.throws(() => new vm.Script(source).runInContext(context));
  }
  const descriptor = new vm.Script('Object.getOwnPropertyDescriptor(globalThis, "WebAssembly")').runInContext(context);
  assert.equal(descriptor.configurable, false);
});

test('private build configuration uses an explicit preload and rejecting emulator', () => {
  assert.match(driver, /'--require', str\(DENY_WASM\)/);
  assert.doesNotMatch(driver, /--no-expose-wasm/);
  assert.match(driver, /'-DCMAKE_CROSSCOMPILING_EMULATOR=' \+ str\(DENY_RUNTIME\)/);
  assert.match(driver, /marker\.open\('x'\)/);
  assert.match(driver, /'--parallel', '2'/);
});
