"""Inert driver controls. Fake run ports never invoke a compiler or native code."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reservation_builder', Path(__file__).with_name('build.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class CompileControls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='issue201-reservation-control-')
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        for name, path in [('ATTEMPT', root), ('LOGS', root / 'logs'), ('OUTPUT', root / 'output'),
                           ('SOURCE', root / 'source'), ('RECIPE', root / 'recipe')]:
            control = patch.object(builder, name, path)
            control.start(); self.addCleanup(control.stop)
        self.calls = []
        for control in [patch.object(builder, 'verify_inputs', return_value={'checkpointSha256': 'c' * 64}),
                        patch.object(builder, 'verify_prepared', return_value={'status': 'inert-source'}),
                        patch.object(builder, 'verify_tree', return_value=1882),
                        patch.object(builder.base, 'run', side_effect=self.record)]:
            control.start(); self.addCleanup(control.stop)
        self.env = patch.dict(os.environ, {'ISSUE201_EXCLUSIVE_SLOT': '1', 'ISSUE201_BUILD_CHECKPOINT_SHA256': 'c' * 64})
        self.env.start(); self.addCleanup(self.env.stop)

    def record(self, label, command, timeout, env):
        self.calls.append((label, command, timeout, env))
        return ''

    def test_no_grant_creates_no_attempt(self):
        os.environ.pop('ISSUE201_EXCLUSIVE_SLOT')
        with self.assertRaisesRegex(RuntimeError, 'exclusive compile grant'):
            builder.compile_once()
        self.assertFalse((builder.ATTEMPT / 'build-attempt.json').exists())
        self.assertEqual(self.calls, [])

    def test_wrong_checkpoint_creates_no_attempt(self):
        os.environ['ISSUE201_BUILD_CHECKPOINT_SHA256'] = 'd' * 64
        with self.assertRaisesRegex(RuntimeError, 'exact checkpoint'):
            builder.compile_once()
        self.assertEqual(self.calls, [])

    def test_one_attempt_preserves_guards_limits_and_separate_paths(self):
        old_logs = builder.base.LOGS
        builder.compile_once()
        self.assertEqual([row[0] for row in self.calls], ['configure', 'compile-link'])
        self.assertEqual([row[2] for row in self.calls], [180, 600])
        self.assertIn('-DWHISPER_SOURCE_DIR=' + str(builder.SOURCE), self.calls[0][1])
        self.assertIn('-DCMAKE_CROSSCOMPILING_EMULATOR=' + str(builder.base.DENY_RUNTIME), self.calls[0][1])
        self.assertEqual(self.calls[1][1][-3:], ['--parallel', '2', '--verbose'])
        env = self.calls[0][3]
        self.assertEqual(env['BINARYEN_CORES'], '1')
        self.assertEqual(env['EMCC_CORES'], '1')
        self.assertEqual(env['NODE_OPTIONS'], '--require=' + str(builder.base.DENY_WASM))
        self.assertEqual(env['EMCC_TEMP_DIR'], str(builder.ATTEMPT / 'tmp'))
        self.assertEqual(env['HTTPS_PROXY'], 'http://127.0.0.1:9')
        self.assertEqual(builder.base.LOGS, old_logs)
        self.assertEqual(json.loads((builder.LOGS / 'result.json').read_text())['status'], 'built-unexecuted')

    def test_configure_failure_stops_before_compile_and_preserves_marker(self):
        with patch.object(builder.base, 'run', side_effect=RuntimeError('inert configure failure')):
            with self.assertRaisesRegex(RuntimeError, 'inert configure failure'):
                builder.compile_once()
        marker = (builder.ATTEMPT / 'build-attempt.json').read_bytes()
        self.assertEqual(json.loads((builder.LOGS / 'result.json').read_text())['status'], 'failed-closed-no-retry')
        with self.assertRaisesRegex(RuntimeError, 'no implicit retry'):
            builder.compile_once()
        self.assertEqual((builder.ATTEMPT / 'build-attempt.json').read_bytes(), marker)
        self.assertEqual(self.calls, [])

    def test_consumed_marker_is_not_overwritten_even_without_outputs(self):
        marker = builder.ATTEMPT / 'build-attempt.json'
        marker.write_text('original consumed attempt')
        with self.assertRaises(FileExistsError):
            builder.compile_once()
        self.assertEqual(marker.read_text(), 'original consumed attempt')
        self.assertEqual(self.calls, [])

    def test_input_or_prepared_source_failure_precedes_marker(self):
        for method in ['verify_inputs', 'verify_prepared']:
            with patch.object(builder, method, side_effect=RuntimeError('changed input')):
                with self.assertRaisesRegex(RuntimeError, 'changed input'):
                    builder.compile_once()
            self.assertFalse((builder.ATTEMPT / 'build-attempt.json').exists())
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
