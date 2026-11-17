"""Run the production suite orchestrator with a fake Swift CLI, never a model."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


class SwiftTestOrchestrationTests(unittest.TestCase):
    def run_gate(self, external='1', broken='none', output='Executed 1 test, with 0 failures', status='0'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'apps/genie-macos').mkdir(parents=True)
            for name in ['verify-swift-tests.sh', 'build-resource-env.sh']:
                shutil.copy2(SCRIPTS / name, root / 'scripts' / name)
            cli = root / 'swift'
            cli.write_text('''#!/bin/bash
printf '%s|shutdown=%s|external=%s\\n' "$*" "$ASTRA_VERIFY_CODEX_SHUTDOWN" "$ASTRA_VERIFY_CODEX_TRANSLATION" >> "$CALLS"
phase=unit
[[ "$*" == *--filter*Shutdown* ]] && phase=shutdown
[[ "$*" == *--filter*RealCodex* ]] && phase=external
if [[ "$phase" == "$BROKEN" ]]; then printf '%s\\n' "$OUTPUT"; exit "$STATUS"; fi
echo 'Executed 1 test, with 0 failures'
''')
            cli.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       CALLS=str(root / 'calls'), BROKEN=broken, OUTPUT=output, STATUS=status,
                       ASTRA_VERIFY_CODEX_TRANSLATION=external, ASTRA_VERIFY_CODEX_SHUTDOWN='1')
            result = subprocess.run(['/bin/bash', str(root / 'scripts/verify-swift-tests.sh')],
                                    env=env, capture_output=True, text=True, timeout=10)
            return result, (root / 'calls').read_text().splitlines() if (root / 'calls').exists() else []

    def test_three_separate_processes_keep_shutdown_out_of_other_tests(self):
        result, calls = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 3)
        self.assertIn('--skip CodexTranslationProcessTests/testApplicationShutdown', calls[0])
        self.assertTrue(calls[0].endswith('shutdown=0|external=0'))
        self.assertIn('--skip-build --filter CodexTranslationProcessTests/testApplicationShutdown', calls[1])
        self.assertTrue(calls[1].endswith('shutdown=1|external=0'))
        self.assertIn('--skip-build --filter CodexTranslationTests/testRealCodex', calls[2])
        self.assertTrue(calls[2].endswith('shutdown=0|external=1'))
        self.assertIn('SWIFT_TESTS_OK', result.stdout)

    def test_omitted_external_fixture_is_partial_and_never_invoked(self):
        result, calls = self.run_gate(external='0')
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(len(calls), 2)
        self.assertIn('NOT_RUN: macOS_swift_external_translation', result.stdout)
        self.assertNotIn('SWIFT_TESTS_OK', result.stdout)

    def test_no_match_wrong_filter_crash_skip_and_assertion_failure_are_not_green(self):
        for phase in ['shutdown', 'external']:
            for output, status, expected in [
                ('Executed 0 tests, with 0 failures', '0', 1),
                ('Executed 2 tests, with 0 failures', '0', 1),
                ('Executed 1 test, with 0 failures', '9', 1),
                ('Executed 1 test, with 1 failure', '0', 1),
                ('Executed 1 test, with 1 test skipped and 0 failures', '0', 2),
                ('no tests ran', '0', 1),
            ]:
                with self.subTest(phase=phase, output=output, status=status):
                    result, _ = self.run_gate(broken=phase, output=output, status=status)
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                    self.assertNotIn('SWIFT_TESTS_OK', result.stdout)

    def test_unit_failure_wins_over_missing_external(self):
        result, _ = self.run_gate(external='0', broken='unit', output='Executed 4 tests, with 1 failure', status='1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('FAIL: macOS_swift_unit', result.stdout)

    def test_invalid_opt_in_does_not_launch_any_process(self):
        result, calls = self.run_gate(external='yes')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
