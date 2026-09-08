/** Parse generated JS as data. Do not import/evaluate the generated factory. */
import assert from 'node:assert/strict';
import ts from 'typescript';

export function inspectGlue(source, binary) {
  const ast = ts.createSourceFile('generated.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, 'generated JS syntax');
  assert.equal(ast.statements.length, 2, 'factory plus default export only');
  const [factory, exported] = ast.statements;
  assert.ok(ts.isFunctionDeclaration(factory) && factory.name.text === 'createMyrelithWhisper');
  assert.ok(ts.isExportAssignment(exported) && exported.expression.getText(ast) === 'createMyrelithWhisper');
  const functions = new Map(), variables = new Map(), functionNodes = new Map();
  for (const node of factory.body.statements) {
    if (ts.isFunctionDeclaration(node)) {
      functions.set(node.name.text, node.getText(ast)); functionNodes.set(node.name.text, node);
    }
    if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) variables.set(item.name.getText(ast), item);
  }
  const imports = variables.get('wasmImports')?.initializer;
  assert.ok(imports && ts.isObjectLiteralExpression(imports), 'literal WASM import table');
  const importMap = new Map(imports.properties.map(property => {
    assert.ok(ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer));
    return [property.name.getText(ast).replaceAll('"', ''), property.initializer.text];
  }));
  assert.equal(importMap.size, imports.properties.length);
  assert.equal(importMap.size, binary.imports.length);
  assert.match(functions.get('getWasmImports'), /var imports=\{a:wasmImports\};return imports/);
  const groups = {
    exceptions: ['___cxa_begin_catch', '___cxa_end_catch', '___cxa_find_matching_catch_2',
      '___cxa_find_matching_catch_3', '___cxa_find_matching_catch_4', '___cxa_rethrow',
      '___cxa_throw', '___cxa_uncaught_exceptions', '___resumeException', '_llvm_eh_typeid_for'],
    fileStubs: ['___syscall_fcntl64', '___syscall_ioctl', '___syscall_openat', '_fd_close', '_fd_read', '_fd_seek'],
    output: ['_fd_write'], time: ['__tzset_js', '_clock_time_get', '_emscripten_get_now'],
    environment: ['_environ_get', '_environ_sizes_get'],
    memory: ['_emscripten_get_heap_max', '_emscripten_resize_heap'], abort: ['__abort_js'],
  };
  const namedImports = binary.imports.map(entry => {
    assert.equal(entry.module, 'a');
    const symbol = importMap.get(entry.name); assert.ok(symbol && (variables.has(symbol) || functions.has(symbol)), entry.name);
    const node = functionNodes.get(symbol) ?? variables.get(symbol)?.initializer;
    assert.ok(node && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node)), 'callable import');
    assert.equal(node.parameters.length, entry.parameters.length, 'JS import arity: ' + symbol);
    const invocation = /^invoke_([vifdj]+)$/.exec(symbol);
    let category;
    if (invocation) {
      category = 'indirectCallWithExceptionHandling';
      const types = { v: null, i: 'i32', f: 'f32', d: 'f64', j: 'i64' };
      const [result, ...parameters] = [...invocation[1]].map(c => types[c]);
      assert.ok(parameters.every(Boolean));
      assert.deepEqual(entry.parameters, ['i32', ...parameters], symbol);
      assert.deepEqual(entry.results, result ? [result] : [], symbol);
      assert.match(node.getText(ast), /getWasmTableEntry\(index\)/);
      assert.match(node.getText(ast), /stackRestore\(sp\)/);
      assert.match(node.getText(ast), /if\(!\(e instanceof EmscriptenEH\)\)throw e/);
    } else {
      category = Object.keys(groups).find(key => groups[key].includes(symbol));
      assert.ok(category, 'unreviewed import: ' + symbol);
    }
    return { ...entry, symbol, category, source: node.getText(ast) };
  });
  const assignments = new Map();
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isElementAccessExpression(node.right) && node.right.expression.getText(ast) === 'wasmExports'
      && ts.isStringLiteral(node.right.argumentExpression)) {
      assignments.set(node.left.getText(ast), node.right.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(factory);
  const signatures = {
    _speech_model_alloc: [['i32'], ['i32']], _speech_load: [[], ['i32']],
    _speech_pcm_alloc: [['i32'], ['i32']], _speech_run: [['i32'], ['i32']],
    _speech_tokens: [[], ['i32']], _speech_segment_count: [[], ['i32']],
    _speech_segment_t0: [['i32'], ['f64']], _speech_segment_t1: [['i32'], ['f64']],
    _speech_segment_text: [['i32'], ['i32']], _speech_close: [[], ['i32']], _speech_owned: [[], ['i32']],
  };
  const namedExports = Object.entries(signatures).map(([symbol, [parameters, results]]) => {
    const name = assignments.get(`Module["${symbol}"]`), entry = binary.exports.find(item => item.name === name);
    assert.ok(entry && entry.kind === 0, symbol);
    assert.deepEqual(entry.parameters, parameters, symbol); assert.deepEqual(entry.results, results, symbol);
    return { ...entry, symbol };
  });
  assert.equal(binary.exports.find(e => e.name === assignments.get('wasmMemory'))?.kind, 2);
  assert.equal(binary.exports.find(e => e.name === assignments.get('wasmTable'))?.kind, 1);
  assert.match(functions.get('updateMemoryViews'), /Module\["HEAPU8"\]=HEAPU8=new Uint8Array\(b\)/);
  assert.match(functions.get('updateMemoryViews'), /Module\["HEAPF32"\]=HEAPF32=new Float32Array\(b\)/);
  assert.ok(source.indexOf('wasmBinary=Module["wasmBinary"]') < source.indexOf('wasmExports=await createWasm()'));
  assert.doesNotMatch(source, /SharedArrayBuffer|\bAtomics\b|new Worker\b|new SharedWorker\b|new WebAssembly\.Memory\b|\bPThread\b|importScripts|WebSocket|indexedDB|new Function\b|\beval\(/);
  assert.match(variables.get('getHeapMax').getText(ast), /getHeapMax=\(\)=>536870912$/);
  const growth = variables.get('_emscripten_resize_heap').getText(ast);
  assert.match(growth, /requestedSize>maxHeapSize/);
  assert.match(growth, /oldSize\+16777216\/cutDown/);
  assert.match(growth, /Math\.min\(maxHeapSize,alignMemory\(Math\.max\(requestedSize,overGrownHeapSize\),65536\)\)/);
  assert.match(variables.get('_fd_read').getText(ast), /=>52$/);
  assert.match(variables.get('_fd_close').getText(ast), /=>52$/);
  assert.match(functions.get('_fd_seek'), /return 70/);
  assert.equal(functions.get('___syscall_openat'), 'function ___syscall_openat(dirfd,path,flags,varargs){SYSCALLS.varargs=varargs}');
  for (const symbol of ['___syscall_ioctl', '___syscall_fcntl64']) {
    assert.match(functions.get(symbol), /\{SYSCALLS.varargs=varargs;return 0\}$/);
  }
  const stackGet = assignments.get('_emscripten_stack_get_current'), stackRestore = assignments.get('__emscripten_stack_restore');
  const body = name => binary.exportedBodies.find(e => e.name === name);
  // Complete four/six-byte bodies: empty locals, global.get 0 / local.get 0,
  // global.set 0, end. This identifies the stack global without executing it.
  assert.deepEqual(body(stackGet)?.prefix, [0, 0x23, 0, 0x0b]);
  assert.equal(body(stackGet)?.bytes, 4);
  assert.deepEqual(body(stackRestore)?.prefix, [0, 0x20, 0, 0x24, 0, 0x0b]);
  assert.equal(body(stackRestore)?.bytes, 6);
  assert.deepEqual(binary.globals[0], { type: 'i32', mutable: 1, initial: 5923408 });
  return { namedImports, namedExports, memoryExport: assignments.get('wasmMemory'), tableExport: assignments.get('wasmTable'),
    importCategoryCounts: Object.fromEntries([...new Set(namedImports.map(i => i.category))]
      .map(category => [category, namedImports.filter(i => i.category === category).length])),
    stack: { globalIndex: 0, initialPointer: 5923408, getExport: stackGet, restoreExport: stackRestore,
      completeHelperBodiesInspected: true, runtimeStackBoundsTested: false },
    suppliedBytesAssignedBeforeStartup: true, heapMaximum: 536870912, linearGrowthStep: 16777216,
    hasFallbackFetchAndXhr: /fetch\(/.test(source) && /new XMLHttpRequest/.test(source),
    factoryExecuted: false, wasmExecuted: false,
    sources: Object.fromEntries(['findWasmBinary', 'getBinarySync', 'getWasmBinary', 'instantiateAsync', 'createWasm', 'assignWasmExports']
      .map(name => [name, functions.get(name)])),
  };
}
