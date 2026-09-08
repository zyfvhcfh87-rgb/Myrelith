"""Private, pinned, one-attempt build driver. No activation or runtime tests.

Use --prepare for exact source staging/configuration/version checks. A separate
--build invocation consumes the single build attempt. Node's WebAssembly API is
not exposed; the CMake cross-compiling emulator is an explicit rejecting script.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
BUILD = ROOT / '.tmp/issue201-whispercpp-build'
CORE = BUILD / 'source/whisper.cpp-371b5a7561823ab2bb32142d2751e35e7534727b'
INSTALL = BUILD / 'toolchain/install'
EMSCRIPTEN = INSTALL / 'emscripten'
NODE = BUILD / 'node/node-v24.19.0-darwin-arm64/bin/node'
PYTHON = BUILD / 'python/python-3.13.3-0/bin/python3.13'
CMAKE = BUILD / 'cmake/cmake-4.4.3-macos-universal/CMake.app/Contents/bin/cmake'
NINJA = BUILD / 'ninja/ninja'
RECIPE = BUILD / 'recipe'
LOGS = BUILD / 'logs'
CONFIG = BUILD / 'config/.emscripten'
DENY_WASM = BUILD / 'config/deny-wasm.cjs'
DENY_RUNTIME = BUILD / 'config/deny-runtime.sh'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def environment():
    # No inherited compiler flags, SDK settings, tool overrides, Node preload,
    # Python imports, credentials or proxy bypasses. HOME retains its real value.
    return {
        'HOME': os.environ['HOME'], 'USER': os.environ.get('USER', ''),
        'LANG': 'C', 'LC_ALL': 'C', 'DEVELOPER_DIR': '/Library/Developer/CommandLineTools',
        'PATH': ':'.join(map(str, [PYTHON.parent, NODE.parent, CMAKE.parent, NINJA.parent,
                                 EMSCRIPTEN, INSTALL / 'bin', '/usr/bin', '/bin'])),
        'EM_CONFIG': str(CONFIG), 'EM_CACHE': str(EMSCRIPTEN / 'cache'),
        'EM_PORTS': str(BUILD / 'ports'), 'EMSDK_PYTHON': str(PYTHON),
        'TMPDIR': str(BUILD / 'tmp'), 'EMCC_TEMP_DIR': str(BUILD / 'tmp'),
        'PYTHONPYCACHEPREFIX': str(BUILD / 'pycache'), 'PYTHONNOUSERSITE': '1',
        'XDG_CACHE_HOME': str(BUILD / 'cache'), 'EMCC_CORES': '1', 'BINARYEN_CORES': '1',
        'CMAKE_BUILD_PARALLEL_LEVEL': '2', 'EMCC_DEBUG': '1',
        'NODE_OPTIONS': '--require=' + str(DENY_WASM),
        'npm_config_offline': 'true', 'npm_config_cache': str(BUILD / 'npm-cache'),
        'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
        'ALL_PROXY': 'http://127.0.0.1:9', 'http_proxy': 'http://127.0.0.1:9',
        'https_proxy': 'http://127.0.0.1:9', 'all_proxy': 'http://127.0.0.1:9',
        'NO_PROXY': '', 'no_proxy': '',
    }


def run(label, command, seconds, env):
    command = list(map(str, command))
    record = dict(label=label, command=command, timeoutSeconds=seconds,
                  startedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    start = time.monotonic()
    path = LOGS / (label + '.txt')
    with path.open('xb') as output:
        process = subprocess.Popen(command, cwd=BUILD, env=env, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        record['pid'] = process.pid
        record['processGroup'] = process.pid
        try:
            record['exitCode'] = process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            record['timedOut'] = True
            os.killpg(process.pid, signal.SIGKILL)
            record['exitCode'] = process.wait(timeout=10)
        finally:
            # No detached compiler child may survive even an early parent exit.
            try:
                os.killpg(process.pid, signal.SIGKILL)
                record['remainingGroupTerminated'] = True
            except ProcessLookupError:
                record['remainingGroupTerminated'] = False
    record['elapsedSeconds'] = round(time.monotonic() - start, 3)
    record['logBytes'] = path.stat().st_size
    record['logSha256'] = sha(path)
    (LOGS / (label + '.json')).write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    if record['exitCode'] != 0 or record.get('timedOut') or record['remainingGroupTerminated']:
        raise RuntimeError('Stopped after unsuccessful/unfinished command: ' + label)
    return path.read_text(errors='replace')


def prepare():
    if CONFIG.exists() or RECIPE.exists():
        raise RuntimeError('Preparation already exists; refusing an implicit retry')
    checkpoint = json.loads((ROOT / 'docs/evidence/issue201/whispercpp-preparation/loader-source-checkpoint.json').read_text())
    for row in checkpoint['sourceFiles']:
        path = ROOT / row['path']
        if path.stat().st_size != row['bytes'] or sha(path) != row['sha256']:
            raise RuntimeError('Accepted source drift: ' + row['path'])
    identities = json.loads((ROOT / 'scripts/issue201/whispercpp/patch-identities.json').read_text())
    prepared = ROOT / '.tmp/issue201-whispercpp-preparation/patched-review'
    for row in identities['build'] + identities['guard']:
        if sha(CORE / row['path']) != row['before'] or sha(prepared / row['path']) != row['after']:
            raise RuntimeError('Patch input/output mismatch: ' + row['path'])
    for row in identities['build'] + identities['guard']:
        (CORE / row['path']).write_bytes((prepared / row['path']).read_bytes())
    RECIPE.mkdir()
    for name in ['CMakeLists.txt', 'adapter.cpp', 'myrelith-token-budget.h']:
        (RECIPE / name).write_bytes((ROOT / 'scripts/issue201/whispercpp' / name).read_bytes())
    CONFIG.write_text('LLVM_ROOT = ' + repr(str(INSTALL / 'bin')) + '\n'
                      'BINARYEN_ROOT = ' + repr(str(INSTALL)) + '\n'
                      'NODE_JS = ' + repr([str(NODE), '--require', str(DENY_WASM)]) + '\n'
                      'CACHE = ' + repr(str(EMSCRIPTEN / 'cache')) + '\n'
                      'PORTS = ' + repr(str(BUILD / 'ports')) + '\n')
    DENY_RUNTIME.write_text('#!/bin/sh\nprintf "%s\\n" "Blocked: this is a build-only checkpoint; runtime execution is not authorized." >&2\nexit 97\n')
    DENY_RUNTIME.chmod(0o755)
    DENY_WASM.write_bytes((ROOT / 'scripts/issue201/whispercpp/deny-wasm.cjs').read_bytes())
    version_checks('')


def version_checks(prefix):
    env = environment()
    (LOGS / (prefix + 'private-environment.json')).write_text(json.dumps(env, indent=2) + '\n')
    checks = [
        ('python-version', [PYTHON, '--version'], 'Python 3.13.3'),
        ('node-version', [NODE, '--require', str(DENY_WASM), '--version'], 'v24.19.0'),
        ('cmake-version', [CMAKE, '--version'], 'cmake version 4.4.3'),
        ('ninja-version', [NINJA, '--version'], '1.13.2'),
        ('clang-version', [INSTALL / 'bin/clang', '--version'], 'c0125a7bf833b6cf0d5b4a085b63094e0893c85a'),
        ('binaryen-version', [INSTALL / 'bin/wasm-opt', '--version'], '8d546dc4a'),
        ('emscripten-version', [PYTHON, EMSCRIPTEN / 'emcc.py', '--version'], '6.0.8-git'),
    ]
    for label, command, expected in checks:
        output = run(prefix + label, command, 30, env)
        if expected not in output:
            raise RuntimeError('Unexpected pinned tool version: ' + label)
    (LOGS / 'prepared.json').write_text(json.dumps(dict(status='prepared',
        sourceCheckpoint='d8a1ff4460aabee0df5113d731a2698ed5777012',
        integratedHead='4d4a6c2534cf25b8db3ec653f564b38cf2a67b6e',
        recipeSha256=sha(RECIPE / 'CMakeLists.txt'), configSha256=sha(CONFIG),
        driverSha256=sha(Path(__file__)), guardSha256=sha(DENY_WASM),
        patchedFiles=json.loads((ROOT / 'scripts/issue201/whispercpp/patch-identities.json').read_text()),
        runtimeExecuted=False), indent=2) + '\n')


def resume_version_checks():
    # Only this exact pre-build failure is eligible, under a separate grant.
    failed = json.loads((LOGS / 'node-version.json').read_text())
    if failed['exitCode'] != 9 or 'bad option:' not in (LOGS / 'node-version.txt').read_text():
        raise RuntimeError('Unexpected predecessor failure')
    if (LOGS / 'build-attempt.json').exists() or (LOGS / 'prepared.json').exists():
        raise RuntimeError('Cannot resume after a build or successful preparation')
    for name in ['CMakeLists.txt', 'adapter.cpp', 'myrelith-token-budget.h']:
        if sha(RECIPE / name) != sha(ROOT / 'scripts/issue201/whispercpp' / name):
            raise RuntimeError('Staged recipe drift')
    identities = json.loads((ROOT / 'scripts/issue201/whispercpp/patch-identities.json').read_text())
    for row in identities['build'] + identities['guard']:
        if sha(CORE / row['path']) != row['after']:
            raise RuntimeError('Staged patched source drift')
    with (LOGS / 'version-correction-attempt.json').open('x') as output:
        json.dump(dict(driverSha256=sha(Path(__file__)),
                       guardSha256=sha(ROOT / 'scripts/issue201/whispercpp/deny-wasm.cjs')), output)
    (LOGS / 'original-private-config.txt').write_bytes(CONFIG.read_bytes())
    rows = CONFIG.read_text().splitlines()
    rows = [('NODE_JS = ' + repr([str(NODE), '--require', str(DENY_WASM)]))
            if row.startswith('NODE_JS = ') else row for row in rows]
    CONFIG.write_text('\n'.join(rows) + '\n')
    DENY_WASM.write_bytes((ROOT / 'scripts/issue201/whispercpp/deny-wasm.cjs').read_bytes())
    version_checks('correction-')


def build():
    if not (LOGS / 'prepared.json').exists():
        raise RuntimeError('Successful preparation required')
    # O_EXCL marker is written BEFORE configure, which itself can compile probes.
    marker = LOGS / 'build-attempt.json'
    with marker.open('x') as output:
        json.dump(dict(status='started', jobs=2, driverSha256=sha(Path(__file__)),
                       startedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())), output, indent=2)
    env = environment()
    command = [CMAKE, '-S', RECIPE, '-B', BUILD / 'output', '-G', 'Ninja',
               '-DCMAKE_MAKE_PROGRAM=' + str(NINJA),
               '-DCMAKE_TOOLCHAIN_FILE=' + str(EMSCRIPTEN / 'cmake/Modules/Platform/Emscripten.cmake'),
               '-DWHISPER_SOURCE_DIR=' + str(CORE),
               '-DCMAKE_CROSSCOMPILING_EMULATOR=' + str(DENY_RUNTIME),
               '-DFETCHCONTENT_FULLY_DISCONNECTED=ON', '-DFETCHCONTENT_UPDATES_DISCONNECTED=ON']
    try:
        run('configure', command, 180, env)
        run('compile-link', [CMAKE, '--build', BUILD / 'output', '--parallel', '2', '--verbose'], 600, env)
    except BaseException as error:
        result = dict(status='failed-closed-no-retry', error=str(error), runtimeExecuted=False)
        (LOGS / 'build-result.json').write_text(json.dumps(result, indent=2) + '\n')
        raise
    (LOGS / 'build-result.json').write_text(json.dumps(dict(status='built-unexecuted', runtimeExecuted=False), indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--prepare', action='store_true')
    actions.add_argument('--build', action='store_true')
    actions.add_argument('--resume-version-checks', action='store_true')
    args = parser.parse_args()
    if args.prepare:
        prepare()
    elif args.resume_version_checks:
        resume_version_checks()
    else:
        build()
