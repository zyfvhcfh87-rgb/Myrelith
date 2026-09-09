"""Retry-driver control-flow tests with filesystem fixtures and an inert runner."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).with_name('private-build.py')


def driver():
    spec = importlib.util.spec_from_file_location('private_driver_test', SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RetryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='issue201-retry-test-')
        self.addCleanup(self.temporary.cleanup)
        self.m = driver()
        self.m.ROOT = Path(self.temporary.name)
        self.m.BUILD = self.m.ROOT / 'build'
        self.m.LOGS = self.m.BUILD / 'logs'
        self.m.RECIPE = self.m.BUILD / 'recipe'
        self.m.LOGS.mkdir(parents=True)
        self.m.RECIPE.mkdir()
        self.source = self.m.ROOT / 'scripts/issue201/whispercpp'
        self.source.mkdir(parents=True)
        for name in ['CMakeLists.txt', 'adapter.cpp', 'myrelith-token-budget.h']:
            (self.source / name).write_text('corrected' if name == 'CMakeLists.txt' else name)
            (self.m.RECIPE / name).write_text('original' if name == 'CMakeLists.txt' else name)
        (self.m.LOGS / 'build-attempt.json').write_text('original marker')
        (self.m.LOGS / 'build-result.json').write_text('original failure')
        self.calls = []
        self.m.verify_link_settings_retry_inputs = lambda: dict(recipeSha256=self.m.sha(self.source / 'CMakeLists.txt'),
            adapterSha256=self.m.sha(self.source / 'adapter.cpp'), tokenHelperSha256=self.m.sha(self.source / 'myrelith-token-budget.h'))

        def run(label, command, seconds, env):
            self.assertTrue((self.m.LOGS / 'link-settings-attempt.json').exists())
            self.assertEqual((self.m.BUILD / 'recipe-link-settings/CMakeLists.txt').read_text(), 'corrected')
            self.assertEqual(env['EMCC_CORES'], '1')
            self.assertEqual(env['BINARYEN_CORES'], '1')
            self.assertIn('--require=', env['NODE_OPTIONS'])
            self.calls.append((label, list(map(str, command)), seconds))
        self.m.run = run

    def test_separate_paths_marker_before_tools_and_same_bounded_profile(self):
        self.m.resume_link_settings_build()
        self.assertEqual([c[0] for c in self.calls], ['link-settings-configure', 'link-settings-compile-link'])
        self.assertEqual([c[2] for c in self.calls], [180, 600])
        self.assertIn(str(self.m.BUILD / 'output-link-settings'), self.calls[0][1])
        self.assertEqual(self.calls[1][1][-3:], ['--parallel', '2', '--verbose'])
        self.assertTrue(any(c.startswith('-DCMAKE_CROSSCOMPILING_EMULATOR=') for c in self.calls[0][1]))
        self.assertEqual((self.m.RECIPE / 'CMakeLists.txt').read_text(), 'original')
        self.assertEqual((self.m.LOGS / 'build-attempt.json').read_text(), 'original marker')
        self.assertEqual((self.m.LOGS / 'build-result.json').read_text(), 'original failure')
        result = json.loads((self.m.LOGS / 'link-settings-result.json').read_text())
        self.assertFalse(result['runtimeExecuted'])
        self.assertFalse(result['generatedArtifactQualified'])

    def test_success_cannot_be_repeated(self):
        self.m.resume_link_settings_build()
        with self.assertRaisesRegex(RuntimeError, 'no implicit retry'):
            self.m.resume_link_settings_build()
        self.assertEqual(len(self.calls), 2)

    def test_failed_configure_consumes_attempt_without_compile_or_retry(self):
        def fail(*args):
            self.calls.append(args)
            raise RuntimeError('test configure failure')
        self.m.run = fail
        with self.assertRaisesRegex(RuntimeError, 'test configure failure'):
            self.m.resume_link_settings_build()
        with self.assertRaisesRegex(RuntimeError, 'no implicit retry'):
            self.m.resume_link_settings_build()
        self.assertEqual(len(self.calls), 1)
        result = json.loads((self.m.LOGS / 'link-settings-result.json').read_text())
        self.assertEqual(result['status'], 'failed-closed-no-retry')
        self.assertFalse(result['runtimeExecuted'])

    def test_source_drift_during_staging_stops_before_tools(self):
        self.m.verify_link_settings_retry_inputs = lambda: dict(recipeSha256='wrong')
        with self.assertRaisesRegex(RuntimeError, 'changed during staging'):
            self.m.resume_link_settings_build()
        self.assertEqual(self.calls, [])
        self.assertTrue((self.m.LOGS / 'link-settings-attempt.json').exists())

    def test_failed_verification_does_not_stage_or_consume_attempt(self):
        def fail():
            raise RuntimeError('test input drift')
        self.m.verify_link_settings_retry_inputs = fail
        with self.assertRaisesRegex(RuntimeError, 'test input drift'):
            self.m.resume_link_settings_build()
        self.assertEqual(self.calls, [])
        self.assertFalse((self.m.BUILD / 'recipe-link-settings').exists())
        self.assertFalse((self.m.LOGS / 'link-settings-attempt.json').exists())

    def test_changed_checkpoint_rejected_by_real_verifier(self):
        m = driver()
        m.ROOT = self.m.ROOT
        folder = m.ROOT / 'docs/evidence/issue201/whispercpp-link-settings'
        folder.mkdir(parents=True)
        (folder / 'checkpoint.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'Unreviewed linker-setting checkpoint'):
            m.verify_link_settings_retry_inputs()


if __name__ == '__main__':
    unittest.main(verbosity=2)
