"""Bound this run independently of stdout EOF; signal only observed identities."""
import json
import os
import select
import signal
import subprocess
import threading
import time
from pathlib import Path


def identity(item):
    return item['pid'], item['started'], item['command']


def matching_processes(table, owned):
    return [item for item in table.values() if identity(item) in owned]


def discover_descendants(table, owned):
    included = {item['pid'] for item in matching_processes(table, owned)}
    while True:
        expanded = included | {pid for pid, item in table.items() if item['ppid'] in included}
        if expanded == included:
            return [table[pid] for pid in sorted(included)]
        included = expanded


def drain_stdout(read_chunk, write_chunk, now, deadline):
    """read_chunk waits at most its argument; None means not ready, b'' means EOF."""
    while True:
        remaining = deadline - now()
        if remaining <= 0:
            return False
        chunk = read_chunk(min(0.2, remaining))
        if chunk == b'':
            return True
        if chunk is not None:
            write_chunk(chunk)


def stop_owned(refresh, send_signal, pause):
    """Refresh identities for each escalation, including newly observed children."""
    errors = []
    def current():
        try:
            return refresh()
        except Exception as error:
            errors.append(str(error))
            return []
    def send(items, sig):
        for item in items:
            try:
                send_signal(item['pid'], sig)
            except ProcessLookupError:
                pass
            except Exception as error:
                errors.append(str(error))
    terminated = current()
    send(terminated, signal.SIGTERM)
    if terminated:
        pause(2)
    killed = current()
    send(killed, signal.SIGKILL)
    if killed:
        pause(0.2)
    return {'requiredTermination': terminated, 'requiredKill': killed,
            'remaining': current(), 'cleanupErrors': errors}


def main():
    root = Path('/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue200')
    artifacts = Path(os.environ['ISSUE200_G3_ARTIFACTS'])
    manifest = os.environ['ISSUE200_G3_MANIFEST']
    if not str(artifacts).startswith('/private/tmp/issue200-'):
        raise ValueError('Use a fresh /private/tmp/issue200-* artifact directory')
    listener_command = ['lsof', '-nP', '-iTCP:5200', '-sTCP:LISTEN']
    if subprocess.run(listener_command, capture_output=True, timeout=5).returncode != 1:
        raise RuntimeError('Port 5200 is already in use or cannot be checked')
    artifacts.mkdir(parents=False, exist_ok=False)
    source_check = ['node', 'docs/evidence/issue200/verify-g3-source.mjs', 'verify', manifest]
    artifacts.joinpath('source-before.log').write_text(subprocess.check_output(source_check, cwd=root, text=True, timeout=30))
    artifacts.joinpath('candidate-manifest.json').write_bytes(Path(manifest).read_bytes())
    command = ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/diagnostics/issue200/g3.playwright.config.ts']
    owned = {}
    owned_lock = threading.Lock()
    observer_errors = []
    def processes():
        result = {}
        output = subprocess.check_output(['ps', '-ax', '-o', 'pid=,ppid=,pgid=,lstart=,comm='], text=True, timeout=3)
        for line in output.splitlines():
            parts = line.split(None, 8)
            if len(parts) == 9:
                result[int(parts[0])] = {'pid': int(parts[0]), 'ppid': int(parts[1]), 'pgid': int(parts[2]), 'started': ' '.join(parts[3:8]), 'command': parts[8]}
        return result

    deadline = time.monotonic() + 600
    child = subprocess.Popen(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0, start_new_session=True)
    def refresh():
        table = processes()
        with owned_lock:
            # Seed once, only while Popen still identifies a running launcher.
            if not owned and child.poll() is None and child.pid in table:
                owned[identity(table[child.pid])] = table[child.pid]
            for item in discover_descendants(table, owned):
                owned[identity(item)] = item
            return matching_processes(table, owned)
    done = threading.Event()
    def observe():
        while not done.is_set():
            try:
                refresh()
            except Exception as error:
                observer_errors.append(str(error))
                return
            done.wait(0.5)
    watcher = threading.Thread(target=observe, daemon=True)
    code, timed_out, stdout_complete = 1, False, False
    failure = None
    cleanup = {}
    watcher_started = False
    try:
        watcher.start()
        watcher_started = True
        artifacts.joinpath('launcher.json').write_text(json.dumps({'command': command, 'pid': child.pid, 'pgid': child.pid, 'cwd': str(root)}, indent=2))
        os.set_blocking(child.stdout.fileno(), False)
        def read_chunk(timeout):
            ready, _, _ = select.select([child.stdout], [], [], timeout)
            return os.read(child.stdout.fileno(), 65536) if ready else None
        with artifacts.joinpath('playwright-stdout.log').open('wb') as output:
            def write_chunk(chunk):
                output.write(chunk)
                output.flush()
            # No blocking iterator or inherited-pipe EOF dependency. Stdout is
            # preserved directly; console forwarding cannot block this loop.
            stdout_complete = drain_stdout(read_chunk, write_chunk, time.monotonic, deadline)
        if not stdout_complete:
            timed_out = True
        else:
            try:
                code = child.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
        if timed_out:
            observer_errors.append('The 600-second G3 run deadline expired; stdout may be incomplete')
            code = 1
    except BaseException as error:
        failure = repr(error)
        code = 1
    finally:
        done.set()
        if watcher_started:
            watcher.join(timeout=4)
        if watcher_started and watcher.is_alive():
            observer_errors.append('The process observer did not stop within four seconds')
        # Escalation runs even when the pipe has no EOF or TERM was ignored.
        # Every process query and wait is bounded; no unverified group kill.
        cleanup = stop_owned(refresh, os.kill, time.sleep)
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            observer_errors.append('The launcher did not exit after owned cleanup')
        child.stdout.close()
        artifacts.joinpath('process-ownership.json').write_text(json.dumps({
            'launcherPid': child.pid, 'exitCode': code, 'launcherReturnCode': child.returncode,
            'observed': list(owned.values()), 'deadlineSeconds': 600, 'timedOut': timed_out,
            'stdoutComplete': stdout_complete, 'runnerFailure': failure,
            **cleanup, 'observerErrors': observer_errors}, indent=2))
    try:
        artifacts.joinpath('source-after.log').write_text(subprocess.check_output(source_check, cwd=root, text=True, timeout=30))
    except Exception as error:
        observer_errors.append(f'Source verification failed: {error}')
    release = {'remainingOwned': None, 'listenerExitCode': None, 'listenerStdout': '', 'listenerStderr': ''}
    try:
        release['remainingOwned'] = refresh()
        listener = subprocess.run(listener_command, capture_output=True, text=True, timeout=5)
        release.update(listenerExitCode=listener.returncode, listenerStdout=listener.stdout, listenerStderr=listener.stderr)
    except Exception as error:
        observer_errors.append(f'Release verification failed: {error}')
    release['observerErrors'] = observer_errors
    artifacts.joinpath('release-verification.json').write_text(json.dumps(release, indent=2))
    if (failure or timed_out or cleanup['remaining'] or cleanup['cleanupErrors'] or
            release['remainingOwned'] != [] or release['listenerExitCode'] != 1 or
            release['listenerStdout'] or observer_errors):
        code = 1
    return code


if __name__ == '__main__':
    raise SystemExit(main())
