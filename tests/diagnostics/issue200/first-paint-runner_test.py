"""Source-only timeout/identity tests. No native processes or browser launches."""
import importlib.util
import signal
import json
import subprocess
import tempfile
from unittest.mock import patch
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('first_paint_runner', Path(__file__).resolve().parents[3] / 'docs/evidence/issue200/run-first-paint-browser.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def process(pid, ppid=1, started='original', command='owned'):
    return {'pid': pid, 'ppid': ppid, 'started': started, 'command': command}


class RunnerTests(unittest.TestCase):
    def test_manifest_includes_trace_bytes_after_exit_and_excludes_itself(self):
        import hashlib
        with tempfile.TemporaryDirectory(prefix='issue200-first-paint-manifest-unit-', dir='/private/tmp') as folder:
            root = Path(folder)
            (root / 'results').mkdir()
            payload = b'retained-success-trace-bytes\x00\xff'
            (root / 'results' / 'trace.zip').write_bytes(payload)
            with patch.dict(runner.os.environ, ISSUE200_FIRST_PAINT_ARTIFACTS=folder):
                runner.write_artifact_manifest()
                runner.write_artifact_manifest()
            result = json.loads((root / 'artifact-manifest.json').read_text())
            self.assertEqual(result['files'], [{'path': 'results/trace.zip', 'bytes': len(payload),
                'sha256': hashlib.sha256(payload).hexdigest()}])
            self.assertEqual(result['tracePolicy'], 'on; success and failure retained')

    def test_manifest_refuses_to_follow_an_evidence_symlink(self):
        with tempfile.TemporaryDirectory(prefix='issue200-first-paint-manifest-unit-', dir='/private/tmp') as folder:
            root = Path(folder)
            (root / 'link').symlink_to('/private/tmp')
            with patch.dict(runner.os.environ, ISSUE200_FIRST_PAINT_ARTIFACTS=folder):
                with self.assertRaisesRegex(RuntimeError, 'symlink'):
                    runner.write_artifact_manifest()

    def drain(self, chunks):
        elapsed, output = [0], []
        def read(timeout):
            elapsed[0] += timeout
            return next(chunks)
        complete = runner.drain_stdout(read, output.append, lambda: elapsed[0], 0.6)
        return complete, output, elapsed[0]

    def test_held_open_silent_pipe_reaches_deadline_without_eof(self):
        complete, output, elapsed = self.drain(iter([None] * 10))
        self.assertFalse(complete)
        self.assertEqual(output, [])
        self.assertAlmostEqual(elapsed, 0.6)

    def test_continuous_output_also_reaches_deadline(self):
        complete, output, elapsed = self.drain(iter([b'output'] * 10))
        self.assertFalse(complete)
        self.assertEqual(b''.join(output), b'output' * 3)
        self.assertAlmostEqual(elapsed, 0.6)

    def test_eof_completes_and_keeps_raw_bytes(self):
        complete, output, _ = self.drain(iter([b'\xffraw\n', b'']))
        self.assertTrue(complete)
        self.assertEqual(output, [b'\xffraw\n'])

    def test_term_resistant_child_is_killed_after_bounded_grace(self):
        item = process(10)
        snapshots = iter([[item], [item], []])
        calls = []
        result = runner.stop_owned(lambda: next(snapshots), lambda pid, sig: calls.append((pid, sig)), lambda seconds: calls.append(('wait', seconds)))
        self.assertEqual(calls, [(10, signal.SIGTERM), ('wait', 2), (10, signal.SIGKILL), ('wait', 0.2)])
        self.assertEqual(result['remaining'], [])
        self.assertEqual(result['requiredKill'], [item])

    def test_pid_reuse_requires_both_start_and_command_match(self):
        original = process(10)
        owned = {runner.identity(original): original}
        calls = []
        snapshots = iter([{10: original}, {10: process(10, started='reused')}, {10: process(10, command='unrelated')}])
        result = runner.stop_owned(lambda: runner.matching_processes(next(snapshots), owned), lambda pid, sig: calls.append((pid, sig)), lambda _: None)
        self.assertEqual(calls, [(10, signal.SIGTERM)])
        self.assertEqual(result['remaining'], [])
        self.assertEqual(runner.matching_processes({10: process(10, command='unrelated')}, owned), [])

    def test_new_descendant_is_discovered_before_kill(self):
        parent, child = process(10), process(11, ppid=10)
        owned = {runner.identity(parent): parent}
        tables = iter([{10: parent}, {10: parent, 11: child}, {}])
        def refresh():
            table = next(tables)
            for item in runner.discover_descendants(table, owned):
                owned[runner.identity(item)] = item
            return runner.matching_processes(table, owned)
        calls = []
        runner.stop_owned(refresh, lambda pid, sig: calls.append((pid, sig)), lambda _: None)
        self.assertEqual(calls, [(10, signal.SIGTERM), (10, signal.SIGKILL), (11, signal.SIGKILL)])

    def test_reused_parent_does_not_admit_unrelated_descendants(self):
        original = process(10)
        table = {10: process(10, started='reused'), 11: process(11, ppid=10)}
        self.assertEqual(runner.discover_descendants(table, {runner.identity(original): original}), [])

    def test_snapshot_failure_is_recorded_and_later_stages_continue(self):
        calls = [0]
        def refresh():
            calls[0] += 1
            if calls[0] == 1:
                raise TimeoutError('ps timed out')
            return []
        result = runner.stop_owned(refresh, lambda *_: self.fail('Must not signal unverified identities'), lambda _: None)
        self.assertEqual(result['cleanupErrors'], ['ps timed out'])
        self.assertEqual(calls[0], 3)

    def test_survivors_and_signal_errors_cannot_be_reported_as_clean(self):
        item = process(10)
        def signal_error(*_):
            raise PermissionError('signal failed')
        result = runner.stop_owned(lambda: [item], signal_error, lambda _: None)
        self.assertEqual(result['remaining'], [item])
        self.assertEqual(result['cleanupErrors'], ['signal failed', 'signal failed'])

    def test_main_times_out_and_kills_without_stdout_eof_or_term_exit(self):
        # Exercise the actual orchestration with injected process I/O, not a
        # real launcher, ps, lsof, signal, browser, port, or sleeping deadline.
        clock, signals = [0], []
        class Pipe:
            closed = False
            def fileno(self):
                return 123
            def close(self):
                self.closed = True
        class Child:
            pid, returncode, stdout = 10, None, Pipe()
            def poll(self):
                return self.returncode
            def wait(self, timeout):
                if self.returncode is None:
                    raise subprocess.TimeoutExpired('simulated launcher', timeout)
                return self.returncode
        class Watcher:
            def __init__(self, **_):
                pass
            def start(self):
                pass
            def join(self, timeout):
                pass
            def is_alive(self):
                return False
        child = Child()
        def now():
            clock[0] += 200
            return clock[0]
        def query(command, **_):
            if command[0] == 'ps':
                return '' if child.returncode is not None else '10 1 10 Tue Sep 8 20:00:00 2026 simulated-launcher\n'
            return 'source verified\n'
        def send(pid, sig):
            signals.append((pid, sig))
            if sig == signal.SIGKILL:
                child.returncode = -9
        with tempfile.TemporaryDirectory(prefix='issue200-first-paint-source-unit-', dir='/private/tmp') as temporary:
            directory = Path(temporary)
            manifest = directory / 'manifest.json'
            manifest.write_text('{}')
            artifacts = directory / 'artifacts'
            with patch.dict(runner.os.environ, ISSUE200_FIRST_PAINT_ARTIFACTS=str(artifacts), ISSUE200_FIRST_PAINT_MANIFEST=str(manifest)), \
                    patch.object(runner.subprocess, 'Popen', return_value=child), \
                    patch.object(runner.subprocess, 'check_output', side_effect=query), \
                    patch.object(runner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', '')), \
                    patch.object(runner.threading, 'Thread', Watcher), \
                    patch.object(runner.time, 'monotonic', side_effect=now), \
                    patch.object(runner.time, 'sleep'), \
                    patch.object(runner.os, 'set_blocking'), \
                    patch.object(runner.select, 'select', return_value=([child.stdout], [], [])), \
                    patch.object(runner.os, 'read', return_value=b'pipe remains open\n'), \
                    patch.object(runner.os, 'kill', side_effect=send):
                self.assertEqual(runner.main(), 1)
            evidence = json.loads((artifacts / 'process-ownership.json').read_text())
            self.assertTrue(evidence['timedOut'])
            self.assertFalse(evidence['stdoutComplete'])
            self.assertEqual(evidence['launcherReturnCode'], -9)
            self.assertEqual(evidence['remaining'], [])
            self.assertEqual(evidence['cleanupErrors'], [])
            self.assertEqual(signals, [(10, signal.SIGTERM), (10, signal.SIGKILL)])
            self.assertEqual((artifacts / 'playwright-stdout.log').read_bytes(), b'pipe remains open\n' * 2)
            release = json.loads((artifacts / 'release-verification.json').read_text())
            self.assertEqual(release['remainingOwned'], [])
            self.assertIn('deadline expired', release['observerErrors'][0])
            self.assertTrue(child.stdout.closed)


if __name__ == '__main__':
    unittest.main()
