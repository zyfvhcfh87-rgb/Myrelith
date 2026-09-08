"""Execute pinned argument/settings functions with only inert source dependencies.

No SDK module is imported, compiler is launched, or WASM API exists here. This
checks argument parsing and the selected compatibility/memory checks, not the
whole linker or generated output. Missing dependencies fail the source probe.
"""
from __future__ import annotations

import ast
import copy
import difflib
from enum import Enum, auto, unique
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys
from types import SimpleNamespace
from typing import Any

EVIDENCE = Path(__file__).resolve().parents[3] / 'docs/evidence/issue201/whispercpp-link-settings'


def fail(message, *args):
    raise ValueError(message % args if args else message)


def sources():
    pins = json.loads((EVIDENCE / 'source-pins.json').read_text())
    result = {}
    for pin in pins['sources']:
        packed = (EVIDENCE / pin['name']).read_bytes()
        raw = gzip.decompress(packed)
        for data, size, digest in [(packed, pin['bytes'], pin['sha256']),
                                   (raw, pin['decodedBytes'], pin['decodedSha256'])]:
            assert len(data) == size and hashlib.sha256(data).hexdigest() == digest
        result[pin['archiveMember'].removeprefix('install/emscripten/')] = raw.decode()
    return result


def selected(source, names):
    tree = ast.parse(source)
    nodes = [node for node in tree.body if getattr(node, 'name', None) in names
             or isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in node.targets)]
    found = {getattr(node, 'name', None) for node in nodes}
    found.update(t.id for node in nodes if isinstance(node, ast.Assign) for t in node.targets if isinstance(t, ast.Name))
    assert names <= found, names - found
    return ast.Module(body=nodes, type_ignores=[])


def audit(argv, source):
    warnings = []
    ns = dict(copy=copy, difflib=difflib, re=re, Any=Any, json=json, os=os,
              shlex=shlex, Enum=Enum, auto=auto, unique=unique,
              exit_with_error=fail, path_from_root=lambda name: name,
              utils=SimpleNamespace(read_file=lambda name: source[name], get_env_bool=lambda _: False),
              diagnostics=SimpleNamespace(warning=lambda *args: warnings.append(list(args))))
    # Load actual tables, SettingsManager and its default singleton, excluding
    # only imports (their source-reading/diagnostic dependencies are above).
    tree = ast.parse(source['tools/settings.py'])
    tree.body = [n for n in tree.body if not isinstance(n, (ast.Import, ast.ImportFrom))]
    exec(compile(tree, 'pinned/tools/settings.py', 'exec'), ns)
    cmd_names = {'CLANG_FLAGS_WITH_ARGS', 'SIMD_INTEL_FEATURE_TOWER', 'SIMD_NEON_FLAGS',
                 'OFormat', 'EmccOptions', 'is_dash_s_for_emcc', 'parse_args', 'parse_s_args',
                 'normalize_args', 'normalize_boolean_setting', 'expand_byte_size_suffixes',
                 'parse_symbol_list_file', 'parse_value', 'apply_user_settings'}
    exec(compile(selected(source['tools/cmdline.py'], cmd_names), 'pinned/tools/cmdline.py', 'exec'), ns)
    exec(compile(selected(source['tools/link.py'], {'check_settings', 'set_initial_memory', 'set_max_memory'}),
                 'pinned/tools/link.py', 'exec'), ns)
    ns['options'] = ns['EmccOptions']()
    ns['webassembly'] = SimpleNamespace(WASM_PAGE_SIZE=65536)
    settings = ns['settings']
    try:
        remaining = ns['parse_args'](ns['normalize_args'](list(argv)))
        ns['parse_s_args']()
        ns['apply_user_settings']()
        ns['check_settings']()
        ns['set_initial_memory']()
        ns['set_max_memory']()
        keys = list(ns['user_settings'])
        return dict(ok=True, settings={key: settings[key] for key in keys},
                    classifications={key: 'internal' if key in settings.internal_settings else
                                     'legacy' if key in settings.legacy_settings else 'public' for key in keys},
                    types={key: settings.types[key].__name__ for key in keys if key in settings.types},
                    memory={key: settings[key] for key in ['PTHREADS', 'SHARED_MEMORY', 'WASM_WORKERS',
                            'IMPORTED_MEMORY', 'INITIAL_MEMORY', 'MAXIMUM_MEMORY', 'STACK_SIZE',
                            'MEMORY_GROWTH_LINEAR_STEP', 'MEMORY_GROWTH_GEOMETRIC_STEP']},
                    warnings=warnings, remaining=remaining)
    except ValueError as error:
        return dict(ok=False, error=str(error), warnings=warnings)


if __name__ == '__main__':
    source = sources()
    print(json.dumps([audit(args, source) for args in json.load(sys.stdin)], indent=2))
