"""Production orchestrator with fake cargo; never loads Sherpa or builds Rust."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


class TauriTestOrchestrationTests(unittest.TestCase):
    def run_gate(self, opt_in='1', broken='', output='', status=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'apps/desktop/src-tauri').mkdir(parents=True)
            for name in ['verify-tauri-tests.sh', 'build-resource-env.sh']:
                shutil.copy2(SCRIPTS / name, root / 'scripts' / name)
            cargo = root / 'cargo'
            cargo.write_text('''#!/usr/bin/env python3
import json, os, sys
phase = 'real' if '--ignored' in sys.argv else 'unit'
with open(os.environ['CALLS'], 'a') as stream:
    stream.write(json.dumps({'args':sys.argv[1:], 'phase':phase,
        'library':os.environ.get('ASTRA_SHERPA_LIB_DIR'),
        'model':os.environ.get('ASTRA_STT_MODEL_DIR'),
        'jobs':os.environ.get('CARGO_BUILD_JOBS')})+'\\n')
if phase == os.environ['BROKEN']:
    print(os.environ['OUTPUT']); sys.exit(int(os.environ['STATUS']))
if phase == 'unit':
    # A real ordinary unit process mutates/removes these variables. The parent
    # wrapper must still pass the original private asset paths to real tests.
    os.environ.pop('ASTRA_SHERPA_LIB_DIR', None)
    os.environ.pop('ASTRA_STT_MODEL_DIR', None)
    ignored = 0 if '--skip' in sys.argv else 3
    print(f'test result: ok. 67 passed; 0 failed; {ignored} ignored; 0 measured; 0 filtered out;')
else:
    print('[real] latency budget -> OVER')
    print('test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 67 filtered out;')
''')
            cargo.chmod(0o755)
            calls = root / 'calls'
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       ASTRA_VERIFY_SHERPA_STT=opt_in, CALLS=str(calls), BROKEN=broken,
                       OUTPUT=output, STATUS=str(status), CARGO_BUILD_JOBS='1',
                       ASTRA_SHERPA_LIB_DIR='/private/fixture lib',
                       ASTRA_STT_MODEL_DIR='/private/fixture models')
            result = subprocess.run(['/bin/bash', str(root / 'scripts/verify-tauri-tests.sh')],
                                    env=env, capture_output=True, text=True, timeout=10)
            return result, [json.loads(x) for x in calls.read_text().splitlines()] if calls.exists() else []

    def test_opt_in_separates_real_cases_and_preserves_assets_and_latency_observation(self):
        result, calls = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([x['phase'] for x in calls], ['unit', 'real'])
        self.assertEqual(calls[0]['args'].count('--skip'), 3)
        self.assertEqual(calls[1]['args'], ['test', '--lib', 'stt::recognizer::real', '--',
                                          '--ignored', '--nocapture', '--test-threads=1'])
        self.assertEqual(calls[1]['library'], '/private/fixture lib')
        self.assertEqual(calls[1]['model'], '/private/fixture models')
        self.assertEqual(calls[1]['jobs'], '1')
        self.assertIn('latency budget -> OVER', result.stdout)
        self.assertIn('TAURI_TESTS_OK', result.stdout)

    def test_default_never_runs_real_models_and_remains_partial(self):
        result, calls = self.run_gate(opt_in='0')
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['args'], ['test', '--quiet'])
        self.assertIn('3 ignored', result.stdout)
        self.assertIn('NOT_RUN: tauri_real_stt', result.stdout)
        self.assertNotIn('TAURI_TESTS_OK', result.stdout)

    def test_real_missing_assets_crash_wrong_count_or_summary_cannot_pass(self):
        for output, status in [
            ('test result: ok. 3 passed; 0 failed; 0 ignored;', 9),
            ('test result: FAILED. 0 passed; 3 failed; 0 ignored;', 1),
            ('test result: ok. 0 passed; 0 failed; 0 ignored;', 0),
            ('test result: ok. 2 passed; 0 failed; 0 ignored;', 0),
            ('test result: ok. 4 passed; 0 failed; 0 ignored;', 0),
            ('no matching tests', 0),
        ]:
            with self.subTest(output=output, status=status):
                result, _ = self.run_gate(broken='real', output=output, status=status)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertNotIn('TAURI_TESTS_OK', result.stdout)

    def test_unrelated_ignored_test_is_not_resolved_by_real_stt_success(self):
        result, _ = self.run_gate(broken='unit', output='test result: ok. 67 passed; 0 failed; 1 ignored;')
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('NOT_RUN: tauri_unit', result.stdout)

    def test_unit_failure_wins_over_missing_opt_in(self):
        result, _ = self.run_gate(opt_in='0', broken='unit',
                                  output='test result: FAILED. 66 passed; 1 failed; 3 ignored;', status=1)
        self.assertEqual(result.returncode, 1)

    def test_invalid_opt_in_starts_nothing(self):
        result, calls = self.run_gate(opt_in='yes')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
