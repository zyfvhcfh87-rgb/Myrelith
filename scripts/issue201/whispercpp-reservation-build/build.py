"""Exact two-patch source preparation and separately granted, one-attempt build.

No compiler runs during --verify-inputs or --prepare-source. Compilation never
executes the generated module and preserves the preceding source/output/logs.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / 'docs/evidence/issue201/whispercpp-reservation-build-source'
ATTEMPT = ROOT / '.tmp/issue201-whispercpp-reservation-build'
SOURCE = ATTEMPT / 'source'
RECIPE = ATTEMPT / 'recipe'
LOGS = ATTEMPT / 'logs'
OUTPUT = ATTEMPT / 'output'
spec = importlib.util.spec_from_file_location('accepted_private_builder', ROOT / 'scripts/issue201/whispercpp/private-build.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def catalog():
    return json.loads(gzip.decompress((EVIDENCE / 'accepted-source-inventory.json.gz').read_bytes()))


def patches():
    return json.loads((EVIDENCE / 'patch-identities.json').read_text())['additionalPatches']


def verify_file(path, length, digest):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Expected an ordinary pinned file: ' + str(path))
    data = path.read_bytes()
    if len(data) != length or sha(data) != digest:
        raise RuntimeError('Pinned file changed: ' + str(path))
    return data


def verify_tree(tree, changed=False):
    expected = catalog()
    changes = {row['path']: row for row in patches()} if changed else {}
    count = 0
    for row in expected['files']:
        delta = changes.get(row['path'])
        verify_file(tree / row['path'], delta['afterBytes'] if delta else row['bytes'],
                    delta['afterSha256'] if delta else row['sha256'])
        count += 1
    if changed:
        actual = set()
        for directory, names, files in os.walk(tree, followlinks=False):
            for name in names + files:
                path = Path(directory) / name
                if path.is_symlink():
                    raise RuntimeError('Unexpected source symlink: ' + str(path))
            actual.update((Path(directory) / name).relative_to(tree).as_posix() for name in files)
        if actual != {row['path'] for row in expected['files']}:
            raise RuntimeError('Unexpected staged source inventory')
    return count


def verify_inputs(checkpoint=True):
    checkpoint_sha = None
    if checkpoint:
        data = (EVIDENCE / 'checkpoint.json').read_bytes()
        checkpoint_sha = sha(data)
        pin = json.loads(data)
        for row in pin['sourceFiles'] + pin['referenceFiles']:
            verify_file(ROOT / row['path'], row['bytes'], row['sha256'])
        for row in pin['records']:
            verify_file(EVIDENCE / row['path'], row['bytes'], row['sha256'])
    prior = base.verify_link_settings_retry_inputs()
    count = verify_tree(base.CORE)
    for row in patches():
        verify_file(base.CORE / row['path'], row['beforeBytes'], row['beforeSha256'])
    return dict(checkpointSha256=checkpoint_sha, acceptedSourceFiles=count,
                prior=prior, additionalPatches=patches(),
                prepared=verify_prepared() if ATTEMPT.exists() else None,
                compilerExecuted=False, wasmExecuted=False)


def prepare_source():
    # Source preparation precedes the final evidence checkpoint and is inert.
    # Native compilation always verifies that completed checkpoint below.
    inputs = verify_inputs(checkpoint=False)
    # A failed preparation remains reviewable; never replace its partial tree.
    ATTEMPT.mkdir()
    with (ATTEMPT / 'preparation-attempt.json').open('x') as stream:
        json.dump(inputs, stream, indent=2)
    expected = catalog()
    SOURCE.mkdir()
    for directory in expected['directories']:
        (SOURCE / directory).mkdir(parents=True, exist_ok=True)
    for row in expected['files']:
        data = verify_file(base.CORE / row['path'], row['bytes'], row['sha256'])
        target = SOURCE / row['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(data)
        target.chmod(row['mode'])
    for row in patches():
        result = subprocess.run(['/usr/bin/git', 'apply', '--directory=' + str(SOURCE.relative_to(ROOT)),
                                 str(ROOT / row['patchPath'])], cwd=ROOT, capture_output=True, text=True,
                                timeout=15, env={'PATH': '/usr/bin:/bin', 'DEVELOPER_DIR': '/Library/Developer/CommandLineTools'})
        with (ATTEMPT / (Path(row['path']).name + '.patch-application.json')).open('x') as stream:
            json.dump(dict(command=result.args, exitCode=result.returncode, stdout=result.stdout, stderr=result.stderr), stream, indent=2)
        if result.returncode:
            raise RuntimeError('Patch application failed; source preparation stopped')
    count = verify_tree(SOURCE, changed=True)
    RECIPE.mkdir()
    recipe_pins = []
    for name in ['CMakeLists.txt', 'adapter.cpp', 'myrelith-token-budget.h']:
        data = (ROOT / 'scripts/issue201/whispercpp' / name).read_bytes()
        with (RECIPE / name).open('xb') as stream:
            stream.write(data)
        recipe_pins.append(dict(path=name, bytes=len(data), sha256=sha(data)))
    receipt = dict(status='source-prepared-uncompiled', sourceFiles=count, patches=patches(), recipe=recipe_pins,
                   compilerExecuted=False, wasmExecuted=False)
    with (ATTEMPT / 'prepared.json').open('x') as stream:
        json.dump(receipt, stream, indent=2)
    return receipt


def verify_prepared():
    receipt = json.loads((ATTEMPT / 'prepared.json').read_text())
    if receipt['patches'] != patches() or receipt['sourceFiles'] != verify_tree(SOURCE, changed=True):
        raise RuntimeError('Prepared source identities changed')
    for row in receipt['recipe']:
        data = verify_file(RECIPE / row['path'], row['bytes'], row['sha256'])
        if data != (ROOT / 'scripts/issue201/whispercpp' / row['path']).read_bytes():
            raise RuntimeError('Prepared recipe differs from accepted recipe')
    return receipt


def compile_once():
    inputs = verify_inputs()
    if os.environ.get('ISSUE201_EXCLUSIVE_SLOT') != '1' or os.environ.get('ISSUE201_BUILD_CHECKPOINT_SHA256') != inputs['checkpointSha256']:
        raise RuntimeError('A new exclusive compile grant for this exact checkpoint is required')
    prepared = verify_prepared()
    if OUTPUT.exists() or LOGS.exists():
        raise RuntimeError('Build output/logs already exist; no implicit retry')
    with (ATTEMPT / 'build-attempt.json').open('x') as stream:
        json.dump(dict(status='started', inputs=inputs, prepared=prepared, jobs=2,
                       startedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())), stream, indent=2)
    LOGS.mkdir()
    env = base.environment()
    # Keep prior compiler intermediates and diagnostic disassembly inputs intact.
    for key, directory in [('TMPDIR', 'tmp'), ('EMCC_TEMP_DIR', 'tmp'), ('PYTHONPYCACHEPREFIX', 'pycache'),
                           ('XDG_CACHE_HOME', 'cache'), ('npm_config_cache', 'npm-cache')]:
        path = ATTEMPT / directory
        path.mkdir(exist_ok=True)
        env[key] = str(path)
    with (LOGS / 'private-environment.json').open('x') as stream:
        json.dump(env, stream, indent=2)
    command = [base.CMAKE, '-S', RECIPE, '-B', OUTPUT, '-G', 'Ninja',
               '-DCMAKE_MAKE_PROGRAM=' + str(base.NINJA),
               '-DCMAKE_TOOLCHAIN_FILE=' + str(base.EMSCRIPTEN / 'cmake/Modules/Platform/Emscripten.cmake'),
               '-DWHISPER_SOURCE_DIR=' + str(SOURCE),
               '-DCMAKE_CROSSCOMPILING_EMULATOR=' + str(base.DENY_RUNTIME),
               '-DFETCHCONTENT_FULLY_DISCONNECTED=ON', '-DFETCHCONTENT_UPDATES_DISCONNECTED=ON']
    original_logs = base.LOGS
    base.LOGS = LOGS
    try:
        base.run('configure', command, 180, env)
        base.run('compile-link', [base.CMAKE, '--build', OUTPUT, '--parallel', '2', '--verbose'], 600, env)
    except BaseException as error:
        with (LOGS / 'result.json').open('x') as stream:
            json.dump(dict(status='failed-closed-no-retry', error=str(error), wasmExecuted=False), stream, indent=2)
        raise
    finally:
        base.LOGS = original_logs
    verify_tree(SOURCE, changed=True)
    with (LOGS / 'result.json').open('x') as stream:
        json.dump(dict(status='built-unexecuted', generatedArtifactQualified=False, wasmExecuted=False), stream, indent=2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--verify-inputs', action='store_true')
    actions.add_argument('--prepare-source', action='store_true')
    actions.add_argument('--compile', action='store_true')
    args = parser.parse_args()
    if args.verify_inputs:
        print(json.dumps(verify_inputs(), indent=2))
    elif args.prepare_source:
        print(json.dumps(prepare_source(), indent=2))
    else:
        compile_once()
