"""Own only this run's process tree, preserve its output, and close it on exit."""
import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

root = Path('/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue200')
artifacts = Path(os.environ['ISSUE200_G2_ARTIFACTS'])
manifest = os.environ['ISSUE200_G2_MANIFEST']
if not str(artifacts).startswith('/private/tmp/issue200-'):
    raise ValueError('Use a fresh /private/tmp/issue200-* artifact directory')
if subprocess.run(['lsof', '-nP', '-iTCP:5200', '-sTCP:LISTEN'], capture_output=True).returncode != 1:
    raise RuntimeError('Port 5200 is already in use or cannot be checked')
artifacts.mkdir(parents=False, exist_ok=False)
source_check = ['node', 'docs/evidence/issue200/verify-canvas-diagnostic.mjs', 'verify', manifest]
artifacts.joinpath('source-before.log').write_text(subprocess.check_output(source_check, cwd=root, text=True))
artifacts.joinpath('candidate-manifest.json').write_bytes(Path(manifest).read_bytes())
command = ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/diagnostics/issue200/g2.playwright.config.ts']
owned = {}
def processes():
    result = {}
    output = subprocess.check_output(['ps', '-ax', '-o', 'pid=,ppid=,pgid=,lstart=,comm='], text=True)
    for line in output.splitlines():
        parts = line.split(None, 8)
        if len(parts) == 9:
            result[int(parts[0])] = {'pid': int(parts[0]), 'ppid': int(parts[1]), 'pgid': int(parts[2]), 'started': ' '.join(parts[3:8]), 'command': parts[8]}
    return result

child = subprocess.Popen(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
artifacts.joinpath('launcher.json').write_text(json.dumps({'command': command, 'pid': child.pid, 'pgid': child.pid, 'cwd': str(root)}, indent=2))
done = threading.Event()
def observe():
    while not done.is_set():
        table = processes()
        included = {child.pid}
        while True:
            expanded = included | {pid for pid, item in table.items() if item['ppid'] in included}
            if expanded == included:
                break
            included = expanded
        for pid in included:
            if pid in table:
                owned[pid] = table[pid]
        done.wait(0.5)
watcher = threading.Thread(target=observe, daemon=True)
watcher.start()
code = 1
try:
    with artifacts.joinpath('playwright-stdout.log').open('w') as output:
        for line in child.stdout:
            output.write(line); output.flush()
            print(line, end='', flush=True)
    code = child.wait()
finally:
    done.set(); watcher.join(timeout=2)
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try: child.wait(timeout=8)
        except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL); child.wait()
    def remaining():
        table = processes()
        return [item for pid, item in owned.items() if pid in table and table[pid]['started'] == item['started'] and table[pid]['command'] == item['command']]
    survivors = remaining()
    for item in survivors:
        try: os.kill(item['pid'], signal.SIGTERM)
        except ProcessLookupError: pass
    if survivors:
        time.sleep(2)
    for item in remaining():
        try: os.kill(item['pid'], signal.SIGKILL)
        except ProcessLookupError: pass
    time.sleep(0.2)
    artifacts.joinpath('process-ownership.json').write_text(json.dumps({'launcherPid': child.pid, 'exitCode': code, 'observed': list(owned.values()), 'requiredTermination': survivors, 'remaining': remaining()}, indent=2))
try:
    artifacts.joinpath('source-after.log').write_text(subprocess.check_output(source_check, cwd=root, text=True))
finally:
    listener = subprocess.run(['lsof', '-nP', '-iTCP:5200', '-sTCP:LISTEN'], capture_output=True, text=True)
    release = {'remainingOwned': remaining(), 'listenerExitCode': listener.returncode, 'listenerStdout': listener.stdout, 'listenerStderr': listener.stderr}
    artifacts.joinpath('release-verification.json').write_text(json.dumps(release, indent=2))
    if release['remainingOwned'] or listener.returncode != 1 or listener.stdout:
        code = 1
raise SystemExit(code)
